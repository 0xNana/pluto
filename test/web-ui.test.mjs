import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mountDisclosureWorkspace as mountActualWorkspace } from '../packages/web/app.mts';
import { readFile } from 'node:fs/promises';
import { renderComponent } from './lib/render-react.mjs';
let workspaceHtml;
const workspaceMarkup = async () => workspaceHtml ??= await renderComponent('apps/web/components/disclosure-workspace.tsx', 'DisclosureWorkspace');
import { facts, fundingState, navigation, renderFundingSummary, recoverableError, windowTiming } from '../packages/web/view.mts';

function mountDisclosureWorkspace() {
  const fixtureFetch = globalThis.fetch;
  globalThis.fetch = (path, init) => path === '/api/auth/session' ? Promise.resolve(Response.json({ authenticated: false })) : fixtureFetch(path, init);
  return mountActualWorkspace();
}

// DOM fixture: exercises handlers and state, not browser layout or IndexedDB.
class Control {
  constructor(tag = 'div', attributes = {}) { this.tagName = tag; this.attributes = attributes; this.id = attributes.id; this.dataset = {}; this.children = []; this.listeners = {}; this.value = ''; this.checked = false; this.disabled = Object.hasOwn(attributes, 'disabled'); this.hidden = Object.hasOwn(attributes, 'hidden'); this.textContent = ''; this.files = null;
    for (const [key, value] of Object.entries(attributes)) if (key.startsWith('data-')) this.dataset[key.slice(5)] = value;
  }
  get textContent() { return this._text ?? ''; }
  set textContent(value) { this._text = value; this.children = []; }
  set innerHTML(_value) { throw new Error('Untrusted HTML assignment'); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.textContent = ''; }
  addEventListener(type, job) { (this.listeners[type] ??= []).push(job); }
  removeEventListener(type, job) { this.listeners[type] = (this.listeners[type] ?? []).filter(listener => listener !== job); }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  focus() { this.focused = true; }
  reportValidity() { return true; }
  checkValidity() { return true; }
  remove() { this.removed = true; }
  async emit(type) { for (const job of this.listeners[type] ?? []) await job(); }
  async click() { if (!this.disabled) await this.emit('click'); }
}
function fixture(html) {
  const nodes = new Map(), links = [];
  for (const match of html.matchAll(/<(\w+)\b([^>]*?)>/g)) {
    const attrs = Object.fromEntries(Array.from(match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g), value => [value[1], value[2] ?? '']));
    const control = new Control(match[1], attrs);
    if (attrs.id) { assert.ok(!nodes.has(attrs.id), `Duplicate ID ${attrs.id}`); nodes.set(attrs.id, control); }
    if (attrs['data-workspace']) links.push(control);
  }
  const document = { getElementById: id => nodes.get(id), createElement: tag => new Control(tag), querySelectorAll: selector => {
    const values = [...nodes.values()];
    if (selector === 'nav a[data-workspace]') return links;
    if (selector === 'input,select') return values.filter(n => ['input', 'select'].includes(n.tagName));
    if (selector === 'button') return values.filter(n => n.tagName === 'button');
    if (selector === 'input[type="checkbox"]') return values.filter(n => n.attributes.type === 'checkbox');
    if (selector.startsWith('button[id^=')) return values.filter(n => n.id.startsWith('remove-notice-'));
    throw new Error(`Unexpected selector ${selector}`);
  } };
  return { nodes, links, document };
}
test('UI controller imports without a DOM and supports cleanup and remount without duplicated encryption', async () => {
  assert.equal(typeof mountDisclosureWorkspace, 'function');
  const html = await workspaceMarkup(), local = fixture(html);
  const previous = Object.fromEntries(['document', 'window', 'location', 'fetch'].map(key => [key, globalThis[key]]));
  const hashListeners = new Set();
  globalThis.document = local.document;
  globalThis.window = { dispatchEvent() {}, addEventListener: (type, job) => { if (type === 'hashchange') hashListeners.add(job); }, removeEventListener: (type, job) => { if (type === 'hashchange') hashListeners.delete(job); } };
  globalThis.location = { hash: '', origin: 'https://pluto.example' };
  const signals = [];
  globalThis.fetch = async (_path, init) => { signals.push(init.signal); return new Promise(() => {}); };
  try {
    const dispose = mountDisclosureWorkspace();
    assert.equal(local.nodes.get('encrypt').listeners.click.length, 1);
    assert.equal(hashListeners.size, 1);
    dispose(); dispose();
    assert.equal(local.nodes.get('encrypt').listeners.click.length, 0);
    assert.equal(hashListeners.size, 0); assert.equal(signals[0].aborted, true);
    const disposeAgain = mountDisclosureWorkspace();
    assert.equal(local.nodes.get('encrypt').listeners.click.length, 1);
    disposeAgain(); assert.equal(local.nodes.get('encrypt').listeners.click.length, 0);
  } finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
});
test('UI workspace navigation, structured funding and hostile labels use safe DOM text', async () => {
  const html = await workspaceMarkup();
  const local = fixture(html), previous = { document: globalThis.document, window: globalThis.window, location: globalThis.location };
  globalThis.document = local.document; const events = {}; globalThis.window = { addEventListener: (type, job) => { events[type] = job; } }; globalThis.location = { hash: '#funding-console' };
  try {
    navigation(); assert.equal(local.nodes.get('protocol').hidden, false); assert.equal(local.nodes.get('researcher').hidden, true); assert.equal(local.links[1].attributes['aria-current'], 'page');
    globalThis.location.hash = '#verifier'; events.hashchange(); assert.equal(local.nodes.get('verifier').hidden, false); assert.equal(local.nodes.get('verifier-title').focused, true);
    globalThis.location.hash = '#main'; events.hashchange(); assert.equal(local.nodes.get('main').focused, true); assert.equal(local.nodes.get('verifier').hidden, false);
    const malicious = '<img src=x onerror=alert(1)>';
    facts('costs', [['Author', malicious]]); assert.equal(local.nodes.get('costs').children[0].children[1].textContent, malicious);
    renderFundingSummary('funding-summary', { payer: malicious, available: { ethWei: 1000000000000000000n, nilUnits: 7n }, budget: null });
    assert.equal(local.nodes.get('funding-summary').children[0].children[3].textContent, '1 ETH');
    assert.match(fundingState('pending'), /no live deadline/); assert.match(fundingState('bound'), /verify against the chain/);
    assert.equal(windowTiming(1600n, 5200n, 1000n), 'Opens in 0d 0h 10m 0s');
    assert.equal(windowTiming(1600n, 5200n, 2000n), 'Window expires in 0d 0h 53m 20s');
    assert.match(windowTiming(1600n, 5200n, 5300n), /expired/); assert.throws(() => windowTiming(1600n, 1500n, 1000n));
    assert.throws(() => fundingState('invented-success')); assert.match(recoverableError('request-sponsorship'), /exact saved request/);
  } finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
});
test('disposed React controller cannot repaint a remounted screen after a pending encryption completes', async () => {
  const html = await workspaceMarkup(), local = fixture(html);
  const previous = Object.fromEntries(['document', 'window', 'location', 'fetch'].map(key => [key, globalThis[key]]));
  let finish;
  globalThis.document = local.document;
  globalThis.window = { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} };
  globalThis.location = { hash: '', origin: 'https://pluto.example' };
  globalThis.fetch = async () => new Promise(() => {});
  try {
    const dispose = mountDisclosureWorkspace();
    local.nodes.get('report-file').files = [{ size: 20, arrayBuffer: () => new Promise(resolve => { finish = resolve; }) }];
    const pending = local.nodes.get('encrypt').click();
    assert.equal(typeof finish, 'function');
    dispose();
    assert.equal(local.nodes.get('report-file').disabled, false, 'cleanup releases controls locked by its pending action');
    const disposeAgain = mountDisclosureWorkspace();
    local.nodes.get('report-status').textContent = 'New screen untouched';
    finish(new TextEncoder().encode('synthetic pending report').buffer);
    await pending;
    assert.equal(local.nodes.get('report-status').textContent, 'New screen untouched');
    assert.equal(local.nodes.get('save-recovery').disabled, true);
    disposeAgain();
  } finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
});
test('aborted old account read cannot erase a new React mount encrypted report or status', async () => {
  const html = await workspaceMarkup(), local = fixture(html);
  const previous = Object.fromEntries(['document', 'window', 'location', 'fetch'].map(key => [key, globalThis[key]]));
  let rejectAccount;
  globalThis.document = local.document;
  globalThis.window = { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} };
  globalThis.location = { hash: '', origin: 'https://pluto.example' };
  globalThis.fetch = async path => {
    if (path === '/api/runtime') return Response.json({ chainId: 11155111, publicRpcUrl: null, writesEnabled: false });
    if (path === '/sdk-abis.json') return Response.json({ market: [], nil: [] });
    if (path === '/registry-artifact.json') return Response.json({ abi: [] });
    return new Promise((_, reject) => { rejectAccount = reject; });
  };
  try {
    const dispose = mountDisclosureWorkspace(); await new Promise(resolve => setImmediate(resolve));
    local.nodes.get('protocol-domain').value = 'example.test';
    const pending = local.nodes.get('load-account').click();
    assert.equal(typeof rejectAccount, 'function'); dispose();
    const disposeAgain = mountDisclosureWorkspace(); await new Promise(resolve => setImmediate(resolve));
    local.nodes.get('report-file').files = [new File(['synthetic fresh report'], 'fixture.txt')];
    await local.nodes.get('encrypt').click();
    assert.equal(local.nodes.get('step-encrypted').dataset.complete, 'true');
    local.nodes.get('portal-status').textContent = 'Current screen';
    rejectAccount(new DOMException('Synthetic abort', 'AbortError')); await pending;
    assert.equal(local.nodes.get('step-encrypted').dataset.complete, 'true');
    assert.equal(local.nodes.get('save-recovery').disabled, false);
    assert.equal(local.nodes.get('portal-status').textContent, 'Current screen');
    disposeAgain();
  } finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
});
test('disposed inbox RPC cannot repaint a retained React row after remount', async () => {
  const { signNotice } = await import('../packages/client/notice.mts');
  const { privateKeyToAccount } = await import('viem/accounts');
  const account = privateKeyToAccount('0x' + '11'.repeat(32));
  const notice = await signNotice({ version: 1, chainId: 11155111, registry: '0x' + '22'.repeat(20), reportId: '0x' + '33'.repeat(32), triggerId: '1',
    cipherHash: '0x' + '44'.repeat(32), cipherUris: ['https://a.example/a', 'https://b.example/b'], keyCommit: '0x' + '55'.repeat(32),
    window: { t1: '1', t2: '2' }, researcher: account.address, verifyUrl: 'https://pluto.example/#verifier' }, account);
  const html = await workspaceMarkup(), local = fixture(html);
  const originalGet = local.document.getElementById;
  const scan = (node, id) => node.id === id ? node : node.children.map(child => scan(child, id)).find(Boolean);
  local.document.getElementById = id => originalGet(id) || [...local.nodes.values()].map(node => scan(node, id)).find(Boolean);
  const previous = Object.fromEntries(['document', 'window', 'location', 'fetch'].map(key => [key, globalThis[key]]));
  let rejectRpc;
  globalThis.document = local.document;
  globalThis.window = { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} };
  globalThis.location = { hash: '', origin: 'https://pluto.example' };
  globalThis.fetch = async path => {
    if (path === '/api/runtime') return Response.json({ chainId: 11155111, publicRpcUrl: 'https://rpc.example/', expectedMarket: '0x' + '66'.repeat(20),
      registry: notice.registry, registryFirstBlock: '0', writesEnabled: false, privateRetentionDays: 30 });
    if (path === '/sdk-abis.json') return Response.json({ market: [], nil: [] });
    if (path === '/registry-artifact.json') return Response.json({ abi: [] });
    if (String(path).includes('/notices')) return Response.json([{ reportId: notice.reportId, notice }]);
    if (String(path).startsWith('https://rpc.example')) return new Promise((_, reject) => { rejectRpc = reject; });
    throw new Error('Unexpected synthetic request');
  };
  try {
    const dispose = mountDisclosureWorkspace(); await new Promise(resolve => setImmediate(resolve));
    local.nodes.get('protocol-domain').value = 'example.test'; await local.nodes.get('inbox').click();
    await new Promise(resolve => setImmediate(resolve)); assert.equal(typeof rejectRpc, 'function');
    const rowState = local.nodes.get('notices').children[0].children[1];
    dispose(); const disposeAgain = mountDisclosureWorkspace(); await new Promise(resolve => setImmediate(resolve));
    rowState.textContent = 'New mount preserved row'; rejectRpc(new Error('Synthetic RPC failure'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(rowState.textContent, 'New mount preserved row'); disposeAgain();
  } finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
});
test('disposed pending export cannot initiate a private download', async () => {
  const html = await workspaceMarkup(), local = fixture(html);
  const previous = Object.fromEntries(['document', 'window', 'location', 'fetch', 'setTimeout'].map(key => [key, globalThis[key]]));
  const previousCreate = URL.createObjectURL;
  let finishExport, downloads = 0;
  globalThis.document = local.document;
  globalThis.window = { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} };
  globalThis.location = { hash: '', origin: 'https://pluto.example' };
  globalThis.fetch = async path => String(path).endsWith('/export') ? new Promise(resolve => { finishExport = resolve; }) : new Promise(() => {});
  URL.createObjectURL = () => { downloads++; return 'blob:synthetic-export'; };
  globalThis.setTimeout = (...args) => { const timer = previous.setTimeout(...args); timer.unref(); return timer; };
  try {
    const dispose = mountDisclosureWorkspace();
    local.nodes.get('protocol-domain').value = 'example.test'; const pending = local.nodes.get('export').click();
    assert.equal(typeof finishExport, 'function'); dispose();
    finishExport(Response.json({ synthetic: 'private metadata fixture' })); await pending;
    assert.equal(downloads, 0);
  } finally {
    URL.createObjectURL = previousCreate;
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
});
test('disposed pending notice deletion cannot remove a retained React row', async () => {
  const html = await workspaceMarkup(), local = fixture(html);
  const originalGet = local.document.getElementById;
  const scan = (node, id) => node.id === id ? node : node.children.map(child => scan(child, id)).find(Boolean);
  local.document.getElementById = id => originalGet(id) || [...local.nodes.values()].map(node => scan(node, id)).find(Boolean);
  const previous = Object.fromEntries(['document', 'window', 'location', 'fetch'].map(key => [key, globalThis[key]]));
  let finishDelete;
  globalThis.document = local.document;
  globalThis.window = { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} };
  globalThis.location = { hash: '', origin: 'https://pluto.example' };
  globalThis.fetch = async (path, init) => {
    if (path === '/api/runtime') return Response.json({ chainId: 11155111, publicRpcUrl: null, writesEnabled: false });
    if (path === '/sdk-abis.json') return Response.json({ market: [], nil: [] });
    if (path === '/registry-artifact.json') return Response.json({ abi: [] });
    if (init.method === 'DELETE') return new Promise(resolve => { finishDelete = resolve; });
    return Response.json([{ reportId: '0x' + '33'.repeat(32), notice: {} }]);
  };
  try {
    const dispose = mountDisclosureWorkspace(); await new Promise(resolve => setImmediate(resolve));
    local.nodes.get('protocol-domain').value = 'example.test'; await local.nodes.get('inbox').click();
    const row = local.nodes.get('notices').children[0], remove = row.children[3];
    local.nodes.get('delete-notice-confirmed').checked = true;
    const pending = remove.click(); assert.equal(typeof finishDelete, 'function');
    dispose(); const disposeAgain = mountDisclosureWorkspace(); await new Promise(resolve => setImmediate(resolve));
    finishDelete(Response.json({ removed: true })); await pending;
    assert.notEqual(row.removed, true); disposeAgain();
  } finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
});
test('connected researcher runtime permits preparation but keeps sends guarded and staff authentication off', async () => {
  const local = fixture(await workspaceMarkup()), host = new EventTarget();
  const previous = Object.fromEntries(['document', 'window', 'location', 'fetch'].map(key => [key, globalThis[key]]));
  globalThis.document = local.document; globalThis.window = host; globalThis.location = { origin: 'http://localhost:3000', hash: '#researcher' };
  const requests = []; let dispose;
  globalThis.fetch = async path => {
    requests.push(String(path));
    if (path === '/api/runtime') return Response.json({ serviceMode: 'researcher', chainId: 11155111, publicRpcUrl: 'https://public.example',
      expectedMarket: '0x' + '12'.repeat(20), registry: '0x' + '34'.repeat(20), registryFirstBlock: '0', writesEnabled: true, privateRetentionDays: 90, sponsorship: null });
    if (path === '/sdk-abis.json') return Response.json({ market: [], nil: [] });
    if (path === '/registry-artifact.json') return Response.json({ abi: [] });
    throw new Error('Preparation must not call authentication or send RPC transactions');
  };
  try {
    dispose = mountActualWorkspace(); await new Promise(resolve => setImmediate(resolve));
    assert.match(local.nodes.get('posting-status').textContent, /Sepolia submission is available/);
    assert.equal(local.nodes.get('post').disabled, true); assert.equal(local.nodes.get('login').disabled, true);
    local.nodes.get('report-file').files = [new File(['synthetic connected report'], 'fixture.txt')];
    await local.nodes.get('encrypt').click(); assert.match(local.nodes.get('report-status').textContent, /Encrypted locally/);
    assert.equal(local.nodes.get('plan').disabled, false);
    for (const id of ['recovery-saved', 'irreversible']) { local.nodes.get(id).checked = true; await local.nodes.get(id).emit('change'); }
    assert.equal(local.nodes.get('post').disabled, true, 'confirmations alone cannot substitute for live costs and review');
    assert.equal(local.nodes.get('review').disabled, true); assert.equal(local.nodes.get('approve-funding').disabled, true);
    assert.deepEqual(requests, ['/api/runtime', '/sdk-abis.json', '/registry-artifact.json']);
  } finally {
    dispose?.(); for (const [key, value] of Object.entries(previous)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
});

test('UI offline preparation, consent gates, private-domain reset and read-only release controls', async () => {
  const html = await workspaceMarkup(), source = await readFile(new URL('../packages/web/app.mts', import.meta.url), 'utf8');
  const local = fixture(html);
  for (const match of source.matchAll(/action\('([^']+)'/g)) assert.ok(local.nodes.has(match[1]), `Missing action ${match[1]}`);
  for (const match of html.matchAll(/for="([^"]+)"/g)) assert.ok(local.nodes.has(match[1]), `Missing label target ${match[1]}`);
  const previous = Object.fromEntries(['document', 'window', 'location', 'fetch'].map(key => [key, globalThis[key]]));
  globalThis.document = local.document; globalThis.window = { dispatchEvent() {}, addEventListener() {} }; globalThis.location = { hash: '', origin: 'https://pluto.example' };
  const requests = [];
  globalThis.fetch = async (path, init) => { requests.push({ path: String(path), init });
    if (path === '/api/runtime') return Response.json({ chainId: 11155111, publicRpcUrl: null, expectedMarket: null, registry: null, registryFirstBlock: null, writesEnabled: false, privateRetentionDays: 30, sponsorship: null });
    if (path === '/sdk-abis.json') return Response.json({ market: [], nil: [] });
    if (path === '/registry-artifact.json') return Response.json({ abi: [], runtimeBytecode: '0x', immutableReferences: {}, compiler: 'fixture' });
    if (String(path).endsWith('/account')) return Response.json({ protocolId: 'example.test', wallet: 'staff', role: 'owner' });
    throw new Error('RPC secret must not reach interface');
  };
  try {
    local.nodes.get('funding-method').value = 'self';
    mountDisclosureWorkspace(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(local.nodes.get('researcher').hidden, false); assert.equal(local.nodes.get('post').disabled, true); assert.equal(local.nodes.get('complete-funded-binding').disabled, true);
    assert.equal(local.nodes.get('send-delivery').disabled, true); assert.equal(local.nodes.get('approve-funding').disabled, true);
    const file = new File(['private report fixture'], 'report.txt'); local.nodes.get('report-file').files = [file];
    await local.nodes.get('encrypt').click(); assert.match(local.nodes.get('report-status').textContent, /Encrypted locally/);
    assert.equal(local.nodes.get('save-recovery').disabled, false); assert.equal(local.nodes.get('step-encrypted').dataset.complete, 'true');
    assert.equal(local.nodes.get('researcher-next').disabled, false, 'navigation remains available after encryption');
    assert.equal(local.nodes.get('review').disabled, true); assert.equal(requests.length, 3, 'local encryption sends no requests; anonymous session restoration uses its own fixture');
    local.nodes.get('protocol-domain').value = 'example.test'; await local.nodes.get('load-account').click(); assert.equal(local.nodes.get('account-summary').children[0].children[1].textContent, 'example.test');
    local.nodes.get('funding-request-id').value = 'private request'; local.nodes.get('funding-approved').checked = true;
    local.nodes.get('protocol-domain').value = 'other.test'; await local.nodes.get('protocol-domain').emit('input');
    assert.equal(local.nodes.get('account-summary').children.length, 0); assert.equal(local.nodes.get('funding-request-id').value, ''); assert.equal(local.nodes.get('funding-approved').checked, false);
    await local.nodes.get('load-account').click(); // Fixture continues authorized reads; no chain writes.
    assert.equal(local.nodes.get('login').disabled, true, 'no installed wallet disables sign-in');
    assert.equal(local.nodes.get('connect-wallet').disabled, true);
    assert.equal(local.nodes.has('wallet-provider'), false);
    assert.doesNotMatch(local.nodes.get('global-status').textContent, /RPC secret/); assert.equal(local.nodes.get('portal-status').attributes['aria-busy'], undefined);
    local.nodes.get('irreversible').checked = true; local.nodes.get('funding-approved').checked = true; await local.nodes.get('irreversible').emit('change');
    for (const id of ['post', 'approve-funding', 'complete-funded-binding', 'resume-binding', 'request-sponsorship']) assert.equal(local.nodes.get(id).disabled, true, `${id} remains gated`);
  } finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
});
test('UI reconciles confirmed withdrawal and fails closed after malformed review or lost approval response', async () => {
  const { privateKeyToAccount } = await import('viem/accounts');
  const { toHex } = await import('viem');
  const { initBrowserCryptoSync, compileCondition } = await import('@nillion/covenants-sdk/browser');
  const { mpkFromSecret, selectCommittee } = await import('@nillion/covenants-sdk');
  const { prepareReport } = await import('../src/shared/report-crypto.mjs');
  const { sealLocalReport } = await import('../packages/client/sealing.mts');
  const { newBrowserRecovery, validateBrowserRecovery, appendRecoveryEvent, BrowserRecoveryStore, fundingRequestId } = await import('../packages/client/recovery.mts');
  const { encodeWire } = await import('../packages/client/wire.mts');
  const key = '0x' + '12'.repeat(32), author = privateKeyToAccount(key), h = (n, size = 32) => toHex(BigInt(n), { size });
  const report = await prepareReport(new TextEncoder().encode('private UI recovery fixture'), author.address);
  const crypto = initBrowserCryptoSync(await readFile(new URL('../node_modules/@nillion/covenants-sdk/dist/wasm-web/cryptomata_core_bg.wasm', import.meta.url)));
  const candidates = [1, 2, 3].map(n => ({ keyId: BigInt(n), nodeId: BigInt(n), mpk: toHex(mpkFromSecret(new Uint8Array(32).fill(n))), expiresAt: 10000n, stake: 10n, fired: 0n, markup: 0, operator: h(n, 20) }));
  const sealed = await sealLocalReport(crypto, report, ['https://a.example/report', 'https://b.example/report'], { committee: selectCommittee(candidates, { mode: 'PUBLIC_CONDITION', m: 3, k: 2, nowUnix: 1000n, minStake: 1n }), t1: 1600n, t2: 5200n, registry: h(7, 20), ceilingWei: 6n, hookGasLimit: 250000, retryWindowSecs: 600, maxPlaintextBytes: 1000n, maxCiphertextBytes: 10000n });
  let saved = await validateBrowserRecovery({ ...await newBrowserRecovery(report, key), sealing: { registry: h(7, 20), market: h(8, 20), cipherUris: sealed.recovery.cipherUris, nonce: sealed.recovery.nonce, args: encodeWire(sealed.args) } });
  const id = h(9); saved = appendRecoveryEvent(appendRecoveryEvent(saved, 'sponsorRequest'), 'sponsorRequest', id);
  const html = await workspaceMarkup(), local = fixture(html);
  const previous = Object.fromEntries(['document', 'window', 'location', 'fetch', 'setTimeout'].map(name => [name, globalThis[name]]));
  const load = BrowserRecoveryStore.prototype.load, claim = BrowserRecoveryStore.prototype.claimFunding;
  BrowserRecoveryStore.prototype.load = async () => validateBrowserRecovery(saved);
  BrowserRecoveryStore.prototype.claimFunding = async (candidate, requestId, action) => { saved = await validateBrowserRecovery(appendRecoveryEvent(appendRecoveryEvent(candidate, action), action, requestId)); return saved; };
  let malformed = true, approvals = 0;
  const grant = { researcher: author.address, payer: h(6, 20), nonce: 1n, deadline: 1500n, signature: '0x' + '56'.repeat(65) };
  const input = { protocolId: 'alpha.example', bundle: { reportId: report.reportId, cipherHash: report.cipherHash, keyCommit: report.keyCommit, args: { ...sealed.args, keys: sealed.args.keys.map(({ keyId, nodeId, mpk }) => ({ keyId, nodeId, mpk })) }, authorization: { author: author.address, payer: grant.payer, minCeiling: 5n, nonce: 0n, deadline: 1500n, signature: grant.signature }, registration: grant }, binding: { ...grant, nonce: 2n, triggerId: 7n } };
  globalThis.document = local.document; globalThis.window = { dispatchEvent() {}, addEventListener() {} }; globalThis.location = { origin: 'https://pluto.example', hash: '#researcher' };
  globalThis.setTimeout = (...args) => { const timer = previous.setTimeout(...args); if (args[1] === 30000) timer.unref(); return timer; };
  globalThis.fetch = async path => {
    if (path === '/api/runtime') return Response.json({ chainId: 11155111, writesEnabled: true, publicRpcUrl: null, sponsorship: null }); // Fixture only; no wallet transport.
    if (path === '/sdk-abis.json') return Response.json({ market: [], nil: [] });
    if (path === '/registry-artifact.json') return Response.json({ abi: [], runtimeBytecode: '0x', immutableReferences: {}, compiler: 'fixture' });
    if (String(path).endsWith('/status')) return new Response(encodeWire({ id, state: 'withdrawn' }));
    if (String(path).endsWith('/quote')) {
      const t2 = malformed ? 253402300800n : input.bundle.args.t2;
      const args = { ...input.bundle.args, t2, publicCondition: compileCondition({ window: { t1: 1600n, t2 } }) };
      return new Response(encodeWire({ requestHash: h(10), ethReserveWei: 100n, feeNil: 25n, escrowWei: 50n, payer: grant.payer, input: { ...input, bundle: { ...input.bundle, args } }, release: grant.signature }));
    }
    if (String(path).endsWith('/approve')) { approvals++; throw new Error('fixture response lost'); }
    throw new Error('Unexpected fixture route');
  };
  try {
    local.nodes.get('funding-method').value = 'self';
    mountDisclosureWorkspace(); await new Promise(resolve => setImmediate(resolve));
    local.nodes.get('local-report-id').value = report.reportId; local.nodes.get('fingerprint-confirmed').checked = true; local.nodes.get('delivery-approved').checked = true;
    await local.nodes.get('load-local-recovery').click(); assert.equal(local.nodes.get('delivery-approved').checked, false); assert.equal(local.nodes.get('fingerprint-confirmed').checked, false);
    assert.equal(local.nodes.get('refresh-costs').disabled, true);
    await local.nodes.get('sponsorship-status').click(); assert.equal(fundingRequestId(saved), undefined); assert.equal(saved.history.at(-1).action, 'sponsorWithdraw');
    assert.equal(local.nodes.get('refresh-costs').disabled, false); assert.match(local.nodes.get('posting-status').textContent, /withdrawn/);
    local.nodes.get('protocol-domain').value = 'alpha.example'; local.nodes.get('funding-request-id').value = id; local.nodes.get('funding-approved').checked = true;
    await local.nodes.get('quote-funding').click(); assert.equal(local.nodes.get('funding-approved').checked, false);
    local.nodes.get('funding-approved').checked = true; await local.nodes.get('funding-approved').emit('change'); assert.equal(local.nodes.get('approve-funding').disabled, true, 'failed rendering never publishes an approval');
    malformed = false; await local.nodes.get('quote-funding').click(); local.nodes.get('funding-approved').checked = true; await local.nodes.get('funding-approved').emit('change');
    assert.equal(local.nodes.get('approve-funding').disabled, false); await local.nodes.get('approve-funding').click(); assert.equal(approvals, 1);
    assert.equal(local.nodes.get('funding-approved').checked, false); assert.equal(local.nodes.get('approve-funding').disabled, true);
    local.nodes.get('funding-approved').checked = true; await local.nodes.get('funding-approved').emit('change'); await local.nodes.get('approve-funding').click(); assert.equal(approvals, 1, 'lost response cannot be retried using stale consent');
  } finally { BrowserRecoveryStore.prototype.load = load; BrowserRecoveryStore.prototype.claimFunding = claim; for (const [name, value] of Object.entries(previous)) if (value === undefined) delete globalThis[name]; else globalThis[name] = value; }
});

test('UI background inbox verification caps RPC concurrency and stops scheduling after account/page changes', async () => {
  const { readInboxRows } = await import('../packages/web/inbox-reads.mts');
  let current = true, active = 0, maximum = 0; const started = [], release = [];
  const pending = readInboxRows([1, 2, 3, 4, 5], async row => { started.push(row); active++; maximum = Math.max(maximum, active); await new Promise(resolve => release.push(resolve)); active--; }, () => current);
  assert.equal(maximum, 3); assert.deepEqual(started, [1, 2, 3]); current = false; release.forEach(resolve => resolve()); await pending;
  assert.deepEqual(started, [1, 2, 3], 'stale scope never schedules another read');
  const completed = []; await readInboxRows([1, 2, 3, 4, 5], async row => { completed.push(row); }, () => true); assert.deepEqual(completed.sort(), [1, 2, 3, 4, 5]);
  await assert.rejects(readInboxRows([1], async () => { throw new Error('fixture RPC unavailable'); }, () => true), /unavailable/);
});

for (const logoutFails of [false, true]) test(`Next wallet controls verify ECDSA cookie sign-in and block stale reads after account change (logout failure: ${logoutFails})`, async () => {
  const { mkdtemp, chmod, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { privateKeyToAccount } = await import('viem/accounts'); const { hexToString } = await import('viem');
  const { PortalStore } = await import('../packages/portal/store.mts');
  const { PortalInbox } = await import('../packages/portal/inbox.mts');
  const { ProtocolEnrollment } = await import('../packages/portal/enrollment.mts');
  const { portalHandler } = await import('../packages/portal/http.mts');
  const directory = await mkdtemp(join(tmpdir(), 'pluto-wallet-ui-')); await chmod(directory, 0o700);
  const origin = 'https://pluto.example', store = new PortalStore(join(directory, 'portal.sqlite'), origin, 11155111);
  const account = privateKeyToAccount('0x' + '12'.repeat(32)); const bob = privateKeyToAccount('0x' + '34'.repeat(32));
  store.enrollVerifiedProtocol('example.test', account.address);
  const handler = portalHandler(store, new PortalInbox(store, 86400), new ProtocolEnrollment(store));
  const local = fixture(await workspaceMarkup()), host = new EventTarget(), listeners = new Map(), methods = [];
  let active = account, cookie = '', finishAccount, delayAccount = false, failLogout = false, privateReads = 0, keepConnected = true;
  host.ethereum = {
    async request({ method, params }) {
      methods.push(method);
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [active.address];
      if (method === 'eth_chainId') return '0xaa36a7';
      if (method === 'personal_sign') return active.signMessage({ message: hexToString(params[0]) });
      throw new Error('Unexpected wallet request');
    },
    on(event, listener) { listeners.set(event, listener); },
    removeListener(event, listener) { if (listeners.get(event) === listener) listeners.delete(event); },
  };
  const previous = Object.fromEntries(['document', 'window', 'location', 'fetch'].map(key => [key, globalThis[key]])); let dispose;
  globalThis.document = local.document; globalThis.window = host; globalThis.location = { origin, hash: '#protocol' };
  globalThis.fetch = async (path, init) => {
    if (path === '/api/runtime') return Response.json({ chainId: 11155111, publicRpcUrl: null, writesEnabled: false });
    if (path === '/sdk-abis.json') return Response.json({ market: [], nil: [] });
    if (path === '/registry-artifact.json') return Response.json({ abi: [] });
    if (path === '/api/auth/logout' && failLogout) return Response.json({ error: { code: 'UNAVAILABLE' } }, { status: 503 });
    if (String(path).endsWith('/account')) privateReads++;
    const response = await handler(new Request(origin + path, { ...init, headers: {
      ...init.headers, origin, ...(cookie ? { cookie } : {}),
    } }));
    const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0];
    if (delayAccount && String(path).endsWith('/account')) return new Promise(resolve => { finishAccount = () => resolve(response); });
    return response;
  };
  try {
    dispose = mountActualWorkspace({ walletConnector: {
      async connect() { return host.ethereum; }, async disconnect() {}, async manageAccount() { return keepConnected; },
    } }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(local.nodes.get('connect-wallet').disabled, false);
    assert.equal(methods.length, 0, 'mount never prompts the wallet');
    local.nodes.get('report-file').files = [new File(['synthetic independent researcher report'], 'fixture.txt')];
    await local.nodes.get('encrypt').click();
    const independentAuthor = local.nodes.get('author').value;
    assert.match(independentAuthor, /^0x[0-9a-fA-F]{40}$/);
    assert.notEqual(independentAuthor, account.address);
    await local.nodes.get('connect-wallet').click();
    assert.doesNotMatch(local.nodes.get('connect-wallet').textContent, /Signed in/);
    assert.equal(local.nodes.get('login').disabled, false); assert.equal(methods.includes('personal_sign'), false);
    await local.nodes.get('login').click();
    assert.match(local.nodes.get('portal-status').textContent, /Signed in/);
    assert.equal(store.sessionWallet(cookie.split('=')[1]), account.address);
    const beforeAccountControls = methods.length;
    await local.nodes.get('connect-wallet').click();
    assert.equal(methods.length, beforeAccountControls, 'closing account controls requests no signature or reconnect');
    assert.equal(store.sessionWallet(cookie.split('=')[1]), account.address, 'closing account controls keeps the session');
    assert.equal(local.nodes.get('logout').disabled, false);
    local.nodes.get('protocol-domain').value = 'example.test';
    await local.nodes.get('load-account').click(); assert.equal(local.nodes.get('account-summary').children[0].children[1].textContent, 'example.test');
    const beforeRestore = local.nodes.get('account-summary').children[0];
    host.dispatchEvent(new Event('focus')); await new Promise(resolve => setImmediate(resolve));
    assert.equal(local.nodes.get('account-summary').children[0], beforeRestore, 'unchanged session keeps the view');
    delayAccount = true; const pending = local.nodes.get('load-account').click();
    while (!finishAccount) await new Promise(resolve => setImmediate(resolve));
    local.nodes.get('funding-approved').checked = true;
    failLogout = logoutFails; active = bob; listeners.get('accountsChanged')([bob.address]);
    assert.equal(local.nodes.get('account-summary').children.length, 0);
    assert.equal(local.nodes.get('funding-approved').checked, false);
    finishAccount(); await pending; await new Promise(resolve => setImmediate(resolve));
    assert.equal(local.nodes.get('account-summary').children.length, 0, 'late private response cannot repaint another identity');
    assert.equal(store.sessionInfo(cookie.split('=')[1]).authenticated, logoutFails);
    const beforeBlockedRead = privateReads; await local.nodes.get('load-account').click();
    assert.equal(privateReads, beforeBlockedRead, 'revoked identity cannot initiate private reads even when server logout failed');
    assert.match(local.nodes.get('portal-status').textContent, /Sign in again/);
    failLogout = false;
    assert.doesNotMatch(local.nodes.get('connect-wallet').textContent, /Signed in/);
    assert.equal(local.nodes.get('author').value, independentAuthor);
    assert.equal(local.nodes.get('step-encrypted').dataset.complete, 'true', 'staff identity changes preserve the independent report');
    assert.equal(local.nodes.get('post').disabled, true);
    assert.equal(methods.some(method => /sendTransaction|signTypedData/.test(method)), false);
    keepConnected = false; await local.nodes.get('connect-wallet').click(); assert.equal(listeners.size, 0);
  } finally {
    dispose?.(); store.close(); await rm(directory, { recursive: true });
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
});

test('localhost Next preview loads its real runtime route, encrypts and connects without private API calls', async () => {
  const { GET } = await import('../apps/web/app/api/runtime/route.ts');
  const local = fixture(await workspaceMarkup()), host = new EventTarget(), requests = [], methods = [];
  host.ethereum = {
    async request({ method }) {
      methods.push(method);
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return ['0x' + '56'.repeat(20)];
      if (method === 'eth_chainId') return '0xaa36a7';
      throw new Error('Preview must not request a signature');
    }, on() {}, removeListener() {},
  };
  const previous = Object.fromEntries(['document', 'window', 'location', 'fetch'].map(key => [key, globalThis[key]])); let dispose;
  globalThis.document = local.document; globalThis.window = host; globalThis.location = { origin: 'http://localhost:3000', hash: '' };
  globalThis.fetch = async path => {
    requests.push(path);
    if (path === '/api/runtime') return GET();
    if (path === '/sdk-abis.json') return Response.json({ market: [], nil: [] });
    if (path === '/registry-artifact.json') return Response.json({ abi: [] });
    throw new Error('Preview must not use a private portal or chain endpoint');
  };
  try {
    dispose = mountActualWorkspace(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(local.nodes.get('global-status').textContent, '');
    assert.doesNotMatch(local.nodes.get('global-status').textContent, /Configuration could not/);
    assert.deepEqual(requests, ['/api/runtime', '/sdk-abis.json', '/registry-artifact.json']);
    local.nodes.get('report-file').files = [new File(['synthetic preview report'], 'fixture.txt')];
    await local.nodes.get('encrypt').click(); assert.equal(local.nodes.get('step-encrypted').dataset.complete, 'true');
    await local.nodes.get('researcher-next').click(); host.dispatchEvent(new Event('hashchange'));
    local.nodes.get('window-hours').value = '24';
    for (const id of ['upload-a', 'read-a', 'upload-b', 'read-b']) local.nodes.get(id).value = `https://storage.example/${id}`;
    await local.nodes.get('plan').click();
    assert.match(local.nodes.get('report-status').textContent, /Live verification or pricing was unavailable/);
    assert.equal(local.nodes.get('report-status').focused, true, 'preparation errors focus the visible shared status');
    assert.equal(local.nodes.get('researcher-next').disabled, false, 'failed planning does not prevent browsing review');
    await local.nodes.get('researcher-next').click(); host.dispatchEvent(new Event('hashchange'));
    assert.equal(local.nodes.get('researcher-review-panel').hidden, false);
    assert.equal(local.nodes.get('review').disabled, true, 'failed planning keeps the review action guarded');
    assert.equal(requests.length, 3, 'unconfigured preview never sends a live plan or upload');
    await local.nodes.get('connect-wallet').click(); assert.match(local.nodes.get('connect-wallet').textContent, /^0x/);
    assert.equal(local.nodes.get('login').disabled, true); assert.equal(local.nodes.get('login').disabled, true);
    assert.match(local.nodes.get('global-status').textContent, /HTTPS portal/);
    await local.nodes.get('connect-wallet').click(); assert.equal(local.nodes.get('connect-wallet').textContent, 'Connect wallet');
    assert.equal(requests.length, 3); assert.equal(methods.includes('personal_sign'), false);
    assert.equal(local.nodes.get('post').disabled, true); assert.equal(local.nodes.get('approve-funding').disabled, true);
  } finally {
    dispose?.();
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
});

test('header retries a declined AppKit network switch and enables sign-in only after Sepolia confirmation', async () => {
  const { GET } = await import('../apps/web/app/api/runtime/route.ts');
  const local = fixture(await workspaceMarkup());
  const previous = Object.fromEntries(['document', 'window', 'location', 'fetch'].map(key => [key, globalThis[key]]));
  const events = new Map(), wallet = '0x' + '67'.repeat(20), calls = [];
  let chain = '0x1', switches = 0, allow = false, finishSwitch;
  const provider = {
    async request({ method }) {
      calls.push(method);
      if (['eth_requestAccounts', 'eth_accounts'].includes(method)) return [wallet];
      if (method === 'eth_chainId') return chain;
      throw new Error('No signatures, direct network calls or transactions in this fixture');
    },
    on: (event, job) => events.set(event, job), removeListener: event => events.delete(event),
  };
  globalThis.document = local.document; globalThis.window = new EventTarget();
  globalThis.location = { hash: '', origin: 'https://pluto.example' };
  globalThis.fetch = async path => {
    if (path === '/api/runtime') { const runtime = await GET().json(); runtime.serviceMode = 'portal'; return Response.json(runtime); }
    if (path === '/api/auth/session') return Response.json({ authenticated: false });
    if (path === '/sdk-abis.json') return Response.json({ market: [], nil: [] });
    if (path === '/registry-artifact.json') return Response.json({ abi: [] });
    throw new Error('Unexpected API call');
  };
  let dispose;
  try {
    dispose = mountActualWorkspace({ walletConnector: {
      async connect() { return provider; }, async disconnect() {},
      async switchNetwork() {
        switches++;
        if (!allow) throw Object.assign(new Error('synthetic private transport detail'), { code: 4001 });
        await new Promise(resolve => { finishSwitch = resolve; });
        chain = '0xaa36a7'; events.get('chainChanged')?.(chain);
      },
    } });
    await new Promise(resolve => setImmediate(resolve));
    await local.nodes.get('connect-wallet').click();
    assert.equal(switches, 1); assert.equal(local.nodes.get('login').disabled, true);
    assert.match(local.nodes.get('connect-wallet').attributes['aria-label'], /Switch wallet to Sepolia/);
    assert.match(local.nodes.get('global-status').textContent, /declined/);
    assert.doesNotMatch(local.nodes.get('global-status').textContent, /private transport/);
    assert.match(local.nodes.get('connect-wallet').textContent, /^0x/);
    allow = true; const retry = local.nodes.get('connect-wallet').click();
    while (!finishSwitch) await new Promise(resolve => setImmediate(resolve));
    assert.equal(local.nodes.get('login').disabled, true);
    finishSwitch(); await retry;
    assert.equal(switches, 2); assert.match(local.nodes.get('global-status').textContent, /Sepolia/);
    assert.equal(local.nodes.get('login').disabled, false);
    assert.match(local.nodes.get('connect-wallet').attributes['aria-label'], /Manage wallet/);
    assert.equal(calls.some(call => /sign|sendTransaction|wallet_switch/.test(call)), false);
  } finally {
    dispose?.(); for (const [key, value] of Object.entries(previous)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
});

for (const logoutFailure of [false, true]) test(`header AppKit connects without an injected extension and disconnects its wallet session (logout failure: ${logoutFailure})`, async () => {
  const { GET } = await import('../apps/web/app/api/runtime/route.ts');
  const local = fixture(await workspaceMarkup()), host = new EventTarget(), calls = [];
  const provider = { async request({ method }) {
    calls.push(method);
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return ['0x' + '67'.repeat(20)];
    if (method === 'eth_chainId') return '0xaa36a7';
    throw new Error('Connection must not sign or send transactions');
  }, on() {}, removeListener() {} };
  const connector = {
    async connect(signal) { assert.equal(signal.aborted, false); calls.push('picker'); return provider; },
    async manageAccount(signal) { assert.equal(signal.aborted, false); calls.push('account'); calls.push('disconnect'); return false; },
    async disconnect() { calls.push('disconnect'); },
  };
  const previous = Object.fromEntries(['document', 'window', 'location', 'fetch'].map(key => [key, globalThis[key]])); let dispose;
  globalThis.document = local.document; globalThis.window = host; globalThis.location = { origin: 'http://localhost:3000', hash: '' };
  globalThis.fetch = async path => {
    if (path === '/api/runtime') { const runtime = await GET().json(); if (logoutFailure) runtime.serviceMode = 'portal'; return Response.json(runtime); }
    if (path === '/api/auth/session') return Response.json({ authenticated: false });
    if (path === '/api/auth/logout' && logoutFailure) throw new Error('synthetic portal unavailable');
    if (path === '/sdk-abis.json') return Response.json({ market: [], nil: [] });
    if (path === '/registry-artifact.json') return Response.json({ abi: [] });
    throw new Error('Unexpected API');
  };
  try {
    dispose = mountActualWorkspace({ walletConnector: connector }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(local.nodes.get('connect-wallet').disabled, false);
    assert.equal(local.nodes.has('wallet-provider'), false); assert.equal(local.nodes.has('wallet-account'), false);
    await local.nodes.get('connect-wallet').click(); assert.match(local.nodes.get('connect-wallet').textContent, /^0x/);
    assert.ok(calls.includes('picker')); assert.equal(local.nodes.get('login').disabled, !logoutFailure);
    await local.nodes.get('connect-wallet').click(); assert.ok(calls.includes('account')); assert.equal(calls.filter(call => call === 'disconnect').length, 1);
    assert.equal(local.nodes.get('connect-wallet').textContent, 'Connect wallet');
    assert.equal(local.nodes.get('post').disabled, true);
  } finally { dispose?.(); for (const [key, value] of Object.entries(previous)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
});

test('researcher sections remain browsable before preparation and retain all in-progress inputs', async () => {
  const { researcherJourney } = await import('../packages/web/researcher-journey.mts');
  const local = fixture(await workspaceMarkup()), previous = { document: globalThis.document, location: globalThis.location, window: globalThis.window };
  globalThis.document = local.document; globalThis.location = { hash: '#researcher', origin: 'https://pluto.example' };
  const host = new EventTarget(); globalThis.window = host;
  let journey, disposeNavigation;
  const changed = () => host.dispatchEvent(new Event('hashchange'));
  try {
    journey = researcherJourney(); assert.ok(journey); disposeNavigation = navigation(focus => journey.activate(focus));
    journey.update({ encrypted: false, sealed: false, priced: false, attempted: false, notice: false });
    assert.equal(local.nodes.get('researcher-prepare-panel').hidden, false);
    assert.equal(local.nodes.get('researcher-next').disabled, false);
    for (const stage of ['seal', 'review', 'share', 'prepare']) {
      assert.equal(local.nodes.get(`researcher-${stage}`).disabled, false);
      await local.nodes.get(`researcher-${stage}`).click(); changed();
      assert.equal(location.hash, `#researcher/${stage}`);
      assert.equal(local.nodes.get(`researcher-${stage}-panel`).hidden, false);
    }
    for (const id of ['plan', 'review', 'post', 'send-delivery']) assert.equal(local.nodes.get(id).disabled, true);
    local.nodes.get('report-file').files = ['local file']; local.nodes.get('upload-a').value = 'https://store.example/upload';
    journey.update({ encrypted: true, sealed: false, priced: false, attempted: false, notice: false, reportId: 'synthetic public report ID' });
    await local.nodes.get('researcher-next').click(); changed();
    assert.equal(location.hash, '#researcher/seal'); assert.equal(local.nodes.get('seal-title').focused, true);
    assert.equal(local.nodes.get('researcher-prepare-panel').hidden, true); assert.equal(local.nodes.get('researcher-seal-panel').hidden, false);
    assert.equal(local.nodes.get('researcher-next').disabled, false);
    journey.update({ encrypted: true, sealed: true, priced: true, attempted: false, notice: false });
    await local.nodes.get('researcher-next').click(); changed();
    assert.equal(location.hash, '#researcher/review'); assert.equal(local.nodes.get('researcher-share').disabled, false);
    await local.nodes.get('researcher-saved').click(); changed();
    assert.equal(local.nodes.get('researcher-recovery-panel').hidden, false);
    assert.equal(local.nodes.get('researcher-stage-controls').hidden, true);
    await local.nodes.get('researcher-prepare').click(); changed();
    assert.deepEqual(local.nodes.get('report-file').files, ['local file']); assert.equal(local.nodes.get('upload-a').value, 'https://store.example/upload');
    assert.equal(local.nodes.get('post').disabled, true);
    location.hash = '#protocol'; changed(); assert.equal(local.nodes.get('protocol').hidden, false);
    location.hash = '#researcher/seal'; changed(); assert.equal(local.nodes.get('researcher-seal-panel').hidden, false);
    assert.equal(local.nodes.get('upload-a').value, 'https://store.example/upload');
  } finally {
    disposeNavigation?.(); journey?.dispose();
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
  for (const id of ['researcher-next', 'researcher-back', 'researcher-saved', 'researcher-seal']) assert.equal(local.nodes.get(id).listeners.click.length, 0);
});
test('researcher deep links allow browsing while submission and sharing actions remain guarded', async () => {
  const { researcherJourney } = await import('../packages/web/researcher-journey.mts');
  const local = fixture(await workspaceMarkup()), previous = { document: globalThis.document, location: globalThis.location, history: globalThis.history };
  globalThis.document = local.document; globalThis.location = { hash: '#researcher/share' };
  globalThis.history = { state: null, replaceState(_state, _title, url) { location.hash = url; } };
  let journey;
  try {
    journey = researcherJourney(); journey.activate(false);
    assert.equal(local.nodes.get('researcher-share-panel').hidden, false); assert.equal(location.hash, '#researcher/share');
    for (const stage of ['prepare', 'seal', 'review', 'share']) {
      location.hash = `#researcher/${stage}`; journey.activate(true);
      journey.update({ encrypted: false, sealed: false, priced: false, attempted: false, notice: false });
      assert.equal(location.hash, `#researcher/${stage}`, 'readiness updates must not redirect a browsed section');
      assert.equal(local.nodes.get(`researcher-${stage}-panel`).hidden, false);
      assert.equal(local.nodes.get('post').disabled, true);
      assert.equal(local.nodes.get('send-delivery').disabled, true);
    }
    journey.update({ encrypted: true, sealed: true, priced: false, attempted: true, notice: false });
    assert.match(local.nodes.get('researcher-report-state').textContent, /inspect|recovery/i);
    await local.nodes.get('researcher-continue').click(); journey.activate(true);
    assert.equal(location.hash, '#researcher/recovery'); assert.equal(local.nodes.get('researcher-recovery-title').focused, true);
    journey.update({ encrypted: true, sealed: true, priced: false, attempted: true, notice: true });
    await local.nodes.get('researcher-continue').click(); journey.activate(true);
    assert.equal(location.hash, '#researcher/share'); assert.equal(local.nodes.get('researcher-share-panel').hidden, false);
    assert.equal(local.nodes.get('researcher-next').hidden, true);
    location.hash = '#researcher/review'; journey.activate(true);
    assert.equal(local.nodes.get('researcher-review-panel').hidden, false);
    journey.update({ encrypted: true, sealed: true, priced: false, attempted: true, notice: false });
    assert.equal(local.nodes.get('researcher-review-panel').hidden, false);
    assert.equal(location.hash, '#researcher/review');
    assert.equal(local.nodes.get('send-delivery').disabled, true);
  } finally {
    journey?.dispose();
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
});
