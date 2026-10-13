import { createWalletClient, custom, getAddress, type Hex } from 'viem';
import { sepolia } from 'viem/chains';

export interface WalletProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  removeListener(event: string, handler: (...args: unknown[]) => void): void;
}
export interface WalletState {
  wallet?: Hex; chainId?: number; sessionWallet?: Hex; expires?: number;
  authenticated: boolean; busy: boolean; message: string;
}
type Api = (path: string, body?: unknown) => Promise<unknown>;
// Client clocks may lag the server slightly; server expiry checks stay strict.
const clockSkewSecs = 30;
export class WalletAccessError extends Error {}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WalletAccessError('Wallet sign-in returned an invalid response. Try again.');
  return value as Record<string, unknown>;
};
function address(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/.test(value)) throw new WalletAccessError('The wallet did not provide a valid account. Unlock it and reconnect.');
  return getAddress(value);
}
function chain(value: unknown): number {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,12}$/.test(value)) throw new WalletAccessError('The wallet did not provide a valid network. Reconnect.');
  return Number(BigInt(value));
}
function hasErrorCode(error: unknown, code: number): boolean {
  let cause = error;
  for (let depth = 0; depth < 5 && cause && typeof cause === 'object'; depth++) {
    const value = cause as Record<string, unknown>;
    if (value.code === code) return true;
    cause = value.cause;
  }
  return false;
}
function safeError(error: unknown): WalletAccessError {
  if (error instanceof WalletAccessError) return error;
  let cause = error;
  for (let depth = 0; depth < 5 && cause && typeof cause === 'object'; depth++) {
    const value = cause as Record<string, unknown>;
    if (value.code === 4001) return new WalletAccessError('Wallet request declined. Nothing was signed in; try again when ready.');
    if (value.code === -32002) return new WalletAccessError('A wallet request is already open. Finish it in your wallet, then try again.');
    cause = value.cause;
  }
  return new WalletAccessError('Wallet sign-in could not be confirmed. Check your wallet and the portal connection, then try again.');
}

// The server cookie is authoritative. Connection alone never authenticates a user.
// Session mutations are serialized so a late sign-in cannot undo account-change logout.
export class WalletAccess {
  state: WalletState = { authenticated: false, busy: false, message: 'Wallet connection is optional. Sign in for protocol staff access.' };
  private options: { origin: string; chainId: number; api: Api; onChange(state: WalletState): void; onIdentityChange(): void; now?: () => number; portalAvailable?: () => boolean };
  private provider?: WalletProvider;
  private listeners: [string, (...args: unknown[]) => void][] = [];
  private pending: Promise<void> = Promise.resolve();
  private generation = 0;
  private switchingNetwork?: number;
  private lifecycle = new AbortController();
  private expiryTimer?: ReturnType<typeof setTimeout>;
  constructor(options: WalletAccess['options']) { this.options = options; }
  canAuthenticate() { return this.options.portalAvailable?.() ?? true; }
  private now() { return this.options.now?.() ?? Math.floor(Date.now() / 1000); }
  private publish() { if (!this.lifecycle.signal.aborted) this.options.onChange({ ...this.state }); }
  private clearIdentity() {
    clearTimeout(this.expiryTimer); this.expiryTimer = undefined;
    this.state.authenticated = false; this.state.sessionWallet = undefined; this.state.expires = undefined;
    if (!this.lifecycle.signal.aborted) this.options.onIdentityChange();
  }
  private check(generation: number) {
    if (this.lifecycle.signal.aborted || generation !== this.generation) throw new WalletAccessError('Wallet or network changed. Reconnect and sign in again.');
  }
  private async bounded<T>(work: Promise<T>): Promise<T> {
    const signal = AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(60_000)]);
    signal.throwIfAborted();
    let cancel: () => void = () => undefined;
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => {
        cancel = () => reject(new WalletAccessError('Wallet request timed out or was closed. Finish any open request in your wallet before retrying.'));
        signal.addEventListener('abort', cancel, { once: true });
      })]);
    } finally { signal.removeEventListener('abort', cancel); }
  }
  private run(job: (generation: number) => Promise<void>): Promise<void> {
    const task = this.pending.then(async () => {
      this.lifecycle.signal.throwIfAborted();
      this.state.busy = true; this.publish();
      try { await job(this.generation); }
      catch (error) { const safe = safeError(error); this.state.message = safe.message; throw safe; }
      finally { this.state.busy = false; this.publish(); }
    });
    // Keep the queue usable after a failed attempt; the caller still receives task's error.
    this.pending = task.then(() => undefined, () => undefined);
    return task;
  }
  idle() { return this.pending; }
  private async revoke() { if (this.canAuthenticate()) await this.options.api('/api/auth/logout', {}); }
  private detach() {
    for (const [event, handler] of this.listeners) this.provider?.removeListener(event, handler);
    this.listeners = []; this.provider = undefined;
  }
  private changed(message: string) {
    this.generation++; this.clearIdentity(); this.state.message = message; this.publish();
    void this.run(async () => { await this.revoke(); }).catch(() => {
      if (!this.lifecycle.signal.aborted) { this.state.message = 'Wallet changed. Server sign-out was not confirmed; reconnect before accessing protocol records.'; this.publish(); }
    });
  }
  private attach(provider: WalletProvider) {
    this.provider = provider;
    const accounts = (value: unknown) => {
      let next: Hex | undefined;
      try { next = Array.isArray(value) && value.length ? address(value[0]) : undefined; }
      catch { next = undefined; }
      if (next === this.state.wallet) return;
      this.state.wallet = next; this.changed('Wallet account changed. Sign in again for protocol access.');
    };
    const network = (value: unknown) => {
      let next: number | undefined;
      try { next = chain(value); } catch { next = undefined; }
      if (next === this.state.chainId) return;
      this.state.chainId = next;
      // The expected switch belongs to the current connection attempt. Other
      // network/account changes still invalidate that attempt and any session.
      if (this.switchingNetwork !== undefined && next === this.switchingNetwork) { this.publish(); return; }
      this.changed('Wallet network changed. Use Sepolia and sign in again.');
    };
    const disconnected = () => { this.state.wallet = undefined; this.state.chainId = undefined; this.changed('Wallet disconnected. Reconnect to sign in.'); this.detach(); };
    this.listeners = [['accountsChanged', accounts], ['chainChanged', network], ['disconnect', disconnected]];
    for (const [event, handler] of this.listeners) provider.on(event, handler);
  }
  private acceptSession(value: unknown) {
    const session = record(value);
    const invalidate = () => { if (this.state.authenticated) this.clearIdentity(); };
    if (session.authenticated === false) { invalidate(); return; }
    if (session.authenticated !== true || session.chainId !== this.options.chainId || (this.provider && this.state.chainId !== this.options.chainId) || !Number.isSafeInteger(session.expires)
      || Number(session.expires) <= this.now() || Number(session.expires) > this.now() + 3600 + clockSkewSecs) { invalidate(); return; }
    const wallet = address(session.wallet);
    if (this.state.wallet && this.state.wallet !== wallet) { invalidate(); return; }
    if (this.state.sessionWallet !== wallet) this.clearIdentity();
    clearTimeout(this.expiryTimer);
    this.state.sessionWallet = wallet; this.state.expires = Number(session.expires); this.state.authenticated = true;
    this.expiryTimer = setTimeout(() => {
      this.clearIdentity(); this.state.message = 'Portal session expired. Sign in again to access protocol records.'; this.publish();
    }, Math.min(3600, this.state.expires - this.now()) * 1000);
  }
  restore() {
    return this.run(async generation => {
      if (!this.canAuthenticate()) {
        if (this.state.authenticated) this.clearIdentity();
        this.state.message = 'Wallet connection is available. Sign-in requires the configured HTTPS portal.';
        return;
      }
      try {
        const session = await this.options.api('/api/auth/session');
        this.check(generation); this.acceptSession(session);
      }
      catch (error) { this.clearIdentity(); throw error; }
      this.state.message = this.state.authenticated ? 'Portal session restored. Protocol permissions are checked on every request.' : 'Connect a wallet, then sign in for protocol staff access.';
    });
  }
  connect(provider: WalletProvider, switchNetwork?: () => Promise<void>) {
    return this.run(async generation => {
      const revokeNeeded = this.state.authenticated;
      this.detach(); this.clearIdentity(); this.state.wallet = undefined; this.state.chainId = undefined;
      if (revokeNeeded) await this.revoke(); this.check(generation);
      const accounts = await this.bounded(provider.request({ method: 'eth_requestAccounts' })); this.check(generation);
      if (!Array.isArray(accounts) || !accounts.length) throw new WalletAccessError('No wallet account selected. Unlock your wallet and try again.');
      const wallet = address(accounts[0]), chainId = chain(await this.bounded(provider.request({ method: 'eth_chainId' }))); this.check(generation);
      this.state.wallet = wallet; this.state.chainId = chainId; this.attach(provider);
      await this.current(generation);
      if (chainId !== this.options.chainId) {
        this.switchingNetwork = this.options.chainId;
        this.state.message = 'Switching to Sepolia. Confirm the network request in your wallet.'; this.publish();
        try {
          const client = createWalletClient({ transport: custom(provider, { retryCount: 0 }) });
          const switchDirect = async () => {
            try { await this.bounded(client.switchChain({ id: this.options.chainId })); }
            catch (error) {
              this.check(generation);
              if (!hasErrorCode(error, 4902) || this.options.chainId !== sepolia.id) throw error;
              await this.bounded(client.addChain({ chain: sepolia })); this.check(generation);
              await this.bounded(client.switchChain({ id: this.options.chainId }));
            }
          };
          if (switchNetwork) await this.bounded(switchNetwork()); else await switchDirect();
          this.check(generation);
          // Some providers omit chainChanged; a success response alone is insufficient.
          const confirmed = chain(await this.bounded(provider.request({ method: 'eth_chainId' }))); this.check(generation);
          this.state.chainId = confirmed;
          await this.current(generation);
          if (confirmed !== this.options.chainId) throw new WalletAccessError('Sepolia was not confirmed. Choose Reconnect to retry, or switch manually in your wallet.');
        } catch (error) {
          this.check(generation);
          if (error instanceof WalletAccessError) throw error;
          throw new WalletAccessError(`Sepolia network switch was not confirmed. ${safeError(error).message} Choose Reconnect to retry, or switch manually in your wallet.`);
        } finally { this.switchingNetwork = undefined; }
      }
      this.state.message = !this.canAuthenticate() ? 'Wallet connected. Sign-in requires the configured HTTPS portal.'
        : 'Wallet connected on Sepolia. Sign a portal message to sign in; no transaction is requested.';
    });
  }
  private async current(generation: number) {
    if (!this.provider || !this.state.wallet) throw new WalletAccessError('Connect a browser wallet before signing in.');
    const accounts = await this.bounded(this.provider.request({ method: 'eth_accounts' })); this.check(generation);
    const network = chain(await this.bounded(this.provider.request({ method: 'eth_chainId' }))); this.check(generation);
    if (!Array.isArray(accounts) || !accounts.length || address(accounts[0]) !== this.state.wallet || network !== this.state.chainId) {
      this.state.wallet = undefined; this.state.chainId = undefined; this.changed('Wallet changed. Reconnect before signing in.');
      throw new WalletAccessError('Wallet changed. Reconnect before signing in.');
    }
  }
  signIn() {
    return this.run(async generation => {
      if (!this.canAuthenticate()) throw new WalletAccessError('Sign-in requires the configured HTTPS portal. Portal configuration is unavailable here.');
      await this.current(generation);
      if (this.state.chainId !== this.options.chainId) throw new WalletAccessError('Switch to Sepolia in your wallet, then sign in again.');
      this.clearIdentity(); await this.revoke(); this.check(generation);
      const wallet = this.state.wallet!, challenge = record(await this.options.api('/api/auth/challenges', { wallet })); this.check(generation);
      if (typeof challenge.id !== 'string' || !/^[a-f0-9]{64}$/.test(challenge.id) || typeof challenge.message !== 'string') throw new WalletAccessError('Invalid portal challenge. No message was signed.');
      const expiry = /^Expires: ([0-9]+)$/m.exec(challenge.message)?.[1];
      const expected = `Pluto protocol portal\nOrigin: ${this.options.origin}\nChain: ${this.options.chainId}\nWallet: ${wallet}\nNonce: ${challenge.id}\nExpires: ${expiry}\nThis authenticates portal access only. No transaction or disclosure changes.`;
      if (!expiry || !Number.isSafeInteger(Number(expiry)) || Number(expiry) <= this.now() || Number(expiry) > this.now() + 300 + clockSkewSecs || expected !== challenge.message) throw new WalletAccessError('Portal challenge does not match this site, account, network or expiry. No message was signed.');
      const client = createWalletClient({ transport: custom(this.provider!, { retryCount: 0 }) });
      const signature = await this.bounded(client.signMessage({ account: wallet, message: challenge.message })); this.check(generation);
      await this.current(generation);
      await this.options.api('/api/auth/sessions', { id: challenge.id, signature }); this.check(generation);
      const session = await this.options.api('/api/auth/session'); this.check(generation); this.acceptSession(session);
      if (!this.state.authenticated || this.state.sessionWallet !== wallet) { this.clearIdentity(); await this.revoke(); throw new WalletAccessError('Portal session could not be verified. Sign in again.'); }
      this.state.message = 'Signed in. Protocol membership and ownership are checked separately; signing in grants no automatic protocol access.';
    });
  }
  signOut() {
    this.generation++; this.clearIdentity(); this.publish();
    return this.run(async () => { await this.revoke(); this.state.message = 'Signed out of the portal. Your wallet remains connected.'; });
  }
  disconnect() {
    this.generation++; this.detach(); this.clearIdentity(); this.state.wallet = undefined; this.state.chainId = undefined; this.publish();
    return this.run(async () => { await this.revoke(); this.state.message = this.canAuthenticate()
      ? 'Wallet disconnected from Pluto and portal signed out. Browser wallet permissions can be revoked in your wallet.'
      : 'Wallet disconnected from this interface. Browser wallet permissions can be revoked in your wallet.'; });
  }
  dispose() { this.generation++; this.detach(); clearTimeout(this.expiryTimer); this.lifecycle.abort(); this.state = { authenticated: false, busy: false, message: '' }; }
}
