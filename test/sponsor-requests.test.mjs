import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toHex } from 'viem';
import { compileCondition } from '@nillion/covenants-sdk/browser';
import { PortalStore } from '../packages/portal/store.mts';
import { SponsorRequests } from '../packages/relayer/requests.mts';
import { sponsorHandler } from '../packages/portal/sponsor-http.mts';
import { sponsorReleaseMessage, sponsorProofMessage, sponsorRequestId } from '../packages/client/sponsor-wire.mts';
import { encodeWire } from '../packages/client/wire.mts';

test('T-14/15 signed funding queue scopes customer approval, withdrawal, ambiguity and researcher-only status', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pluto-requests-')); await chmod(dir, 0o700);
  const store = new PortalStore(join(dir, 'portal.sqlite'), 'https://pluto.example', 11155111, () => 1000);
  const author = privateKeyToAccount('0x' + '12'.repeat(32)), customer = privateKeyToAccount('0x' + '34'.repeat(32));
  const h = (n, size = 32) => toHex(BigInt(n), { size }), payer = h(6, 20), registry = h(7, 20);
  let sends = 0, configuredWrites = false, observed = { state: 'awaiting-binding', triggerId: 8n, postHash: h(3) };
  const grant = { researcher: author.address, payer, nonce: 1n, deadline: 1500n, signature: '0x' + '56'.repeat(65) };
  const input = { protocolId: 'alpha.example', bundle: { reportId: h(1), cipherHash: h(2), keyCommit: h(3), args: {
    mode: 'PUBLIC_CONDITION', ttl: 0, keys: [1n, 2n, 3n].map(keyId => ({ keyId, nodeId: keyId, mpk: '0x01' })), k: 2, t1: 1600n, t2: 5200n,
    ceilingWei: 6n, hook: registry, hookGasLimit: 250000, retryWindowSecs: 600, layers: [1, 2, 3].map(() => new Uint8Array(230)), commit: h(4), publicCondition: compileCondition({ window: { t1: 1600n, t2: 5200n } }) },
    authorization: { author: author.address, payer, nonce: 0n, deadline: 1500n, minCeiling: 5n, signature: '0x' + '67'.repeat(65) }, registration: grant }, binding: { ...grant, nonce: 2n, triggerId: 7n } };
  store.db.exec('CREATE TABLE intents(id TEXT PRIMARY KEY)');
  const service = { store, wallet: { account: { address: payer } }, config: { get writesEnabled() { return configuredWrites; } }, quote: async (protocolId, bundle, binding) => ({ id: h(bundle.authorization.nonce + 10n), requestHash: keccak256(toHex(encodeWire({ bundle, binding }))), bundle, binding, protocolId, ethReserveWei: 100n, feeNil: 25n }),
    prepare: async (_s, p, b, g) => service.quote(p, b, g), submit: async (_session, prepared) => { store.db.prepare('INSERT INTO intents VALUES(?)').run(prepared.id); sends++; throw new Error('fixture ambiguous wallet failure'); },
    observe: async () => observed, completeBinding: async () => { sends++; return { state: 'bound' }; } };
  try {
    store.enrollVerifiedProtocol('alpha.example', customer.address); store.enrollVerifiedProtocol('beta.example', author.address);
    const c = store.challenge(customer.address), session = await store.authenticate(c.id, await customer.signMessage({ message: c.message }));
    const requests = new SponsorRequests(store, service);
    const bounds = await requests.quote(input), release = await author.signMessage({ message: sponsorReleaseMessage(store.origin, input.protocolId, bounds) });
    const body = { input, bounds: { requestHash: bounds.requestHash, ethReserveWei: bounds.ethReserveWei, feeNil: bounds.feeNil }, release };
    const created = await requests.create(body); assert.equal(created.state, 'pending');
    const handler = sponsorHandler(requests);
    assert.throws(() => sponsorHandler(requests, { store, payer: h(99, 20), market: h(100, 20) }), /Funding service context mismatch/);
    const http = (path, body, token = '', origin = store.origin) => new Request(store.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: {
      ...(body === undefined ? {} : { origin, 'content-type': 'application/json' }), ...(token ? { cookie: `pluto_session=${token}` } : {}),
    }, body: body === undefined ? undefined : encodeWire(body) });
    assert.equal((await handler(http('/api/protocols/alpha.example/sponsorship/requests'))).status, 403);
    assert.equal((await handler(http('/api/protocols/beta.example/sponsorship/requests', undefined, session))).status, 403);
    assert.equal((await handler(http('/api/protocols/alpha.example/sponsorship/requests', undefined, session))).status, 200);
    assert.equal((await handler(http('/api/sponsorship/requests', body, '', 'https://evil.example'))).status, 403);
    assert.equal((await handler(http('/api/sponsorship/requests', { ...body, key: h(9) }))).status, 400);
    assert.equal((await handler(http('/api/sponsorship/requests', body))).status, 201);
    assert.equal((await requests.create(body)).id, created.id);
    await assert.rejects(requests.create({ ...body, input: { ...input, protocolId: 'beta.example' } }), /release/);
    const proof = async (action, signer = author) => ({ expires: 1100, signature: await signer.signMessage({ message: sponsorProofMessage(store.origin, created.id, action, 1100) }) });
    await assert.rejects(requests.status(created.id, await proof('status', customer)), /Not authorized/);
    await assert.rejects(requests.status(created.id, await proof('withdraw')), /Not authorized/);
    assert.equal((await requests.status(created.id, await proof('status'))).state, 'pending');
    assert.throws(() => requests.list(session, 'beta.example'), /Not authorized/);
    assert.equal(requests.list(session, 'alpha.example').length, 1);
    await assert.rejects(requests.approve(session, 'alpha.example', created.id, body.bounds), /disabled/);
    assert.equal((await requests.status(created.id, await proof('status'))).state, 'pending'); assert.equal(sends, 0);
    assert.equal((await requests.withdraw(created.id, await proof('withdraw'))).state, 'withdrawn');
    configuredWrites = true;
    await assert.rejects(requests.approve(session, 'alpha.example', created.id, body.bounds), /withdrawn/); assert.equal(sends, 0);
    assert.equal((await requests.create(body)).state, 'withdrawn'); // retained tombstone
    const next = { ...input, bundle: { ...input.bundle, authorization: { ...input.bundle.authorization, nonce: 1n } } };
    const nextBounds = await requests.quote(next), nextMessage = sponsorReleaseMessage(store.origin, next.protocolId, nextBounds);
    const nextRequest = await requests.create({ input: next, bounds: { requestHash: nextBounds.requestHash, ethReserveWei: nextBounds.ethReserveWei, feeNil: nextBounds.feeNil }, release: await author.signMessage({ message: nextMessage }) });
    assert.equal(nextRequest.id, sponsorRequestId(nextMessage));
    await assert.rejects(requests.approve(session, 'alpha.example', nextRequest.id, { ...body.bounds, requestHash: h(99) }), /review/);
    const nextReview = { requestHash: nextBounds.requestHash, ethReserveWei: nextBounds.ethReserveWei, feeNil: nextBounds.feeNil };
    const outcome = await requests.approve(session, 'alpha.example', nextRequest.id, nextReview); assert.equal(outcome.state, 'unknown'); assert.equal(sends, 1);
    const nextProof = { expires: 1100, signature: await author.signMessage({ message: sponsorProofMessage(store.origin, nextRequest.id, 'withdraw', 1100) }) };
    await assert.rejects(requests.withdraw(nextRequest.id, nextProof), /attempted/);
    assert.equal((await requests.approve(session, 'alpha.example', nextRequest.id, nextReview)).state, 'awaiting-binding'); assert.equal(sends, 1);
    store.db.prepare("INSERT INTO relay_execution VALUES(1,?,'awaiting-proof',?)").run(nextRequest.id, 'old-execution');
    service.observe = async () => {
      store.db.prepare("UPDATE relay_execution SET execution_token='new-execution' WHERE id=1").run();
      return observed;
    };
    assert.equal((await requests.customerStatus(session, 'alpha.example', nextRequest.id)).state, 'awaiting-binding');
    assert.equal(store.db.prepare('SELECT execution_token FROM relay_execution').get().execution_token, 'new-execution');
    service.observe = async () => ({ state: 'failed' });
    assert.equal((await requests.customerStatus(session, 'alpha.example', nextRequest.id)).state, 'failed');
    assert.equal(store.db.prepare('SELECT * FROM relay_execution').get(), undefined);
    assert.equal((await requests.approve(session, 'alpha.example', nextRequest.id, nextReview)).state, 'failed'); assert.equal(sends, 1);
    const expired = { expires: 999, signature: await author.signMessage({ message: sponsorProofMessage(store.origin, nextRequest.id, 'status', 999) }) };
    await assert.rejects(requests.status(nextRequest.id, expired), /Not authorized/);
  } finally { store.close(); await rm(dir, { recursive: true }); }
});
