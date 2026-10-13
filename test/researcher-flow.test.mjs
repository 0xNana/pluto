import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { ContractFunctionRevertedError, encodeAbiParameters, encodeErrorResult, encodeEventTopics, getAddress, hexToBytes, toHex } from 'viem';
import { mpkFromSecret, openLayer, reconstruct, selectCommittee, triggerMarketAbi } from '@nillion/covenants-sdk';
import { prepareReport } from '../src/shared/report-crypto.mjs';
import { postReport, bindReport, readReportStatus, verifyDisclosedReport } from '../src/chain/researcher-flow.mjs';
import { compileContracts } from '../scripts/lib/contracts.mjs';
import { evmHarness } from './support/evm.mjs';
import { marketMockSource } from './support/market.mjs';

let artifacts;
before(async () => { artifacts = await compileContracts({ 'MockMarket.sol': marketMockSource() }); });
const input = new TextEncoder().encode('M1 synthetic disclosure: independent decryption works.');
const secrets = [1, 2, 3].map(n => new Uint8Array(32).fill(n));
const mockModule = '0x4444444444444444444444444444444444444444';

async function setup() {
  const chain = await evmHarness();
  const market = await chain.deploy(artifacts.MockMarket);
  const registry = await chain.deploy(artifacts.DisclosureRegistry, [market.address]);
  const bundle = await prepareReport(input, chain.author);
  let timestamp = 1000n;
  let block = 10n;
  let allowance = 0n;
  let sequence = 0n;
  let post;
  let postId = -1n;
  let wrongHook = false;
  let failBind = false;
  let interruptPostWait = false;
  let wrongValueAttempts = 0;
  let ambiguousWrongValue = false;
  let postSimulations = 0;
  const receipts = new Map();
  const events = [];
  const network = [];
  const journal = [];
  const wallet = { account: { address: chain.author }, async writeContract(request) {
    // SDK writes may use the wallet default; simulated registry writes must
    // preserve its signer rather than select the RPC's address-only account.
    assert.equal(request.account ?? wallet.account, wallet.account, 'Preserve the wallet signer');
    network.push(request);
    if (request.functionName === 'postTrigger' && ambiguousWrongValue) {
      throw new ContractFunctionRevertedError({ abi: triggerMarketAbi,
        data: encodeErrorResult({ abi: triggerMarketAbi, errorName: 'WrongValue' }) });
    }
    if (request.functionName === 'bindTrigger' && failBind) throw new Error('submission failed');
    const hash = toHex(++sequence, { size: 32 });
    const logs = [];
    if (request.functionName === 'approve') allowance = request.args[1];
    else if (request.functionName === 'postTrigger') {
      post = request.args[0];
      postId++;
      await chain.call(market, 'setTrigger', [postId, chain.author, chain.author, registry.address, post.t1, post.t2, false]);
      const event = triggerMarketAbi.find(item => item.type === 'event' && item.name === 'TriggerPosted');
      const args = { ...post, triggerId: postId, author: chain.author, expiry: post.t2 };
      logs.push({ address: market.address, topics: encodeEventTopics({ abi: triggerMarketAbi, eventName: 'TriggerPosted', args }),
        data: encodeAbiParameters(event.inputs.filter(field => !field.indexed), event.inputs.filter(field => !field.indexed).map(field => args[field.name])) });
    } else {
      await chain.call(registry, request.functionName, request.args);
      for (const [address, topics, data] of chain.result().execResult.logs ?? []) {
        logs.push({ address: toHex(address), topics: topics.map(toHex), data: toHex(data) });
      }
    }
    const receipt = { transactionHash: hash, blockNumber: ++block, from: chain.author, status: 'success',
      gasUsed: 50000n, effectiveGasPrice: 1n, logs };
    receipts.set(hash, receipt);
    return hash;
  } };
  const pub = {
    getChainId: async () => 11155111,
    getBytecode: async () => '0x1234',
    getCode: async () => '0x1234',
    getBlock: async () => ({ number: block, timestamp, baseFeePerGas: 1n }),
    getBalance: async () => 10n ** 20n,
    waitForTransactionReceipt: async ({ hash }) => {
      if (interruptPostWait && network.find(call => call.functionName === 'postTrigger')) throw new Error('receipt connection lost');
      return receipts.get(hash);
    },
    getContractEvents: async () => events,
    simulateContract: async request => {
      if (request.functionName === 'postTrigger') {
        postSimulations++;
        if (wrongValueAttempts-- > 0) throw new ContractFunctionRevertedError({ abi: triggerMarketAbi,
          data: encodeErrorResult({ abi: triggerMarketAbi, errorName: 'WrongValue' }) });
      }
      return { request: { ...request, account: typeof request.account === 'string'
        ? { address: request.account, type: 'json-rpc' } : request.account } };
    },
    readContract: async request => {
      network.push(request);
      if (request.functionName === 'triggerMarket') return market.address;
      if (['staking', 'nodeRegistry', 'emissions', 'stakingToken'].includes(request.functionName)) return mockModule;
      if (request.address.toLowerCase() === registry.address.toLowerCase()) return chain.call(registry, request.functionName, request.args ?? []);
      if (['postingParties', 'hookMeta', 'triggerMeta'].includes(request.functionName)) {
        const result = [...await chain.call(market, request.functionName, request.args)];
        if (request.functionName === 'hookMeta' && wrongHook) result[0] = chain.foreign;
        if (request.functionName === 'triggerMeta') result[6] = post.commit;
        return result;
      }
      if (request.functionName === 'protocolFee') return 25n;
      if (request.functionName === 'balanceOf') return 1000n;
      if (request.functionName === 'allowance') return allowance;
      if (request.functionName === 'escrowMath') return mockModule;
      if (request.functionName === 'quoteEscrow') return request.args[5].toLowerCase() === registry.address.toLowerCase() ? 500n : 400n;
      throw new Error('Unexpected RPC read');
    },
  };
  const candidates = secrets.map((secret, index) => ({ nodeId: BigInt(index + 1), keyId: BigInt(index + 1),
    mpk: toHex(mpkFromSecret(secret)), expiresAt: 10000n, stake: 10n, fired: 0n, markup: 0,
    operator: toHex(BigInt(index + 1), { size: 20 }) }));
  const committee = selectCommittee(candidates, { m: 3, k: 2, minStake: 1n, nowUnix: timestamp, pick: 'top' });
  const plan = { addresses: { market: market.address, config: mockModule, nil: mockModule }, committee,
    parameters: { defaultHookGas: 250000, protocolFee: 25n }, ceilingWei: 6n, layerLength: 230n };
  const services = { inspect: async () => plan };
  const options = { pub, wallet, registry, expectedMarket: market.address, bundle, t1: 1600n, t2: 5200n,
    onProgress: async snapshot => { journal.push(structuredClone(snapshot)); } };
  return { chain, market, registry, bundle, pub, wallet, options, services, journal, network,
    setTime(value) { timestamp = value; chain.setTime(value); },
    setWrongHook() { wrongHook = true; }, setFailBind(value) { failBind = value; },
    interruptPostWait(value) { interruptPostWait = value; },
    rejectEscrow(count) { wrongValueAttempts = count; },
    ambiguousEscrowFailure() { ambiguousWrongValue = true; },
    simulations() { return postSimulations; },
    async reveal() {
      const shares = committee.keys.slice(0, 2).map((key, index) => openLayer(hexToBytes(post.layers[index]),
        secrets[Number(key.nodeId) - 1], hexToBytes(post.commit), 'PUBLIC_CONDITION').share);
      const plaintext = reconstruct(shares);
      await chain.call(registry, 'onReveal', [postId, toHex(plaintext)], market.address);
      const log = chain.result().execResult.logs[0];
      const { decodeEventLog } = await import('viem');
      events.push({ ...decodeEventLog({ abi: registry.abi, topics: log[1].map(toHex), data: toHex(log[2]) }),
        address: registry.address, blockNumber: ++block });
    },
  };
}

test('M1 wires real SDK sealing/posting and registry binding to independent report decryption', async () => {
  const fixture = await setup();
  const state = await postReport(fixture.options, fixture.services);
  assert.equal(state.state, 'bound');
  assert.equal(state.triggerId, 0n); // Zero is a valid market ID, not an absent binding.
  assert.equal((await readReportStatus({ ...fixture.options, reportId: state.reportId })).state, 'bound');
  const submitted = fixture.journal.filter(frame => frame.state === 'submitted');
  assert.ok(submitted.some(frame => frame.transactions.at(-1).call === 'postTrigger'));
  const serialized = JSON.stringify([...fixture.journal, ...fixture.network], (_key, value) => typeof value === 'bigint' ? String(value) : value);
  assert.ok(!serialized.includes(fixture.bundle.key.slice(2)));
  assert.ok(!serialized.includes(toHex(input).slice(2)));
  fixture.setTime(1601n);
  await fixture.reveal();
  const verified = await verifyDisclosedReport({ pub: fixture.pub, registry: fixture.registry,
    expectedMarket: fixture.market.address, reportId: state.reportId,
    fromBlock: state.registrationBlock, ciphertext: hexToBytes(fixture.bundle.ciphertext) });
  assert.deepEqual(verified.plaintext, input);
  assert.equal((await readReportStatus({ ...fixture.options, reportId: state.reportId })).state, 'disclosed');
});

test('FR-205 re-quotes and retries a decoded WrongValue once without duplicating registration', async () => {
  const fixture = await setup();
  fixture.rejectEscrow(1);
  const state = await postReport(fixture.options, fixture.services);
  assert.equal(state.state, 'bound');
  assert.equal(fixture.network.filter(call => call.functionName === 'register').length, 1);
  assert.equal(fixture.network.filter(call => call.functionName === 'postTrigger').length, 1);
  assert.equal(fixture.simulations(), 2);
  assert.equal(state.transactions.filter(tx => tx.call === 'postTrigger').length, 1);
  const failed = await setup();
  failed.rejectEscrow(2);
  await assert.rejects(postReport(failed.options, failed.services), error => error.data?.errorName === 'WrongValue');
  assert.equal(failed.network.filter(call => call.functionName === 'postTrigger').length, 0);
  assert.equal(failed.simulations(), 2);
});

test('FR-205 an ambiguous wallet WrongValue without a hash never causes a second send', async () => {
  const fixture = await setup(); fixture.ambiguousEscrowFailure();
  await assert.rejects(postReport(fixture.options, fixture.services), error => error.data?.errorName === 'WrongValue');
  assert.equal(fixture.network.filter(call => call.functionName === 'postTrigger').length, 1);
  assert.equal(fixture.simulations(), 1);
});

test('T-10 CLI flow re-arms an expired report with the same ciphertext and an immutable new ID', async () => {
  const fixture = await setup();
  const parent = await postReport(fixture.options, fixture.services);
  fixture.setTime(5201n);
  const retry = await postReport({ ...fixture.options, parentJournal: parent, t1: 6000n, t2: 9600n }, fixture.services);
  assert.notEqual(retry.reportId, parent.reportId);
  assert.equal(retry.parentReportId, parent.reportId);
  assert.equal(retry.rootReportId, fixture.bundle.reportId);
  assert.equal(retry.triggerId, 1n);
  assert.equal(retry.state, 'bound');
  assert.equal(retry.cipherHash, parent.cipherHash);
  const old = await fixture.chain.call(fixture.registry, 'statusOf', [parent.reportId]);
  assert.equal(old.t1, 1600n);
  assert.equal(old.t2, 5200n);
  fixture.setTime(6001n);
  await fixture.reveal();
  const verified = await verifyDisclosedReport({ ...fixture.options, reportId: retry.reportId,
    fromBlock: retry.registrationBlock, ciphertext: hexToBytes(fixture.bundle.ciphertext) });
  assert.deepEqual(verified.plaintext, input);
  assert.equal((await readReportStatus({ ...fixture.options, reportId: parent.reportId })).state, 'lineage-disclosed');
});

test('expiry retry refuses active, disclosed or altered parent journals before another transaction', async () => {
  const fixture = await setup();
  const parent = await postReport(fixture.options, fixture.services);
  const options = { ...fixture.options, t1: 6000n, t2: 9600n, parentJournal: parent };
  const before = fixture.journal.length;
  await assert.rejects(postReport(options, fixture.services), /expired/);
  fixture.setTime(5200n);
  await assert.rejects(postReport(options, fixture.services), /expired/);
  fixture.setTime(5201n);
  for (const changed of [{ ...parent, reportId: fixture.bundle.cipherHash },
    { ...parent, window: { t1: 1600n, t2: 5199n } }, { ...parent, registry: mockModule }]) {
    await assert.rejects(postReport({ ...options, parentJournal: changed }, fixture.services));
  }
  assert.equal(fixture.journal.length, before);
  await fixture.reveal();
  await assert.rejects(postReport(options, fixture.services), /disclosed/);
  assert.equal(fixture.journal.length, before);
});

test('retry bind recovery uses the retry ID and never re-registers or reposts', async () => {
  const fixture = await setup();
  const parent = await postReport(fixture.options, fixture.services);
  fixture.setTime(5201n);
  fixture.setFailBind(true);
  await assert.rejects(postReport({ ...fixture.options, parentJournal: parent, t1: 6000n, t2: 9600n }, fixture.services));
  const retry = fixture.journal.at(-1);
  assert.notEqual(retry.reportId, parent.reportId);
  fixture.setFailBind(false);
  const bound = await bindReport({ ...fixture.options, journal: JSON.parse(JSON.stringify(retry,
    (_name, value) => typeof value === 'bigint' ? String(value) : value)) });
  assert.equal(bound.state, 'bound');
  assert.equal(bound.triggerId, 1n);
  assert.equal(fixture.network.filter(call => call.functionName === 'registerRetry').length, 1);
  assert.equal(fixture.network.filter(call => call.functionName === 'postTrigger').length, 2);
  await assert.rejects(bindReport({ ...fixture.options, journal: { ...retry, parentReportId: fixture.bundle.cipherHash } }));
});

test('M1 refuses malformed recovery, wrong author/chain and narrow windows before sending', async () => {
  for (const change of [
    options => ({ ...options, bundle: { ...options.bundle, key: '0x12' } }),
    options => ({ ...options, wallet: { ...options.wallet, account: { address: mockModule } } }),
    options => ({ ...options, pub: { ...options.pub, getChainId: async () => 1 } }),
    options => ({ ...options, t2: 1700n }),
  ]) {
    const fixture = await setup();
    await assert.rejects(postReport(change(fixture.options), fixture.services));
    assert.equal(fixture.journal.length, 0);
  }
});

test('M1 preserves a posted trigger and blocks binding after hook mismatch or expired deadline', async () => {
  const fixture = await setup();
  fixture.setWrongHook();
  await assert.rejects(postReport(fixture.options, fixture.services), /hook/);
  const state = fixture.journal.at(-1);
  assert.equal(state.triggerId, 0n);
  assert.equal((await fixture.chain.call(fixture.registry, 'statusOf', [state.reportId])).bindTime, 0n);
  fixture.setTime(1600n);
  await assert.rejects(bindReport({ ...fixture.options, journal: state }), /window/);
});

test('M1 recovers a failed binding from its journal without registering or posting again', async () => {
  const fixture = await setup();
  fixture.setFailBind(true);
  await assert.rejects(postReport(fixture.options, fixture.services));
  const state = fixture.journal.at(-1);
  assert.equal(state.triggerId, 0n);
  fixture.setFailBind(false);
  const bound = await bindReport({ ...fixture.options, journal: state });
  assert.equal(bound.state, 'bound');
  assert.equal(fixture.network.filter(call => call.functionName === 'postTrigger').length, 1);
  assert.equal(fixture.network.filter(call => call.functionName === 'register').length, 1);
});

test('M1 verification rejects unavailable disclosure, changed ciphertext and pruned acceptance logs', async () => {
  const fixture = await setup();
  const state = await postReport(fixture.options, fixture.services);
  const options = { pub: fixture.pub, registry: fixture.registry, expectedMarket: fixture.market.address,
    reportId: state.reportId, fromBlock: state.registrationBlock, ciphertext: hexToBytes(fixture.bundle.ciphertext) };
  await assert.rejects(verifyDisclosedReport(options), /disclosed/);
  fixture.setTime(1601n);
  await fixture.reveal();
  await assert.rejects(verifyDisclosedReport({ ...options, ciphertext: new Uint8Array(32) }), /ciphertext/);
  await assert.rejects(verifyDisclosedReport({ ...options, pub: { ...fixture.pub, getContractEvents: async () => [] } }), /event/);
  const validEvents = await fixture.pub.getContractEvents();
  for (const invalid of [{ ...validEvents[0], removed: true },
    { ...validEvents[0], blockNumber: state.registrationBlock - 1n },
    { ...validEvents[0], blockNumber: 999n }]) {
    await assert.rejects(verifyDisclosedReport({ ...options,
      pub: { ...fixture.pub, getContractEvents: async () => [invalid] } }), /event/);
  }
});

test('M1 recovers an interrupted SDK posting receipt from the hash before a trigger ID is saved', async () => {
  const fixture = await setup();
  fixture.interruptPostWait(true);
  await assert.rejects(postReport(fixture.options, fixture.services), /connection lost/);
  const state = fixture.journal.at(-1);
  assert.equal(state.triggerId, undefined);
  assert.equal(state.transactions.at(-1).call, 'postTrigger');
  fixture.interruptPostWait(false);
  const bound = await bindReport({ ...fixture.options, journal: JSON.parse(JSON.stringify(state,
    (_key, value) => typeof value === 'bigint' ? String(value) : value)) });
  assert.equal(bound.triggerId, 0n);
  assert.equal(bound.state, 'bound');
  assert.equal(fixture.network.filter(call => call.functionName === 'postTrigger').length, 1);
});

test('M1 recovery refuses changed journal IDs/nonces and secret fields without another post or bind', async () => {
  const fixture = await setup();
  fixture.setFailBind(true);
  await assert.rejects(postReport(fixture.options, fixture.services));
  const state = fixture.journal.at(-1);
  fixture.setFailBind(false);
  const sends = () => fixture.network.filter(call => ['register', 'postTrigger', 'bindTrigger'].includes(call.functionName)).length;
  const before = sends();
  for (const changed of [
    { ...state, triggerId: 99n },
    { ...state, sealNonce: '0x' + '00'.repeat(32) },
    { ...state, key: fixture.bundle.key },
    { ...state, transactions: state.transactions.map(tx => ({ ...tx, key: fixture.bundle.key })) },
  ]) await assert.rejects(bindReport({ ...fixture.options, journal: changed }));
  assert.equal(sends(), before);
});
