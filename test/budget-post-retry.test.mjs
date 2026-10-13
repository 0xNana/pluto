import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, encodeEventTopics, encodeAbiParameters, toHex } from 'viem';
import { triggerMarketAbi, nilAbi, compileCondition } from '@nillion/covenants-sdk';
import { postParamsTuple } from '@nillion/covenants-sdk/browser';
import { compileContracts } from '../scripts/lib/contracts.mjs';
import { PortalStore } from '../packages/portal/store.mts';
import { SponsorBudget } from '../packages/relayer/budget.mts';

test('T-14 one sponsored post retry requires final canonical revert and charges both gas attempts but only one escrow and NIL fee', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pluto-post-retry-')); await chmod(dir, 0o700);
  const store = new PortalStore(join(dir, 'ledger.sqlite'), 'https://pluto.example', 11155111);
  const authority = Symbol('service'), ledger = new SponsorBudget(store, authority);
  const author = privateKeyToAccount('0x' + '12'.repeat(32));
  const address = n => toHex(BigInt(n), { size: 20 }), hash = n => toHex(BigInt(n), { size: 32 });
  const payer = address(2), market = address(3), nil = address(4), registry = address(5), id = hash(6), blockHash = hash(7);
  const { DisclosureRegistry } = await compileContracts();
  const chain = { payer, market, nil, registry, registryAbi: DisclosureRegistry.abi };
  const grant = { researcher: author.address, payer, nonce: 1n, deadline: 1500n, signature: '0x' };
  const args = { mode: 'PUBLIC_CONDITION', ttl: 0, k: 2, ceilingWei: 5n, hook: registry, t1: 1600n, t2: 5200n,
    publicCondition: compileCondition({ window: { t1: 1600n, t2: 5200n } }), commit: hash(8),
    keys: [1n, 2n, 3n].map(keyId => ({ keyId, nodeId: keyId, mpk: '0x01' })), layers: [1, 2, 3].map(() => new Uint8Array(230)), hookGasLimit: 250000 };
  const post = { to: market, data: encodeFunctionData({ abi: triggerMarketAbi, functionName: 'postTriggerSponsored', args: [postParamsTuple(args), { author: author.address, payer, minCeiling: 5n, nonce: 0n, deadline: 1500n, signature: '0x' }] }), value: 200n, gasUnits: 20n, maxFeePerGas: 2n, nilUnits: 25n };
  const register = { ...post, to: registry, value: 0n, nilUnits: 0n, data: encodeFunctionData({ abi: DisclosureRegistry.abi, functionName: 'registerBySig', args: [hash(8), hash(8), 1600n, 5200n, grant] }) };
  const bind = { ...register, data: encodeFunctionData({ abi: DisclosureRegistry.abi, functionName: 'bindBySig', args: [id, 7n, { ...grant, nonce: 2n }] }) };
  const transactions = new Map(), receipts = new Map();
  let finalized = 20n, canonical = true;
  const pub = { getChainId: async () => 11155111,
    getBlock: async ({ blockNumber } = {}) => ({ number: blockNumber ?? finalized, hash: !canonical && blockNumber === 10n ? hash(9) : blockHash, timestamp: 6000n }),
    getTransaction: async ({ hash }) => transactions.get(hash), getTransactionReceipt: async ({ hash }) => receipts.get(hash),
    readContract: async () => [author.address, payer] };
  const event = (abi, eventName, eventArgs, target) => {
    const e = abi.find(entry => entry.type === 'event' && entry.name === eventName);
    return { address: target, topics: encodeEventTopics({ abi, eventName, args: eventArgs }), data: encodeAbiParameters(e.inputs.filter(i => !i.indexed), e.inputs.filter(i => !i.indexed).map(i => eventArgs[i.name])), removed: false };
  };
  const broadcast = (action, call, status, logs = []) => {
    const h = hash(100 + receipts.size);
    ledger.startAction(authority, id, action, call); ledger.recordHash(authority, id, action, h);
    transactions.set(h, { hash: h, from: payer, to: call.to, input: call.data, value: call.value, gas: call.gasUnits, maxFeePerGas: call.maxFeePerGas });
    receipts.set(h, { transactionHash: h, status, blockNumber: 10n, blockHash, gasUsed: 10n, effectiveGasPrice: 2n, logs }); return h;
  };
  try {
    store.enrollVerifiedProtocol('alpha.example', author.address);
    const challenge = store.challenge(author.address), session = await store.authenticate(challenge.id, await author.signMessage({ message: challenge.message }));
    ledger.configure(session, 'alpha.example', { ethWei: 1000n, nilUnits: 100n, perPostWei: 500n, perPostNil: 50n });
    ledger.reserve(authority, 'alpha.example', { id, requestHash: hash(8), author: author.address, nonce: '0', ethWei: 360n, nilUnits: 40n }, { payer, market, nil, ethWei: 1000n, nilUnits: 100n, blockNumber: 10n, blockHash });
    ledger.begin(authority, id); broadcast('register', register, 'success');
    const first = broadcast('post', post, 'reverted');
    assert.throws(() => ledger.startAction(authority, id, 'post:1', post), /verified final revert/);
    receipts.get(first).status = 'unknown';
    await assert.rejects(ledger.provePostRevert(authority, id, pub, chain), /proof/);
    receipts.get(first).status = 'reverted';
    finalized = 9n;
    await assert.rejects(ledger.provePostRevert(authority, id, pub, chain), /proof/);
    finalized = 20n; canonical = false;
    await assert.rejects(ledger.provePostRevert(authority, id, pub, chain), /proof/);
    canonical = true; transactions.get(first).from = author.address;
    await assert.rejects(ledger.provePostRevert(authority, id, pub, chain), /proof/);
    transactions.get(first).from = payer;
    await ledger.provePostRevert(authority, id, pub, chain);
    await ledger.provePostRevert(authority, id, pub, chain);
    await assert.rejects(ledger.provePostRevert(authority, id, pub, { ...chain, market: nil }), /context mismatch/);
    assert.equal(ledger.summary(session, 'alpha.example').reserved_eth, '360');
    const posted = event(triggerMarketAbi, 'TriggerPosted', { triggerId: 7n, author: author.address, mode: 1, keyIds: [1n, 2n, 3n], k: 2, expiry: 5200n, commit: hash(8), ceiling: 5n, t1: 1600n, t2: 5200n, publicCondition: '0x', layers: [] }, market);
    broadcast('post:1', post, 'success', [posted, event(nilAbi, 'Transfer', { from: payer, to: market, value: 25n }, nil)]);
    assert.throws(() => ledger.startAction(authority, id, 'post:2', post), /Invalid transaction action/);
    assert.throws(() => ledger.closeSubmission(authority, id), /retain binding/);
    assert.equal((await ledger.reconcile(authority, id, pub, chain)).pendingBinding, true);
    broadcast('bind', bind, 'success');
    await ledger.reconcile(authority, id, pub, chain);
    assert.equal(ledger.intent(authority, id).state, 'confirmed');
    assert.equal(ledger.summary(session, 'alpha.example').eth, '920');
    assert.equal(ledger.summary(session, 'alpha.example').nil, '75');
    assert.equal(ledger.summary(session, 'alpha.example').reserved_eth, '200');
    await ledger.reconcile(authority, id, pub, chain);
    assert.equal(ledger.summary(session, 'alpha.example').eth, '920');
  } finally { store.close(); await rm(dir, { recursive: true }); }
});
