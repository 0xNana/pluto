import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractFunctionRevertedError, RpcRequestError, createPublicClient, custom, encodeAbiParameters, encodeErrorResult, encodeEventTopics, encodeFunctionData,
  encodeFunctionResult, keccak256, parseAbi, toHex } from 'viem';
import { triggerMarketAbi } from '@nillion/covenants-sdk';
import { postParamsTuple } from '@nillion/covenants-sdk/browser';
import { compileContracts } from '../scripts/lib/contracts.mjs';
import { json, publicFailure, revertedName } from '../scripts/lib/probe-runtime.mjs';
import { encodeDisclosurePayload, reportIdFor } from '../src/shared/disclosure.mjs';
import { rejectionPayload } from '../scripts/lib/adversarial-probes.mjs';
import { observeAdversarialCase, runAdversarialObserveCommand } from '../scripts/observe-adversarial-sepolia.mjs';

let artifact;
before(async () => { artifact = (await compileContracts()).DisclosureRegistry; });
const market = '0x1111111111111111111111111111111111111111';
const hook = '0x2222222222222222222222222222222222222222';
const payer = '0x3333333333333333333333333333333333333333';
const nil = '0x4444444444444444444444444444444444444444';
const collector = '0x5555555555555555555555555555555555555555';
const postHash = toHex(1n, { size: 32 }), revealHash = toHex(2n, { size: 32 }), registerHash = toHex(3n, { size: 32 });
const zero = toHex(0n, { size: 32 });
function raw(address, abi, eventName, args, blockNumber, transactionHash) {
  const fields = abi.find(item => item.type === 'event' && item.name === eventName).inputs.filter(field => !field.indexed);
  return { address, topics: encodeEventTopics({ abi, eventName, args }),
    data: encodeAbiParameters(fields, fields.map(field => args[field.name])), blockNumber, transactionHash };
}
function fixture(scenario = 'unbound') {
  const key = new Uint8Array(32).fill(7), cipherHash = keccak256('0x1234');
  const reportId = reportIdFor(payer, cipherHash, keccak256(key));
  const payload = `${toHex(rejectionPayload(scenario, key, reportId))}${'33'.repeat(32)}`;
  const params = postParamsTuple({ mode: 1, t1: 1600n, t2: 5200n, ttl: 0n, keys: [1n, 2n, 3n].map(keyId => ({ keyId })), k: 2,
    layers: [new Uint8Array(230), new Uint8Array(230), new Uint8Array(230)], commit: keccak256(payload),
    publicCondition: '0x', ceilingWei: 90n, hook, hookGasLimit: 250000 });
  const reason = scenario === 'wrong-key' ? 5 : 1;
  const entry = { scenario, expectedReason: reason, reportId, cipherHash, keyCommit: keccak256(key),
    author: payer, payer, hook, triggerId: '2', postBlock: '10', window: { t1: '1600', t2: '5200' },
    commit: params.commit, escrowWei: '1000', feeNil: '25', status: 'posted-awaiting-rejection',
    transactions: [{ call: 'register', hash: registerHash }, { call: 'postTrigger', hash: postHash }] };
  const record = { researcher: payer, cipherHash, keyCommit: entry.keyCommit, registeredAt: 1000n, t1: 1600n, t2: 5200n,
    rootReportId: reportId, parentReportId: zero, disclosed: false,
    lastTriggerId: scenario === 'wrong-key' ? 2n : 0n, bindTime: 1100n };
  const rejected = raw(hook, artifact.abi, 'Rejected', { triggerId: 2n, reason }, 12n, revealHash);
  const marketEvents = [
    { address: market, eventName: 'SharePosted', args: { triggerId: 2n }, blockNumber: 11n },
    { address: market, eventName: 'TriggerResolved', args: { triggerId: 2n, plaintext: payload }, blockNumber: 12n, transactionHash: revealHash },
    { address: market, eventName: 'RefundIssued', args: { triggerId: 2n, amount: 400n }, blockNumber: 12n, transactionHash: revealHash }
  ];
  const hookEvents = [{ address: hook, eventName: 'Rejected', args: { triggerId: 2n, reason }, blockNumber: 12n, transactionHash: revealHash }];
  const transferAbi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
  const receipts = new Map([
    [registerHash, { transactionHash: registerHash, blockNumber: 3n, from: payer, status: 'success', gasUsed: 50n, effectiveGasPrice: 1n,
      logs: [raw(hook, artifact.abi, 'Registered', { reportId, researcher: payer, cipherHash, keyCommit: entry.keyCommit, t1: 1600n, t2: 5200n }, 3n, registerHash)] }],
    [postHash, { transactionHash: postHash, blockNumber: 10n, from: payer, status: 'success', gasUsed: 50n, effectiveGasPrice: 1n,
      logs: [raw(market, triggerMarketAbi, 'TriggerPosted', { ...params, triggerId: 2n, author: payer, expiry: 5200n }, 10n, postHash),
        raw(nil, transferAbi, 'Transfer', { from: payer, to: collector, value: 25n }, 10n, postHash)] }],
    [revealHash, { transactionHash: revealHash, blockNumber: 12n, from: collector, status: 'success', gasUsed: 50n, effectiveGasPrice: 1n,
      logs: [raw(market, triggerMarketAbi, 'TriggerResolved', { triggerId: 2n, plaintext: payload, usedSlots: [0, 1], reconstructor: collector }, 12n, revealHash),
        raw(market, triggerMarketAbi, 'HookInvoked', { triggerId: 2n, ok: true }, 12n, revealHash), rejected] }]
  ]);
  let traceCalls = 0;
  const pub = {
    readContract: async ({ functionName }) => {
      if (functionName === 'postingParties') return [payer, payer];
      if (functionName === 'hookMeta') return [hook, 250000];
      if (functionName === 'triggerMeta') return [1, 2, 3, 5200n, 1600n, 5200n, params.commit, 90n, true, 1601n, 0n, 0n];
      if (functionName === 'statusOf') return record;
      if (functionName === 'bindings') return scenario === 'wrong-key' ? [reportId, true] : [zero, false];
      if (functionName === 'lineageDisclosed') return false;
      throw new Error('Unexpected fixture read');
    },
    getTransaction: async () => ({ to: market, from: payer, value: 1000n,
      input: encodeFunctionData({ abi: triggerMarketAbi, functionName: 'postTrigger', args: [params] }) }),
    getTransactionReceipt: async ({ hash }) => receipts.get(hash),
    getContractEvents: async ({ address }) => address === market ? marketEvents : hookEvents,
    getBlock: async ({ blockNumber } = {}) => ({ number: blockNumber ?? 20n, timestamp: blockNumber === 11n ? 1601n : 1602n }),
    request: async () => { traceCalls++; return { type: 'CALL', from: market, to: hook, gas: '0x3d090', gasUsed: '0x2a9c',
      input: encodeFunctionData({ abi: artifact.abi, functionName: 'onReveal', args: [2n, payload] }),
      output: encodeFunctionResult({ abi: artifact.abi, functionName: 'onReveal', result: '0xd8e071b6' }) }; }
  };
  return { pub, entry, context: { addresses: { market, nil }, artifact, latest: { number: 20n, timestamp: 1700n } },
    record, receipts, marketEvents, hookEvents, payload, params, traceCalls: () => traceCalls };
}

test('live rejection observer verifies actual ABI receipts, trace, undisclosed state, NIL debit and escrow', async () => {
  const f = fixture();
  const result = await observeAdversarialCase(f.pub, f.context, f.entry);
  assert.equal(result.measurementsComplete, true);
  assert.equal(result.expectedRejectionVerified, true);
  assert.equal(result.hookTrace.ack, '0xd8e071b6');
  assert.equal(result.hookTrace.gasUsed, 10908n);
  assert.equal(result.refundReconciliation.paidWei, 400n);
  assert.equal(result.nilDebit, 25n);
  assert.equal(result.unauthorizedDisclosure, false);
});

test('bound wrong-key rejection leaves the report undisclosed and requires its actual binding', async () => {
  const f = fixture('wrong-key');
  assert.equal((await observeAdversarialCase(f.pub, f.context, f.entry)).reason, 5);
  const read = f.pub.readContract;
  f.pub.readContract = request => request.functionName === 'bindings' ? [zero, false] : read(request);
  await assert.rejects(observeAdversarialCase(f.pub, f.context, f.entry), /binding/);
});

function copiedFixture() {
  const f = fixture();
  Object.assign(f.entry, { scenario: 'copy-foreign', author: collector,
    transactions: [{ call: 'postTriggerSponsored', hash: postHash }] });
  Object.assign(f.record, { disclosed: true, lastTriggerId: 1n });
  Object.assign(f.context, { source: { ...f.entry, triggerId: '1', researcher: payer },
    sourceParams: f.params, sourcePlaintext: new Uint8Array([...encodeDisclosurePayload(new Uint8Array(32).fill(7), f.entry.reportId),
      ...new Uint8Array(32).fill(0x33)]) });
  const read = f.pub.readContract;
  f.pub.readContract = request => {
    if (request.functionName === 'postingParties') return [collector, payer];
    if (request.functionName === 'bindings') return request.args[0] === 1n ? [f.entry.reportId, true] : [zero, false];
    return read(request);
  };
  f.pub.simulateContract = async () => { throw new ContractFunctionRevertedError({ abi: artifact.abi,
    data: encodeErrorResult({ abi: artifact.abi, errorName: 'Unauthorized' }), functionName: 'bindTrigger' }); };
  f.pub.getTransaction = async () => ({ to: market, from: payer, value: 1000n,
    input: encodeFunctionData({ abi: triggerMarketAbi, functionName: 'postTriggerSponsored', args: [f.params,
      { author: collector, payer, minCeiling: 90n, nonce: 0n, deadline: 1599n, signature: '0x' }] }) });
  return f;
}

test('copied payload verifies preserved original binding and rejects changed encrypted layers', async () => {
  const f = copiedFixture();
  const result = await observeAdversarialCase(f.pub, f.context, f.entry);
  assert.equal(result.measurementsComplete, true);
  assert.equal(result.originalBindingPreserved, true);
  assert.equal(result.foreignBindingRejection, 'Unauthorized');
  f.context.sourceParams = { ...f.params, layers: ['0x01', ...f.params.layers.slice(1)] };
  await assert.rejects(observeAdversarialCase(f.pub, f.context, f.entry), /encrypted layers/);
});

function providerSimulator(data, code = 15) {
  return createPublicClient({ transport: custom({ request: async body => {
    throw new RpcRequestError({ body, url: 'https://user:secret@rpc.invalid/token',
      error: { code, data, message: 'execution reverted; private-calldata' } });
  } }, { retryCount: 0 }) });
}

test('foreign binding accepts only ABI-proved Unauthorized despite a provider-specific revert code', async () => {
  const encoded = encodeErrorResult({ abi: artifact.abi, errorName: 'Unauthorized' });
  for (const code of [3, -32603, 15]) for (const data of [encoded, { data: encoded }]) {
    const f = copiedFixture();
    const simulator = providerSimulator(data, code);
    // Reproduce using the installed viem decoder, rather than a pre-decoded revert stub.
    let nativeError;
    try { await simulator.simulateContract({ account: collector, address: hook, abi: artifact.abi,
      functionName: 'bindTrigger', args: [f.entry.reportId, 2n] }); }
    catch (error) { nativeError = error; }
    assert.ok(nativeError);
    assert.equal(revertedName(nativeError), code === 15 ? undefined : 'Unauthorized');
    f.pub.simulateContract = request => simulator.simulateContract(request);
    const result = await observeAdversarialCase(f.pub, f.context, f.entry);
    assert.equal(result.measurementsComplete, true);
    assert.equal(result.foreignBindingRejection, 'Unauthorized');
  }
});

test('foreign binding fails closed on missing, malformed, unrelated or noncanonical revert data and redacts diagnostics', async () => {
  const unauthorized = encodeErrorResult({ abi: artifact.abi, errorName: 'Unauthorized' });
  for (const code of [3, -32603, 15]) for (const data of [undefined, '0x', '0x12345678', `${unauthorized}00`,
    encodeErrorResult({ abi: artifact.abi, errorName: 'InvalidWindow' }), { data: 'private-calldata' }]) {
    const f = copiedFixture();
    const simulator = providerSimulator(data, code);
    f.pub.simulateContract = request => simulator.simulateContract(request);
    await assert.rejects(observeAdversarialCase(f.pub, f.context, f.entry), error => {
      const failure = publicFailure(error);
      assert.match(failure.detail, /foreign bind simulation/);
      assert.ok(failure.codes.includes(code));
      assert.doesNotMatch(json(failure), /secret|rpc\.invalid|private-calldata|user:|token/);
      return true;
    });
  }
});

test('case read failures identify the exact operation without exposing RPC bodies', async () => {
  const f = fixture();
  const read = f.pub.readContract;
  f.pub.readContract = request => request.functionName === 'hookMeta'
    ? Promise.reject(Object.assign(new Error('https://user:secret@rpc.invalid private-calldata'), { code: 15 }))
    : read(request);
  await assert.rejects(observeAdversarialCase(f.pub, f.context, f.entry), error => {
    const failure = publicFailure(error);
    assert.match(failure.detail, /market hookMeta/);
    assert.deepEqual(failure.codes, [15]);
    assert.doesNotMatch(json(failure), /secret|rpc\.invalid|private-calldata|user:/);
    return true;
  });
});

test('ACK alone cannot pass rejection acceptance; state changes and removed or unexpected events fail', async () => {
  for (const mutate of [
    f => { f.receipts.get(revealHash).logs.pop(); },
    f => { f.record.disclosed = true; },
    f => { f.hookEvents.push({ ...f.hookEvents[0], eventName: 'Disclosed' }); },
    f => { f.marketEvents[1].removed = true; },
    f => { f.receipts.get(postHash).from = collector; }
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(observeAdversarialCase(f.pub, f.context, f.entry));
  }
});

test('pending reveals and unavailable traces stay incomplete and do not expose RPC credentials', async () => {
  const pending = fixture(); pending.marketEvents.length = 0; pending.hookEvents.length = 0;
  const result = await observeAdversarialCase(pending.pub, pending.context, pending.entry);
  assert.equal(result.measurementsComplete, false);
  assert.equal(pending.traceCalls(), 0);
  const untraced = fixture();
  untraced.pub.request = async () => { throw new Error('https://rpc.invalid/secret-token'); };
  const partial = await observeAdversarialCase(untraced.pub, untraced.context, untraced.entry);
  assert.equal(partial.measurementsComplete, false);
  assert.doesNotMatch(json(partial), /secret-token/);
});

test('adversarial observation guards wrong chain and output collisions before reading source or querying evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pluto-rejection-observer-'));
  try {
    const out = join(dir, 'proof.json');
    const options = { client: () => ({ getChainId: async () => 1 }), print: () => {}, diagnostic: () => {} };
    assert.equal(await runAdversarialObserveCommand(['--source', 'missing', '--out', out], options), 1);
    const evidence = JSON.parse(await readFile(out, 'utf8'));
    assert.match(evidence.failure.detail, /Sepolia/);
    assert.equal(evidence.observerVersion, 2);
    assert.ok(Number.isFinite(Date.parse(evidence.startedAt)));
    await writeFile(out, 'keep');
    assert.equal(await runAdversarialObserveCommand(['--source', 'missing', '--out', out], options), 1);
    assert.equal(await readFile(out, 'utf8'), 'keep');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
