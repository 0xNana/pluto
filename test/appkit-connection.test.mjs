import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectAppKit } from '../packages/web/appkit-connection.mts';
import { appKitSettings } from '../packages/web/appkit-settings.mts';

function modalFixture() {
  const listeners = { account: new Set(), providers: new Set(), state: new Set() };
  let account = { isConnected: false }, provider;
  const modal = {
    opens: 0, closes: 0, view: undefined,
    getAccount: () => account, getWalletProvider: () => provider,
    async open(options) { this.opens++; this.view = options.view; for (const fn of listeners.state) fn({ open: true }); },
    async close() { this.closes++; },
    subscribeAccount(fn) { listeners.account.add(fn); return () => listeners.account.delete(fn); },
    subscribeProviders(fn) { listeners.providers.add(fn); return () => listeners.providers.delete(fn); },
    subscribeState(fn) { listeners.state.add(fn); return () => listeners.state.delete(fn); },
  };
  return { modal, listeners,
    accountReady() { account = { isConnected: true }; for (const fn of listeners.account) fn(account); },
    connecting() { account = { isConnected: false, status: 'connecting' }; for (const fn of listeners.account) fn(account); },
    connected(value) { account = { isConnected: true }; for (const fn of listeners.account) fn(account); provider = value; for (const fn of listeners.providers) fn({ eip155: value }); },
    disconnected() { account = { isConnected: false }; for (const fn of listeners.account) fn(account); },
    cancel() { for (const fn of listeners.state) fn({ open: false }); },
  };
}
const provider = { request: async () => [], on() {}, removeListener() {} };
const clean = fixture => { for (const listeners of Object.values(fixture.listeners)) assert.equal(listeners.size, 0); };

test('AppKit bridge waits for account and provider, closes the modal and releases subscriptions', async () => {
  const fixture = modalFixture(), pending = connectAppKit(fixture.modal, new AbortController().signal);
  await Promise.resolve(); fixture.connected(provider);
  assert.equal(await pending, provider); assert.equal(fixture.modal.opens, 1); assert.equal(fixture.modal.closes, 1); clean(fixture);
});
test('AppKit account controls preserve a connected wallet on close and report modal disconnect', async () => {
  const { manageAppKitAccount } = await import('../packages/web/appkit-connection.mts');
  for (const disconnect of [false, true]) {
    const fixture = modalFixture(); fixture.connected(provider);
    const pending = manageAppKitAccount(fixture.modal, new AbortController().signal);
    await Promise.resolve(); assert.equal(fixture.modal.view, 'Account');
    if (disconnect) fixture.disconnected(); else fixture.cancel();
    assert.equal(await pending, !disconnect); clean(fixture); assert.equal(fixture.modal.closes, 1);
  }
});
test('AppKit account controls release listeners and redact errors on disposal or failed opening', async () => {
  const { manageAppKitAccount } = await import('../packages/web/appkit-connection.mts');
  const fixture = modalFixture(); fixture.connected(provider);
  const controller = new AbortController(), pending = manageAppKitAccount(fixture.modal, controller.signal);
  const rejected = assert.rejects(pending, /closed|timed out/); controller.abort(); await rejected; clean(fixture);
  const failed = modalFixture(); failed.connected(provider);
  failed.modal.open = async () => { throw new Error('private transport detail'); };
  await assert.rejects(manageAppKitAccount(failed.modal, new AbortController().signal), /account controls could not open/); clean(failed);
});
test('AppKit cancellation and screen disposal cannot establish a late connection', async () => {
  for (const abort of [false, true]) {
    const fixture = modalFixture(), controller = new AbortController(), pending = connectAppKit(fixture.modal, controller.signal);
    const rejected = assert.rejects(pending, /closed|cancelled|timed out/);
    await Promise.resolve(); if (abort) controller.abort(); else fixture.cancel();
    await rejected; fixture.connected(provider); clean(fixture);
  }
});
test('AppKit reuses a connected provider and cleans up when modal opening fails', async () => {
  const fixture = modalFixture(); fixture.connected(provider);
  assert.equal(await connectAppKit(fixture.modal, new AbortController().signal), provider);
  assert.equal(fixture.modal.opens, 0); clean(fixture);
  const failed = modalFixture(); failed.modal.open = async () => { throw new Error('synthetic transport failure'); };
  await assert.rejects(connectAppKit(failed.modal, new AbortController().signal), /could not open/); clean(failed);
});
test('AppKit configuration keeps example project local, metadata scoped and optional services disabled', () => {
  const local = appKitSettings('http://localhost:3000');
  assert.equal(local.metadata.url, 'http://localhost:3000');
  assert.equal(local.features.analytics, false); assert.equal(local.features.email, false); assert.equal(local.features.socials, false);
  assert.equal(local.features.swaps, false); assert.equal(local.features.onramp, false); assert.equal(local.enableReconnect, false);
  assert.equal(local.basic, true); assert.equal(local.features.reownAuthentication, false); assert.equal(local.features.pay, false);
  assert.throws(() => appKitSettings('https://pluto.example'), /project ID/);
  assert.throws(() => appKitSettings('http://localhost.evil.example'), /project ID/);
  assert.throws(() => appKitSettings('https://pluto.example', local.projectId), /localhost/);
  assert.equal(appKitSettings('https://pluto.example', 'a'.repeat(32)).projectId, 'a'.repeat(32));
});

const extension = (id, extra = {}) => ({ id, type: 'ANNOUNCED', chain: 'eip155', info: { rdns: id }, ...extra });
test('Connect prefers detected MetaMask then Rabby through the SDK adapter, without opening the picker', async () => {
  for (const connectors of [
    [extension('io.rabby'), extension('io.metamask')],
    [extension('io.rabby')],
    [extension('injected', { type: 'INJECTED', info: undefined, provider: { ...provider, isMetaMask: true, isRabby: true } })],
  ]) {
    const fixture = modalFixture(), calls = [];
    const installed = { async ready() {}, getConnectors: () => connectors, async connect(connector) { calls.push(connector.id); fixture.connected(provider); } };
    assert.equal(await connectAppKit(fixture.modal, AbortSignal.timeout(100), installed), provider);
    assert.deepEqual(calls, [connectors.find(item => item.id === 'io.metamask')?.id ?? connectors[0].id]);
    assert.equal(fixture.modal.opens, 0); clean(fixture);
  }
});
test('Unrecognized, remote and non-EVM wallets keep the AppKit picker fallback', async () => {
  const fixture = modalFixture(); let calls = 0;
  const installed = { async ready() {}, getConnectors: () => [
    extension('unknown', { name: 'MetaMask' }), extension('io.metamask', { type: 'WALLET_CONNECT' }), extension('io.rabby', { chain: 'solana' }),
  ], async connect() { calls++; } };
  const pending = connectAppKit(fixture.modal, AbortSignal.timeout(100), installed);
  await new Promise(resolve => setImmediate(resolve)); fixture.connected(provider);
  assert.equal(await pending, provider); assert.equal(calls, 0); assert.equal(fixture.modal.opens, 1); clean(fixture);
});
test('Extension rejection is sanitized and never opens another wallet or the picker', async () => {
  const fixture = modalFixture(), calls = [];
  const installed = { async ready() {}, getConnectors: () => [extension('io.rabby'), extension('io.metamask')], async connect(connector) {
    calls.push(connector.id); throw new Error('private transport information', { cause: { code: 4001 } });
  } };
  await assert.rejects(connectAppKit(fixture.modal, AbortSignal.timeout(100), installed), /Wallet connection was declined/);
  assert.deepEqual(calls, ['io.metamask']); assert.equal(fixture.modal.opens, 0); clean(fixture);
});
test('A picker closing with a connected account waits for its delayed provider', async () => {
  const fixture = modalFixture(), pending = connectAppKit(fixture.modal, new AbortController().signal);
  void pending.catch(() => undefined); // Observe early rejection while exercising the delayed provider.
  fixture.accountReady(); fixture.cancel();
  await new Promise(resolve => setTimeout(resolve, 10)); fixture.connected(provider);
  assert.equal(await pending, provider); clean(fixture);
});
test('Closing a picker with an unconnected pending account cancels instead of authenticating later', async () => {
  const fixture = modalFixture(), pending = connectAppKit(fixture.modal, AbortSignal.timeout(100));
  const rejected = assert.rejects(pending, /Wallet picker was closed/);
  fixture.connecting(); fixture.cancel(); await rejected;
  fixture.connected(provider); clean(fixture);
});
test('SDK initialization respects disposal and reuse without prompting or exposing initialization errors', async () => {
  const fixture = modalFixture(), controller = new AbortController(); let complete, calls = 0;
  const installed = { ready: () => new Promise(resolve => { complete = resolve; }), getConnectors: () => [extension('io.metamask')], async connect() { calls++; } };
  const pending = connectAppKit(fixture.modal, controller.signal, installed);
  const rejected = assert.rejects(pending, /Wallet connection was cancelled/); controller.abort(); await rejected;
  complete(); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 0); assert.equal(fixture.modal.opens, 0); clean(fixture);
  fixture.connected(provider);
  assert.equal(await connectAppKit(fixture.modal, AbortSignal.timeout(100), installed), provider); assert.equal(calls, 0);
  const failed = modalFixture();
  await assert.rejects(connectAppKit(failed.modal, AbortSignal.timeout(100), { ...installed, async ready() { throw new Error('private configuration'); } }), /could not initialize/);
  clean(failed);
});
test('Connection timeout is distinct from picker closure and adapter failures are redacted', async t => {
  const deadline = new AbortController(); t.mock.method(AbortSignal, 'timeout', () => deadline.signal);
  const fixture = modalFixture(), pending = connectAppKit(fixture.modal, new AbortController().signal);
  const rejected = assert.rejects(pending, /Wallet connection timed out/); deadline.abort(); await rejected; clean(fixture);
  t.mock.restoreAll();
  for (const [error, message] of [[{ code: -32002 }, /request is already open/], [new Error('private transport details'), /could not be confirmed/]]) {
    const failed = modalFixture();
    await assert.rejects(connectAppKit(failed.modal, AbortSignal.timeout(100), {
      async ready() {}, getConnectors: () => [extension('io.metamask')], async connect() { throw error; },
    }), message);
    assert.equal(failed.modal.opens, 0); clean(failed);
  }
});
test('Account publication cannot complete a pending extension request or reconnect a disposed screen', async () => {
  for (const dispose of [false, true]) {
    const fixture = modalFixture(), controller = new AbortController(); let complete, resolved = false;
    const pending = connectAppKit(fixture.modal, controller.signal, {
      async ready() {}, getConnectors: () => [extension('io.metamask')],
      connect: () => new Promise(resolve => { complete = resolve; fixture.connected(provider); }),
    });
    void pending.then(() => { resolved = true; }, () => undefined);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(resolved, false);
    if (dispose) {
      const rejected = assert.rejects(pending, /cancelled/); controller.abort(); await rejected;
      complete(); await new Promise(resolve => setImmediate(resolve)); assert.equal(resolved, false);
    } else { complete(); assert.equal(await pending, provider); }
    clean(fixture); assert.equal(fixture.modal.opens, 0);
  }
});
test('Installed Wagmi adapter publishes extension account/provider and disconnects its connection', async () => {
  const { WagmiAdapter } = await import('@reown/appkit-adapter-wagmi');
  const { sepolia } = await import('@reown/appkit/networks');
  const address = '0x0000000000000000000000000000000000000001', requestedChains = [], changes = [];
  let disconnects = 0;
  const adapter = new WagmiAdapter({ networks: [sepolia], projectId: 'a'.repeat(32), ssr: true,
    // Synthetic transport; actual SDK adapter/config/watchers. No RPC or wallet.
    connectors: [() => ({ id: 'io.metamask', name: 'MetaMask', type: 'injected',
      async connect({ chainId }) { requestedChains.push(chainId); return { accounts: [address], chainId }; },
      async getProvider() { return provider; }, async getAccounts() { return [address]; },
      async getChainId() { return sepolia.id; }, async isAuthorized() { return false; }, async disconnect() { disconnects++; },
    })],
  });
  adapter.on('accountChanged', data => changes.push(data));
  adapter.construct({ namespace: 'eip155', projectId: 'a'.repeat(32), networks: [sepolia] });
  try {
    const result = await adapter.connect({ id: 'io.metamask', type: 'INJECTED', provider, chainId: sepolia.id });
    assert.deepEqual(requestedChains, [11155111]); assert.equal(result.provider, provider);
    assert.equal(changes.length, 1); assert.equal(changes[0].address, address);
    assert.equal(changes[0].chainId, 11155111); assert.equal(changes[0].connector.provider, provider);
    assert.equal(adapter.connections.length, 1);
  } finally { await adapter.disconnect({ id: 'io.metamask' }); }
  assert.equal(disconnects, 1); assert.equal(adapter.connections.length, 0);
});
