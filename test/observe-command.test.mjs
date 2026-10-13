import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAddressFromString } from '@ethereumjs/util';
import { decodeEventLog, encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult, keccak256, toHex } from 'viem';
import { triggerMarketAbi } from '@nillion/covenants-sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { postParamsTuple } from '@nillion/covenants-sdk/browser';
import { compileDisclosureWindow, encodeDisclosurePayload, reportIdFor } from '../src/shared/disclosure.mjs';
import { runObserveCommand } from '../scripts/observe-sepolia.mjs';
import { json } from '../scripts/lib/probe-runtime.mjs';
import { compileContracts } from '../scripts/lib/contracts.mjs';
import { evmHarness } from './support/evm.mjs';
import { marketMockSource } from './support/market.mjs';

let artifacts;
before(async () => { artifacts = await compileContracts({ 'MockMarket.sol': marketMockSource() }); });
const postHash = toHex(1n, { size: 32 });
const revealHash = toHex(2n, { size: 32 });
function rawMarket(eventName, args) {
  const inputs = triggerMarketAbi.find(item => item.type === 'event' && item.name === eventName).inputs.filter(item => !item.indexed);
  return { topics: encodeEventTopics({ abi: triggerMarketAbi, eventName, args }),
    data: encodeAbiParameters(inputs, inputs.map(item => args[item.name])) };
}
async function fixture({ researcherMode = false, author } = {}) {
  const chain = await evmHarness();
  if (author) chain.author = author;
  if (researcherMode) await chain.evm.stateManager.putCode(createAddressFromString(chain.market),
    (await import('viem')).hexToBytes(artifacts.MockMarket.runtimeBytecode));
  const hook = await chain.deploy(researcherMode ? artifacts.DisclosureRegistry : artifacts.HelloRevealHook, [chain.market]);
  const key = new Uint8Array(32).fill(7);
  const cipherHash = keccak256('0x1234');
  const reportId = reportIdFor(chain.author, cipherHash, keccak256(key));
  const payload = `${toHex(encodeDisclosurePayload(key, reportId))}${'33'.repeat(32)}`;
  const window = compileDisclosureWindow({ nowUnix: 1000n, t1: 1600n, t2: 5200n });
  const params = postParamsTuple({ ...window, keys: [1n, 2n, 3n].map(keyId => ({ keyId })), k: 2,
    layers: [new Uint8Array(230), new Uint8Array(230), new Uint8Array(230)], commit: keccak256(payload),
    publicCondition: window.conditionRecord, ceilingWei: 90n, hook: hook.address, hookGasLimit: 250000 });
  const posted = { ...rawMarket('TriggerPosted', { ...params, triggerId: 0n, author: chain.author, expiry: 5200n }), address: chain.market };
  const receipt = (hash, block, logs = []) => ({ transactionHash: hash, blockNumber: block, from: chain.author,
    status: 'success', gasUsed: 50000n, effectiveGasPrice: 1n, logs });
  const evidence = { chainId: 11155111, mode: 'hello', market: chain.market, hook: hook.address,
    researcher: chain.author, payer: chain.author, reportId, cipherHash, keyCommit: keccak256(key),
    triggerId: '0', postBlock: '10', escrowWei: '1000', feeNil: '25', window: { t1: '1600', t2: '5200' },
    transactions: [{ call: 'postTrigger', hash: postHash, gasCostWei: '50000' }] };
  const receipts = new Map();
  if (researcherMode) {
    const market = { address: chain.market, abi: artifacts.MockMarket.abi };
    await chain.call(market, 'setTrigger', [0n, chain.author, chain.author, hook.address, 1600n, 5200n, false]);
    for (const [call, args, number] of [['register', [cipherHash, keccak256(key), 1600n, 5200n], 3n],
      ['bindTrigger', [reportId, 0n], 4n]]) {
      await chain.call(hook, call, args);
      const rawLogs = chain.result().execResult.logs.map(([address, topics, data]) =>
        ({ address: toHex(address), topics: topics.map(toHex), data: toHex(data) }));
      const hash = toHex(number, { size: 32 });
      receipts.set(hash, receipt(hash, number, rawLogs));
      evidence.transactions.push({ call, hash });
    }
  }
  const logs = [], hookLogs = [];
  let resolved = false, now = 1500n;
  const client = { getChainId: async () => 11155111,
    getBlock: async ({ blockNumber } = {}) => ({ number: blockNumber ?? 20n,
      timestamp: blockNumber === 11n ? 1601n : blockNumber === 12n ? 1602n : now }),
    getBytecode: async ({ address }) => toHex(await chain.evm.stateManager.getCode(createAddressFromString(address))),
    readContract: async ({ address, functionName, args }) => {
      if (address.toLowerCase() === hook.address) return chain.call(hook, functionName, args);
      if (functionName === 'triggerMarket') return chain.market;
      if (['staking', 'nodeRegistry', 'emissions', 'stakingToken'].includes(functionName)) return chain.foreign;
      if (functionName === 'postingParties') return [chain.author, chain.author];
      if (functionName === 'hookMeta') return [hook.address, 250000];
      if (functionName === 'triggerMeta') return [1, 2, 3, 5200n, 1600n, 5200n, params.commit, 90n, resolved, 1601n, resolved ? 0n : 1000n, 0n];
      throw new Error('Unexpected fixture read');
    },
    getTransaction: async () => ({ to: chain.market, from: chain.author, value: 1000n,
      input: encodeFunctionData({ abi: triggerMarketAbi, functionName: 'postTrigger', args: [params] }) }),
    getTransactionReceipt: async ({ hash }) => receipts.get(hash) ?? (hash === postHash ? receipt(postHash, 10n, [posted]) : receipt(hash, 12n)),
    getContractEvents: async ({ address }) => address.toLowerCase() === chain.market ? logs : hookLogs,
    request: async () => ({ type: 'CALL', from: chain.market, to: hook.address, gas: '0x3d090', gasUsed: '0xb564',
      input: encodeFunctionData({ abi: hook.abi, functionName: 'onReveal', args: [0n, payload] }),
      output: encodeFunctionResult({ abi: hook.abi, functionName: 'onReveal', result: '0xd8e071b6' }) }),
  };
  const options = { client: () => client, expectedMarket: chain.market, print: () => {}, diagnostic: () => {} };
  async function reveal() {
    resolved = true; now = 1700n;
    await chain.call(hook, 'onReveal', [0n, payload], chain.market);
    const [address, topics, data] = chain.result().execResult.logs[0];
    hookLogs.push({ ...decodeEventLog({ abi: hook.abi, topics: topics.map(toHex), data: toHex(data) }),
      address: toHex(address), blockNumber: 12n, transactionHash: revealHash });
    logs.push({ eventName: 'TriggerResolved', args: { triggerId: 0n, plaintext: payload }, address: chain.market,
      blockNumber: 12n, transactionHash: revealHash },
    { eventName: 'SharePosted', args: { triggerId: 0n }, address: chain.market, blockNumber: 11n },
    { eventName: 'RefundIssued', args: { triggerId: 0n, amount: 400n }, address: chain.market, blockNumber: 12n, transactionHash: revealHash });
  }
  return { client, evidence, options, reveal, logs, hookLogs,
    expire(settled) { now = 5300n; resolved = settled; } };
}

test('P-08 measures a researcher journal without changing it and verifies registry receipts and acceptance', async () => {
  const f = await fixture({ researcherMode: true });
  const directory = await mkdtemp(join(tmpdir(), 'pluto-core-observe-'));
  try {
    const journalPath = join(directory, 'report.jsonl');
    const out = join(directory, 'observation.json');
    const journal = { version: 1, chainId: 11155111, registry: f.evidence.hook, market: f.evidence.market,
      researcher: f.evidence.researcher, reportId: f.evidence.reportId, cipherHash: f.evidence.cipherHash,
      keyCommit: f.evidence.keyCommit, commit: (await f.client.readContract({
        address: f.evidence.market, functionName: 'triggerMeta', args: [0n] }))[6], sealNonce: '0x' + '33'.repeat(32),
      state: 'bound', window: f.evidence.window, transactions: f.evidence.transactions,
      triggerId: '0', postBlock: '10', registrationBlock: '3', escrowWei: '1000', feeNil: '25' };
    // Journal snapshots are one JSON object per line.
    const line = JSON.stringify(JSON.parse(json(journal))) + '\n';
    await writeFile(journalPath, line, { mode: 0o600 });
    await f.reveal();
    assert.equal(await runObserveCommand(['--journal', journalPath, '--out', out, '--trace-hook'], f.options), 0);
    const saved = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(saved.mode, 'researcher');
    assert.equal(saved.observation.measurementsComplete, true);
    assert.equal(saved.observation.hookAccepted, true);
    assert.equal(saved.observation.revealDeltaSecs, '2');
    assert.equal(await readFile(journalPath, 'utf8'), line);
    assert.equal(await runObserveCommand(['--journal', journalPath, '--out', out], f.options), 1);
    const originalReceipt = f.client.getTransactionReceipt;
    f.client.getTransactionReceipt = async args => {
      const value = await originalReceipt(args);
      return args.hash === toHex(4n, { size: 32 }) ? { ...value, logs: [] } : value;
    };
    assert.equal(await runObserveCommand(['--journal', journalPath, '--out', join(directory, 'bad.json')], f.options), 1);
    assert.equal(JSON.parse(await readFile(join(directory, 'bad.json'), 'utf8')).observationFailure.status, 'failed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('observer persists pending then accepted reveal, callback gas and reconciled refund measurements', async () => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'pluto-observe-'));
  const path = join(directory, 'evidence.json');
  try {
    await writeFile(path, json(f.evidence), { mode: 0o600 });
    assert.equal(await runObserveCommand([path], f.options), 2);
    await f.reveal();
    assert.equal(await runObserveCommand([path, '--trace-hook'], f.options), 0);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(saved.observation.state, 'revealed-accepted');
    assert.equal(saved.observation.hookTrace.gasUsed, '46436');
    assert.equal(saved.observation.refundReconciliation.spentWei, '600');
    assert.equal(saved.observation.revealDeltaSecs, '2');
    assert.equal(saved.observation.measurementsComplete, true);
    f.logs[0].removed = true;
    assert.equal(await runObserveCommand([path], f.options), 1);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).observationFailure.status, 'failed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unsupported tracing is saved as incomplete with sanitized diagnostics; calldata mismatch fails', async () => {
  const f = await fixture();
  await f.reveal();
  const directory = await mkdtemp(join(tmpdir(), 'pluto-observe-'));
  const path = join(directory, 'evidence.json');
  try {
    await writeFile(path, json(f.evidence), { mode: 0o600 });
    f.client.request = async () => { throw new Error('https://rpc.invalid/secret-token'); };
    assert.equal(await runObserveCommand([path, '--trace-hook'], f.options), 2);
    const saved = await readFile(path, 'utf8');
    assert.equal(JSON.parse(saved).observation.hookTrace.status, 'unavailable');
    assert.ok(!saved.includes('secret-token'));
    f.client.getTransaction = async () => ({ to: f.evidence.market, from: f.evidence.payer, value: 999n, input: '0x' });
    assert.equal(await runObserveCommand([path], f.options), 1);
    assert.equal(await runObserveCommand([path, '--unknown'], f.options), 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('observer distinguishes unsettled expiry from an independently confirmed settlement receipt', async () => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'pluto-expiry-'));
  const path = join(directory, 'evidence.json');
  try {
    f.expire(false);
    await writeFile(path, json(f.evidence), { mode: 0o600 });
    assert.equal(await runObserveCommand([path], f.options), 2);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).observation.state, 'expired-unsettled');
    f.expire(true);
    const hash = toHex(3n, { size: 32 });
    const original = f.client.getTransaction;
    f.client.getTransaction = async request => request.hash !== hash ? original(request) : {
      to: f.evidence.market, from: f.evidence.payer,
      input: encodeFunctionData({ abi: triggerMarketAbi, functionName: 'settleExpired', args: [0n] }) };
    f.evidence.transactions.push({ call: 'settleExpired', hash });
    f.logs.push({ eventName: 'RefundIssued', args: { triggerId: 0n, amount: 500n },
      address: f.evidence.market, blockNumber: 12n, transactionHash: hash });
    await writeFile(path, json(f.evidence));
    assert.equal(await runObserveCommand([path], f.options), 0);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(saved.observation.state, 'expired-settled');
    assert.equal(saved.observation.refundReconciliation.spentWei, '500');
    assert.equal(saved.observation.hookAccepted, false);
    assert.equal(saved.observation.measurementsComplete, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('expiry settlement preserves the local signer from simulation through submission', async () => {
  const payerKey = `0x${'05'.repeat(32)}`;
  const payer = privateKeyToAccount(payerKey);
  const f = await fixture({ author: payer.address });
  const directory = await mkdtemp(join(tmpdir(), 'pluto-settle-signer-'));
  const path = join(directory, 'evidence.json');
  const hash = toHex(3n, { size: 32 });
  let submitted = false;
  try {
    f.expire(false);
    await writeFile(path, json(f.evidence), { mode: 0o600 });
    f.client.simulateContract = async request => {
      assert.equal(request.account.type, 'local', 'Settlement must preserve local signing');
      assert.equal(typeof request.account.signTransaction, 'function');
      return { request };
    };
    f.options.payerKey = payerKey;
    f.options.walletFactory = account => ({ async writeContract(request) {
      assert.equal(request.account, account);
      submitted = true;
      f.expire(true);
      f.logs.push({ eventName: 'RefundIssued', args: { triggerId: 0n, amount: 500n },
        address: f.evidence.market, blockNumber: 12n, transactionHash: hash });
      return hash;
    } });
    f.client.waitForTransactionReceipt = f.client.getTransactionReceipt;
    const original = f.client.getTransaction;
    f.client.getTransaction = async request => request.hash !== hash ? original(request) : {
      to: f.evidence.market, from: f.evidence.payer,
      input: encodeFunctionData({ abi: triggerMarketAbi, functionName: 'settleExpired', args: [0n] }) };
    assert.equal(await runObserveCommand([path, '--settle-expired'], f.options), 0);
    assert.equal(submitted, true);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(saved.observation.state, 'expired-settled');
    assert.equal(saved.transactions.at(-1).hash, hash);
    assert.equal(saved.transactions.at(-1).status, 'success');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
