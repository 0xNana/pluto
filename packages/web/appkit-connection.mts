import { isWalletProvider } from './wallet-discovery.mts';
import { WalletAccessError, type WalletProvider } from './wallet-access.mts';

export interface WalletConnector {
  connect(signal: AbortSignal): Promise<WalletProvider>;
  switchNetwork?(): Promise<void>;
  manageAccount?(signal: AbortSignal): Promise<boolean>;
  disconnect(): Promise<void>;
}
interface Modal {
  getAccount(namespace: 'eip155'): { isConnected: boolean } | undefined;
  getWalletProvider(): unknown;
  open(options: { view: 'Connect' | 'Account'; namespace: 'eip155' }): Promise<unknown>;
  close(): Promise<void>;
  subscribeAccount(callback: () => void, namespace: 'eip155'): () => void;
  subscribeProviders(callback: () => void): () => void;
  subscribeState(callback: (state: { open: boolean }) => void): () => void;
}
interface InstalledConnector {
  id: string;
  type: string;
  chain: string;
  info?: { rdns?: string };
  provider?: unknown;
}
interface InstalledWallets<TConnector extends InstalledConnector> {
  ready(): Promise<void>;
  getConnectors(): TConnector[];
  connect(connector: TConnector): Promise<unknown>;
}
// Routing hints only: accounts and the network are independently verified by
// WalletAccess. Display names never select a wallet. Rabby also sets isMetaMask.
function extensionRank(connector: InstalledConnector): number {
  if (connector.chain !== 'eip155' || !['ANNOUNCED', 'INJECTED'].includes(connector.type)) return 0;
  const id = connector.info?.rdns ?? connector.id;
  if (id === 'io.metamask') return 2;
  if (id === 'io.rabby') return 1;
  if (connector.type === 'INJECTED' && isWalletProvider(connector.provider)) {
    const provider = connector.provider as WalletProvider & { isMetaMask?: boolean; isRabby?: boolean };
    if (provider.isRabby === true) return 1;
    if (provider.isMetaMask === true) return 2;
  }
  return 0;
}
function extensionError(error: unknown): WalletAccessError {
  let cause = error;
  for (let depth = 0; depth < 5 && cause && typeof cause === 'object'; depth++) {
    const value = cause as Record<string, unknown>;
    if (value.code === 4001) return new WalletAccessError('Wallet connection was declined. Choose Connect wallet to try again.');
    if (value.code === -32002) return new WalletAccessError('A wallet request is already open. Finish it in your wallet, then try again.');
    cause = value.cause;
  }
  return new WalletAccessError('Wallet connection could not be confirmed. Open your wallet and try again.');
}
// Account controls live in AppKit. Report disconnection to the portal controller,
// including injected wallets that do not emit EIP-1193 disconnect on app logout.
export async function manageAppKitAccount(modal: Modal, lifecycle: AbortSignal): Promise<boolean> {
  const signal = AbortSignal.any([lifecycle, AbortSignal.timeout(120_000)]);
  const connected = () => !!modal.getAccount('eip155')?.isConnected;
  if (signal.aborted) throw new WalletAccessError('Wallet account controls were closed or timed out. Try again.');
  if (!connected()) return false;
  const subscriptions: (() => void)[] = [];
  let onAbort: () => void = () => undefined;
  try {
    return await new Promise<boolean>((resolve, reject) => {
      let seenOpen = false, settled = false;
      const finish = (value: boolean) => { if (!settled) { settled = true; resolve(value); } };
      onAbort = () => {
        if (!settled) { settled = true; reject(new WalletAccessError('Wallet account controls were closed or timed out. Try again.')); }
      };
      signal.addEventListener('abort', onAbort, { once: true });
      subscriptions.push(modal.subscribeAccount(() => { if (!connected()) finish(false); }, 'eip155'), modal.subscribeState(state => {
        if (state.open) seenOpen = true;
        else if (seenOpen) finish(connected());
      }));
      if (signal.aborted) { onAbort(); return; }
      void modal.open({ view: 'Account', namespace: 'eip155' }).catch(() => {
        if (!settled) { settled = true; reject(new WalletAccessError('Wallet account controls could not open. Try again.')); }
      });
    });
  } finally {
    signal.removeEventListener('abort', onAbort);
    for (const unsubscribe of subscriptions) unsubscribe();
    await modal.close();
  }
}
// AppKit supplies a transport; WalletAccess still verifies the account, network
// and portal signature. Closing a picker must never leave a pending UI action.
export async function connectAppKit<TConnector extends InstalledConnector>(modal: Modal, lifecycle: AbortSignal, installed?: InstalledWallets<TConnector>): Promise<WalletProvider> {
  const timeout = AbortSignal.timeout(120_000), signal = AbortSignal.any([lifecycle, timeout]);
  const abortError = () => new WalletAccessError(timeout.aborted
    ? 'Wallet connection timed out. Open your wallet and try again.' : 'Wallet connection was cancelled. Choose Connect wallet to try again.');
  if (signal.aborted) throw abortError();
  const connected = () => modal.getAccount('eip155')?.isConnected && isWalletProvider(modal.getWalletProvider());
  if (connected()) return modal.getWalletProvider() as WalletProvider;
  const subscriptions: (() => void)[] = [];
  let onAbort: () => void = () => undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<WalletProvider>((resolve, reject) => {
      let settled = false, seenOpen = false, directPending = false;
      const fail = (error: WalletAccessError) => { if (!settled) { settled = true; reject(error); } };
      const check = () => {
        if (!settled && !directPending && !signal.aborted && connected()) { settled = true; resolve(modal.getWalletProvider() as WalletProvider); }
      };
      onAbort = () => fail(abortError()); signal.addEventListener('abort', onAbort, { once: true });
      subscriptions.push(modal.subscribeAccount(check, 'eip155'), modal.subscribeProviders(check), modal.subscribeState(state => {
        if (state.open) { seenOpen = true; clearTimeout(closeTimer); }
        else if (seenOpen) { check(); closeTimer = setTimeout(() => {
          check();
          const account = modal.getAccount('eip155');
          // AppKit may close before it publishes the connected provider.
          if (!account?.isConnected) fail(new WalletAccessError('Wallet picker was closed. Choose Connect wallet to try again.'));
        }, 0); }
      }));
      if (signal.aborted) { onAbort(); return; }
      const start = async () => {
        if (installed) {
          try { await installed.ready(); }
          catch { fail(new WalletAccessError('Wallet connection could not initialize. Check your connection and try again.')); return; }
          if (settled || signal.aborted) return;
          check(); if (settled) return;
          const preferred = installed.getConnectors().filter(connector => extensionRank(connector) > 0)
            .sort((left, right) => extensionRank(right) - extensionRank(left))[0];
          if (preferred) {
            directPending = true;
            try { await installed.connect(preferred); directPending = false; check(); }
            catch (error) { fail(extensionError(error)); }
            return;
          }
        }
        if (settled || signal.aborted) return;
        try { await modal.open({ view: 'Connect', namespace: 'eip155' }); check(); }
        catch { fail(new WalletAccessError('Wallet picker could not open. Check your connection and Reown project configuration.')); }
      };
      void start().catch(() => fail(new WalletAccessError('Wallet connection could not initialize. Check your connection and try again.')));
    });
  } finally {
    clearTimeout(closeTimer); signal.removeEventListener('abort', onAbort);
    for (const unsubscribe of subscriptions) unsubscribe();
    await modal.close();
  }
}
