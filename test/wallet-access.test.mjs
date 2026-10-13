import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { hexToString } from 'viem';
import { WalletAccess } from '../packages/web/wallet-access.mts';

const alice = privateKeyToAccount('0x' + '12'.repeat(32));
const bob = privateKeyToAccount('0x' + '34'.repeat(32));
const origin = 'https://pluto.example', chainId = 11155111, now = 1000;
function fixture({ portalAvailable = true } = {}) {
  let active = alice, chain = '0xaa36a7', session = null, challengeOverride, sign, switchNetwork, browserNow = now;
  const calls = [], events = new Map();
  const provider = {
    async request({ method, params }) {
      calls.push(method);
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [active.address];
      if (method === 'eth_chainId') return chain;
      if (method === 'wallet_switchEthereumChain') {
        assert.deepEqual(params, [{ chainId: '0xaa36a7' }]);
        if (switchNetwork) return switchNetwork();
        chain = '0xaa36a7'; events.get('chainChanged')?.(chain); return null;
      }
      if (method === 'wallet_addEthereumChain') {
        assert.equal(params[0].chainId, '0xaa36a7'); assert.equal(params[0].chainName, 'Sepolia'); return null;
      }
      if (method === 'personal_sign') return sign ? sign(params) : active.signMessage({ message: hexToString(params[0]) });
      throw new Error('Unexpected wallet method');
    },
    on(event, handler) { events.set(event, handler); },
    removeListener(event, handler) { if (events.get(event) === handler) events.delete(event); },
  };
  let cleared = 0;
  const api = async (path, body) => {
    calls.push(path);
    if (path === '/api/auth/session') return session ?? { authenticated: false };
    if (path === '/api/auth/logout') { session = null; return { authenticated: false }; }
    if (path === '/api/auth/challenges') {
      const id = 'ab'.repeat(32);
      return challengeOverride ?? { id, message: `Pluto protocol portal\nOrigin: ${origin}\nChain: ${chainId}\nWallet: ${body.wallet}\nNonce: ${id}\nExpires: ${now + 300}\nThis authenticates portal access only. No transaction or disclosure changes.` };
    }
    if (path === '/api/auth/sessions') { session = { authenticated: true, wallet: active.address, chainId, expires: now + 3600 }; return { authenticated: true }; }
    throw new Error('Unexpected API path');
  };
  const access = new WalletAccess({ origin, chainId, api, portalAvailable: () => portalAvailable, now: () => browserNow, onChange() {}, onIdentityChange() { cleared++; } });
  return { access, provider, calls, events, get cleared() { return cleared; },
    setAccount(account) { active = account; events.get('accountsChanged')?.([account.address]); },
    setChain(value, notify = true) { chain = value; if (notify) events.get('chainChanged')?.(value); },
    setChallenge(value) { challengeOverride = value; }, setSign(value) { sign = value; },
    setSwitch(value) { switchNetwork = value; },
    setSession(value) { session = value; }, setNow(value) { browserNow = value; }, get session() { return session; } };
}

test('wallet connection stays separate from portal sign-in and uses no transaction methods', async () => {
  const f = fixture();
  try {
    await f.access.restore();
    assert.equal(f.calls.includes('eth_requestAccounts'), false);
    await f.access.connect(f.provider);
    assert.equal(f.access.state.wallet, alice.address);
    assert.equal(f.access.state.authenticated, false);
    assert.equal(f.calls.includes('personal_sign'), false);
    assert.equal(f.calls.includes('wallet_switchEthereumChain'), false);
    await f.access.signIn();
    assert.equal(f.access.state.authenticated, true);
    assert.equal(f.access.state.sessionWallet, alice.address);
    assert.equal(f.calls.filter(method => method === 'personal_sign').length, 1);
    assert.equal(f.calls.some(method => /sendTransaction|signTypedData|approve/.test(method)), false);
    await f.access.disconnect();
    assert.equal(f.access.state.wallet, undefined);
    assert.equal(f.session, null); assert.equal(f.events.size, 0);
  } finally { f.access.dispose(); }
});

test('wrong-chain wallets cannot request or sign an authentication challenge', async () => {
  const f = fixture();
  try {
    f.setChain('0x1'); f.setSwitch(() => { throw Object.assign(new Error('Declined'), { code: 4001 }); });
    await assert.rejects(f.access.connect(f.provider), /declined/);
    await assert.rejects(f.access.signIn(), /Sepolia/);
    assert.equal(f.calls.includes('/api/auth/challenges'), false);
    assert.equal(f.calls.includes('personal_sign'), false);
  } finally { f.access.dispose(); }
});

test('automatic network switching confirms Sepolia without signing or submitting a transaction', async () => {
  const f = fixture({ portalAvailable: false });
  try {
    f.setChain('0x1'); await f.access.connect(f.provider);
    assert.equal(f.access.state.wallet, alice.address); assert.equal(f.access.state.chainId, chainId);
    assert.equal(f.access.state.authenticated, false);
    assert.equal(f.calls.filter(call => call === 'wallet_switchEthereumChain').length, 1);
    assert.equal(f.calls.some(call => /personal_sign|sendTransaction|signTypedData|\/api\//.test(call)), false);
  } finally { f.access.dispose(); }
});

test('automatic network switching uses the AppKit adapter when supplied and verifies its provider', async () => {
  const f = fixture(); let switched = 0;
  try {
    f.setChain('0x1');
    await f.access.connect(f.provider, async () => { switched++; f.setChain('0xaa36a7'); });
    assert.equal(switched, 1); assert.equal(f.access.state.chainId, chainId);
    assert.equal(f.calls.includes('wallet_switchEthereumChain'), false);
    await f.access.connect(f.provider, async () => { switched++; }); assert.equal(switched, 1);
  } finally { f.access.dispose(); }
});

test('automatic network switching refusal is safe, sanitized and retryable', async () => {
  for (const code of [4001, -32002, 4200]) {
    const f = fixture();
    try {
      f.setChain('0x1'); f.setSwitch(() => { throw Object.assign(new Error('secret endpoint'), { code }); });
      await assert.rejects(f.access.connect(f.provider));
      assert.equal(f.access.state.chainId, 1); assert.equal(f.access.state.wallet, alice.address);
      assert.equal(f.access.state.busy, false); assert.doesNotMatch(f.access.state.message, /secret endpoint/);
      await assert.rejects(f.access.signIn(), /Sepolia/);
      assert.equal(f.calls.includes('/api/auth/challenges'), false); assert.equal(f.calls.includes('personal_sign'), false);
      f.setSession({ authenticated: true, wallet: alice.address, chainId, expires: now + 3600 });
      await f.access.restore(); assert.equal(f.access.state.authenticated, false);
      f.setSwitch(undefined); await f.access.connect(f.provider); await f.access.signIn();
      assert.equal(f.access.state.authenticated, true);
    } finally { f.access.dispose(); }
  }
});

test('automatic network switching adds SDK-defined Sepolia only when the wallet reports an unknown chain', async () => {
  const f = fixture(); let attempts = 0;
  try {
    f.setChain('0x1'); f.setSwitch(() => {
      if (++attempts === 1) throw Object.assign(new Error('Unknown chain'), { code: 4902 });
      f.setChain('0xaa36a7'); return null;
    });
    await f.access.connect(f.provider); assert.equal(f.access.state.chainId, chainId);
    assert.equal(f.calls.filter(call => call === 'wallet_addEthereumChain').length, 1); assert.equal(attempts, 2);
    assert.equal(f.calls.includes('personal_sign'), false);
  } finally { f.access.dispose(); }
});

test('automatic network switching cannot trust a successful response without a confirmed network', async () => {
  const f = fixture();
  try {
    f.setChain('0x1'); f.setSwitch(() => null);
    await assert.rejects(f.access.connect(f.provider), /Sepolia/);
    assert.equal(f.access.state.chainId, 1); await assert.rejects(f.access.signIn(), /Sepolia/);
    assert.equal(f.calls.includes('personal_sign'), false); assert.equal(f.calls.includes('/api/auth/challenges'), false);
  } finally { f.access.dispose(); }
});

test('automatic network switching verifies providers that omit chainChanged and detects later malformed events', async () => {
  const f = fixture();
  try {
    f.setChain('0x1'); f.setSwitch(() => { f.setChain('0xaa36a7', false); return null; });
    await f.access.connect(f.provider); assert.equal(f.access.state.chainId, chainId);
    await f.access.signIn(); assert.equal(f.access.state.authenticated, true);
    f.setChain('invalid'); assert.equal(f.access.state.authenticated, false);
    await f.access.idle(); assert.equal(f.session, null);
  } finally { f.access.dispose(); }
});

test('automatic network switching aborts stale account, unexpected network and disposed-screen attempts', async () => {
  for (const change of ['account', 'network', 'dispose']) {
    const f = fixture();
    try {
      f.setChain('0x1'); f.setSwitch(() => {
        if (change === 'account') f.setAccount(bob);
        if (change === 'network') f.setChain('0xa');
        if (change === 'dispose') f.access.dispose();
        return null;
      });
      await assert.rejects(f.access.connect(f.provider)); await f.access.idle();
      assert.equal(f.access.state.authenticated, false); assert.equal(f.calls.includes('personal_sign'), false);
      assert.equal(f.calls.includes('/api/auth/challenges'), false);
    } finally { f.access.dispose(); }
  }
});

test('sign-in refuses challenges with the wrong origin, wallet, nonce, chain or expiry before signing', async () => {
  for (const [from, to] of [[origin, 'https://evil.example'], [alice.address, bob.address], ['Chain: 11155111', 'Chain: 1'], ['Nonce: ' + 'ab'.repeat(32), 'Nonce: ' + 'cd'.repeat(32)], ['Expires: 1300', 'Expires: 999'], ['Expires: 1300', 'Expires: 999999']]) {
    const f = fixture();
    try {
      await f.access.connect(f.provider);
      const id = 'ab'.repeat(32);
      f.setChallenge({ id, message: `Pluto protocol portal\nOrigin: ${origin}\nChain: ${chainId}\nWallet: ${alice.address}\nNonce: ${id}\nExpires: 1300\nThis authenticates portal access only. No transaction or disclosure changes.`.replace(from, to) });
      await assert.rejects(f.access.signIn()); assert.equal(f.calls.includes('personal_sign'), false);
    } finally { f.access.dispose(); }
  }
});

test('account and network changes invalidate private identity and revoke the session', async () => {
  const f = fixture();
  try {
    await f.access.connect(f.provider); await f.access.signIn();
    const before = f.cleared;
    f.setAccount(bob);
    assert.equal(f.access.state.authenticated, false); assert.ok(f.cleared > before);
    await f.access.idle(); assert.equal(f.session, null);
    await f.access.connect(f.provider); await f.access.signIn();
    f.setChain('0x1'); assert.equal(f.access.state.authenticated, false);
    await f.access.idle(); assert.equal(f.session, null);
  } finally { f.access.dispose(); }
});

test('an account change during signature confirmation cannot establish a stale session', async () => {
  const f = fixture(); let complete;
  try {
    await f.access.connect(f.provider);
    f.setSign(() => new Promise(resolve => { complete = resolve; }));
    const pending = f.access.signIn();
    while (!complete) await new Promise(resolve => setImmediate(resolve));
    f.setAccount(bob); complete('0x' + '11'.repeat(65));
    await assert.rejects(pending); await f.access.idle();
    assert.equal(f.access.state.authenticated, false); assert.equal(f.session, null);
    assert.equal(f.calls.includes('/api/auth/sessions'), false);
  } finally { f.access.dispose(); }
});

test('server session restores without wallet prompts, while expiry and disposal clear local identity', async () => {
  const f = fixture();
  try {
    f.setSession({ authenticated: true, wallet: alice.address, chainId, expires: now + 3600 });
    await f.access.restore(); assert.equal(f.access.state.authenticated, true);
    assert.equal(f.calls.includes('eth_requestAccounts'), false);
    f.setSession({ authenticated: true, wallet: alice.address, chainId, expires: now - 1 });
    await f.access.restore(); assert.equal(f.access.state.authenticated, false);
    f.access.dispose(); await assert.rejects(f.access.connect(f.provider));
  } finally { f.access.dispose(); }
});

test('declined and already-pending wallet requests produce safe errors and remain retryable', async () => {
  for (const code of [4001, -32002]) {
    const f = fixture();
    try {
      await f.access.connect(f.provider);
      f.setSign(() => { throw Object.assign(new Error('secret RPC endpoint must not surface'), { code }); });
      await assert.rejects(f.access.signIn(), code === 4001 ? /declined/ : /already open/);
      assert.equal(f.access.state.authenticated, false); assert.doesNotMatch(f.access.state.message, /secret RPC/);
      f.setSign(undefined); await f.access.signIn(); assert.equal(f.access.state.authenticated, true);
    } finally { f.access.dispose(); }
  }
});

test('restore retains an unchanged authorized view and clears it when server auth fails', async () => {
  const f = fixture();
  try {
    await f.access.connect(f.provider); await f.access.signIn(); const before = f.cleared;
    await f.access.restore(); assert.equal(f.cleared, before);
    f.setSession({ authenticated: false }); await f.access.restore();
    assert.equal(f.access.state.authenticated, false); assert.ok(f.cleared > before);
  } finally { f.access.dispose(); }
});

test('an invalid session response fails closed after a previously verified sign-in', async () => {
  const f = fixture();
  try {
    await f.access.connect(f.provider); await f.access.signIn(); assert.equal(f.access.state.authenticated, true);
    f.setSession('malformed session'); await assert.rejects(f.access.restore());
    assert.equal(f.access.state.authenticated, false);
  } finally { f.access.dispose(); }
});


test('small browser/server clock skew permits bounded challenges and session restoration', async () => {
  const f = fixture();
  try {
    f.setNow(now - 10); await f.access.connect(f.provider); await f.access.signIn();
    assert.equal(f.access.state.authenticated, true);
    await f.access.restore(); assert.equal(f.access.state.authenticated, true);
  } finally { f.access.dispose(); }
});


test('standalone preview connects and disconnects without portal calls or authentication claims', async () => {
  const f = fixture({ portalAvailable: false });
  try {
    await f.access.restore(); assert.equal(f.access.state.authenticated, false);
    await f.access.connect(f.provider); assert.equal(f.access.state.wallet, alice.address);
    await assert.rejects(f.access.signIn(), /HTTPS portal/);
    assert.equal(f.calls.some(call => call.startsWith('/api/')), false);
    assert.equal(f.calls.includes('personal_sign'), false);
    await f.access.disconnect(); assert.equal(f.access.state.wallet, undefined);
    assert.equal(f.calls.some(call => call.startsWith('/api/')), false);
    assert.equal(f.events.size, 0);
  } finally { f.access.dispose(); }
});
