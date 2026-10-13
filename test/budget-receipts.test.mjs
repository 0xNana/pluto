import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, encodeEventTopics, encodeAbiParameters, keccak256 } from 'viem';
import { triggerMarketAbi, nilAbi, compileCondition } from '@nillion/covenants-sdk';
import { postParamsTuple } from '@nillion/covenants-sdk/browser';
import { compileContracts } from '../scripts/lib/contracts.mjs';
import { PortalStore } from '../packages/portal/store.mts';
import { SponsorBudget } from '../packages/relayer/budget.mts';

test('T-14 ledger retains incomplete/unfinalized submissions and reconciles receipt costs and final refunds idempotently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pluto-ledger-')); await chmod(dir, 0o700);
  const store = new PortalStore(join(dir, 'ledger.sqlite'), 'https://pluto.example', 11155111);
  const authority = Symbol('trusted-service'), ledger = new SponsorBudget(store, authority);
  const author = privateKeyToAccount('0x' + '12'.repeat(32)), payer = '0x' + '34'.repeat(20), market = '0x' + '56'.repeat(20), registry = '0x' + '78'.repeat(20), nil = '0x' + '90'.repeat(20);
  const h = '0x' + 'ab'.repeat(32), reportId = '0x' + 'cd'.repeat(32), blockHash = '0x' + 'ef'.repeat(32);
  const { DisclosureRegistry } = await compileContracts();
  const chain = { payer, market, registry, nil, registryAbi: DisclosureRegistry.abi };
  const pool = { payer, market, nil, ethWei: 10000n, nilUnits: 1000n, blockNumber: 10n, blockHash };
  const transactions = new Map(), receipts = new Map();
  let finalized = 20n, terminal = false;
  const pub = { getChainId: async () => 11155111, getBlock: async ({ blockNumber } = {}) => ({ number: blockNumber ?? finalized, hash: blockHash, timestamp: 6000n }),
    getTransaction: async ({ hash }) => { assert.throws(() => ledger.startAction(authority, reportId, 'approve', { to: nil, data: '0x', value: 0n, gasUnits: 1n, maxFeePerGas: 1n, nilUnits: 0n }), /state mismatch/); return transactions.get(hash); }, getTransactionReceipt: async ({ hash }) => receipts.get(hash),
    readContract: async ({ functionName }) => functionName === 'postingParties' ? [author.address, payer] : [1, 2, 3, 5200n, 1600n, 5200n, h, 5n, terminal, 0n, terminal ? 0n : 200n, 0n],
    getContractEvents: async ({ eventName }) => [{ address: market, args: { triggerId: 7n, amount: eventName === 'RefundIssued' ? 50n : 100n }, transactionHash: h, logIndex: eventName === 'RefundIssued' ? 1 : 2, blockNumber: 15n, blockHash, removed: false }] };
  const event = (abi, name, args, address) => {
    const definition = abi.find(e => e.type === 'event' && e.name === name);
    return { address, topics: encodeEventTopics({ abi, eventName: name, args }), data: encodeAbiParameters(definition.inputs.filter(i => !i.indexed), definition.inputs.filter(i => !i.indexed).map(i => args[i.name])), removed: false };
  };
  try {
    store.enrollVerifiedProtocol('alpha.example', author.address);
    const c = store.challenge(author.address), session = await store.authenticate(c.id, await author.signMessage({ message: c.message }));
    ledger.configure(session, 'alpha.example', { ethWei: 1000n, nilUnits: 100n, perPostWei: 500n, perPostNil: 50n });
    ledger.reserve(authority, 'alpha.example', { id: reportId, requestHash: h, author: author.address, nonce: '0', ethWei: 400n, nilUnits: 40n }, pool);
    ledger.begin(authority, reportId);
    const registerGrant = { researcher: author.address, payer, nonce: 1n, deadline: 1500n, signature: '0x' };
    const args = { mode: 'PUBLIC_CONDITION', ttl: 0, k: 2, ceilingWei: 5n, hook: registry, t1: 1600n, t2: 5200n, publicCondition: compileCondition({ window: { t1: 1600n, t2: 5200n } }), commit: h, keys: [1n, 2n, 3n].map(keyId => ({ keyId, nodeId: keyId, mpk: '0x01' })), layers: [1, 2, 3].map(() => new Uint8Array(230)), hookGasLimit: 250000 };
    assert.throws(() => ledger.startAction(authority, reportId, 'post', { to: market, data: '0x', value: 500n, gasUnits: 1n, maxFeePerGas: 1n, nilUnits: 0n }), /spending ceiling/);
    assert.throws(() => ledger.startAction(authority, reportId, 'register', { to: registry, data: '0x', value: 0n, gasUnits: 500n, maxFeePerGas: 1n, nilUnits: 0n }), /spending ceiling/);
    assert.throws(() => ledger.startAction(authority, reportId, 'post', { to: market, data: '0x', value: 0n, gasUnits: 1n, maxFeePerGas: 1n, nilUnits: 41n }), /NIL ceiling/);
    const calls = [
      ['register', registry, encodeFunctionData({ abi: DisclosureRegistry.abi, functionName: 'registerBySig', args: [h, h, 1600n, 5200n, registerGrant] }), 0n],
      ['post', market, encodeFunctionData({ abi: triggerMarketAbi, functionName: 'postTriggerSponsored', args: [postParamsTuple(args), { author: author.address, payer, minCeiling: 5n, nonce: 0n, deadline: 1500n, signature: '0x' }] }), 200n],
      ['bind', registry, encodeFunctionData({ abi: DisclosureRegistry.abi, functionName: 'bindBySig', args: [reportId, 7n, { ...registerGrant, nonce: 2n }] }), 0n],
    ];
    for (const [index, [action, to, input, value]] of calls.entries()) {
      if (action === 'bind') {
        assert.equal((await ledger.reconcile(authority, reportId, pub, chain)).pendingBinding, true);
        assert.throws(() => ledger.closeSubmission(authority, reportId), /retain binding/);
        const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve: value => resolve(value) }; };
        const oldEntered = deferred(), oldRelease = deferred(), newEntered = deferred(), newRelease = deferred();
        let oldFirst = true, newFirst = true;
        const oldPub = { ...pub, getTransaction: async request => { if (oldFirst) { oldFirst = false; oldEntered.resolve(); await oldRelease.promise; } return pub.getTransaction(request); } };
        const newPub = { ...pub, getTransaction: async request => { if (newFirst) { newFirst = false; newEntered.resolve(); await newRelease.promise; } return pub.getTransaction(request); } };
        const oldProof = ledger.reconcile(authority, reportId, oldPub, chain);
        await oldEntered.promise;
        assert.equal((await ledger.reconcile(authority, reportId, pub, chain)).pendingBinding, true);
        const newProof = ledger.reconcile(authority, reportId, newPub, chain);
        await newEntered.promise; oldRelease.resolve();
        await assert.rejects(oldProof, /superseded/);
        assert.equal(ledger.intent(authority, reportId).state, 'reconciling');
        newRelease.resolve(); assert.equal((await newProof).pendingBinding, true);
      }
      const hash = '0x' + String(index + 1).repeat(64);
      ledger.startAction(authority, reportId, action, { to, data: input, value, gasUnits: 20n, maxFeePerGas: 2n, nilUnits: action === 'post' ? 25n : 0n });
      await assert.rejects(ledger.reconcile(authority, reportId, pub, chain), /incomplete|unresolved/);
      ledger.recordHash(authority, reportId, action, hash);
      transactions.set(hash, { hash, to, input, value, from: payer, gas: 20n, maxFeePerGas: 2n });
      receipts.set(hash, { transactionHash: hash, blockHash, blockNumber: 10n, status: 'success', gasUsed: 10n, effectiveGasPrice: 2n, logs: action === 'post' ? [
        event(triggerMarketAbi, 'TriggerPosted', { triggerId: 7n, author: author.address, mode: 1, keyIds: [1n, 2n, 3n], k: 2, expiry: 5200n, commit: h, ceiling: 5n, t1: 1600n, t2: 5200n, publicCondition: '0x', layers: [] }, market),
        event(nilAbi, 'Transfer', { from: payer, to: market, value: 25n }, nil),
      ] : [] });
    }
    finalized = 9n; await assert.rejects(ledger.reconcile(authority, reportId, pub, chain), /proof/);
    assert.equal(ledger.summary(session, 'alpha.example').reserved_eth, '400');
    finalized = 20n;
    const firstBindHash = '0x' + '3'.repeat(64);
    receipts.get(firstBindHash).status = 'reverted';
    assert.equal((await ledger.reconcile(authority, reportId, pub, chain)).pendingBinding, true);
    assert.equal(ledger.summary(session, 'alpha.example').reserved_eth, '400');
    assert.throws(() => ledger.closeSubmission(authority, reportId), /retain binding/);
    const recoveryHash = '0x' + '4'.repeat(64);
    store.setEnabled(session, 'alpha.example', false);
    ledger.startAction(authority, reportId, 'bind:1', { to: registry, data: calls[2][2], value: 0n, gasUnits: 20n, maxFeePerGas: 2n, nilUnits: 0n });
    ledger.recordHash(authority, reportId, 'bind:1', recoveryHash);
    transactions.set(recoveryHash, { ...transactions.get(firstBindHash), hash: recoveryHash });
    receipts.set(recoveryHash, { ...receipts.get(firstBindHash), transactionHash: recoveryHash, status: 'success' });
    await ledger.reconcile(authority, reportId, pub, chain);
    // Fixture administration only: restore access to inspect the ledger. The
    // production API has no route that can reverse disabled-account state.
    store.db.prepare('UPDATE protocols SET enabled=1 WHERE id=?').run('alpha.example');
    assert.equal(ledger.intent(authority, reportId).state, 'confirmed');
    assert.equal(ledger.summary(session, 'alpha.example').eth, '920');
    assert.equal(ledger.summary(session, 'alpha.example').reserved_eth, '200');
    await ledger.reconcile(authority, reportId, pub, chain);
    await assert.rejects(ledger.finalizeEscrow(authority, reportId, pub, chain), /unresolved/);
    await assert.rejects(ledger.finalizeEscrow(authority, reportId, pub, { ...chain, market: nil }), /context mismatch/);
    terminal = true; await ledger.finalizeEscrow(authority, reportId, pub, chain);
    await ledger.finalizeEscrow(authority, reportId, pub, chain);
    assert.equal(ledger.summary(session, 'alpha.example').eth, '870');
    assert.equal(ledger.summary(session, 'alpha.example').reserved_eth, '0');
    assert.equal(ledger.summary(session, 'alpha.example').nil, '75');
    // A definitively reverted early action charges its gas, releases unused
    // exposure, and cannot be confused with a successful report submission.
    const failedId = '0x' + '44'.repeat(32), failedHash = '0x' + '55'.repeat(32);
    ledger.reserve(authority, 'alpha.example', { id: failedId, requestHash: h, author: author.address, nonce: '1', ethWei: 400n, nilUnits: 40n }, pool);
    ledger.begin(authority, failedId);
    ledger.startAction(authority, failedId, 'register', { to: registry, data: calls[0][2], value: 0n, gasUnits: 20n, maxFeePerGas: 2n, nilUnits: 0n });
    ledger.closeSubmission(authority, failedId);
    await assert.rejects(ledger.reconcile(authority, failedId, pub, chain), /unresolved/);
    ledger.recordHash(authority, failedId, 'register', failedHash);
    transactions.set(failedHash, { ...transactions.get('0x' + '1'.repeat(64)), hash: failedHash });
    receipts.set(failedHash, { ...receipts.get('0x' + '1'.repeat(64)), transactionHash: failedHash, status: 'reverted' });
    await ledger.reconcile(authority, failedId, pub, chain);
    assert.equal(ledger.intent(authority, failedId).state, 'failed');
    assert.equal(ledger.summary(session, 'alpha.example').eth, '850');
    assert.equal(ledger.summary(session, 'alpha.example').reserved_eth, '0');
  } finally { store.close(); await rm(dir, { recursive: true }); }
});
