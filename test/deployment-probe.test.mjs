import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeEventLog, encodeAbiParameters, encodeEventTopics, toHex } from 'viem';
import * as sdk from '@nillion/covenants-sdk';
import * as browser from '@nillion/covenants-sdk/browser';
import { assertSdkCapabilities, runDeploymentProbe } from '../src/chain/deployment-probe.mjs';
import { SEPOLIA_CONFIG } from '../src/chain/deployment.mjs';
import { parameterNames } from '../src/chain/feasibility.mjs';
import { createPlan } from '../packages/planner/planner.mts';

const address = n => toHex(BigInt(n), { size: 20 });
const addresses = { config: SEPOLIA_CONFIG, market: address(2), registry: address(3), staking: address(4),
  emissions: address(5), nil: address(6) };
const hash = toHex(1n, { size: 32 });

function postingLog(overrides = {}) {
  const args = { triggerId: 0n, author: address(7), mode: 1, keyIds: [1n, 2n, 3n], k: 2,
    expiry: 5200n, commit: hash, ceiling: 6n, t1: 1600n, t2: 5200n,
    publicCondition: toHex(sdk.compileCondition({ window: { t1: 1600n, t2: 5200n } })),
    layers: ['0x01', '0x02', '0x03'], ...overrides };
  const event = sdk.triggerMarketAbi.find(item => item.type === 'event' && item.name === 'TriggerPosted');
  return { address: addresses.market, topics: encodeEventTopics({ abi: sdk.triggerMarketAbi, eventName: 'TriggerPosted', args }),
    data: encodeAbiParameters(event.inputs.filter(field => !field.indexed), event.inputs.filter(field => !field.indexed).map(field => args[field.name])),
    blockNumber: 9n, transactionHash: hash, logIndex: 0, removed: false };
}

function fixture({ logs = [postingLog()], brokenView, missingCode, receiptLogs = logs } = {}) {
  const secrets = [1, 2, 3].map(n => new Uint8Array(32).fill(n));
  const candidates = secrets.map((secret, index) => ({ nodeId: BigInt(index + 1), keyId: BigInt(index + 1),
    mpk: toHex(sdk.mpkFromSecret(secret)), expiresAt: 10000n, stake: 10n, fired: 0n, markup: 0,
    operator: address(index + 10) }));
  const plan = { addresses, candidates, parameters: { maxM: 3, maxPlaintextBytes: 96n, maxCiphertextBytes: 690n,
    layerOverheadPublicBytes: 134, layerOverheadPrivateBytes: 186, defaultHookGas: 250000, maxHookGas: 8000000,
    defaultRetryWindowSecs: 604800, maxRetryWindowSecs: 2592000, maxTTL: 86400 },
    committee: sdk.selectCommittee(candidates, { m: 3, k: 2, minStake: 1n, nowUnix: 1000n, pick: 'top' }),
    block: { number: 10n, timestamp: 1000n }, layerLength: 230n, ceilingWei: 6n,
    pin: { fleet: 'serving', nodeIds: [1n, 2n, 3n], window: { fromBlock: 1n, toBlock: 10n } } };
  const pub = {
    getChainId: async () => 11155111,
    getBytecode: async ({ address: target }) => target === missingCode ? '0x' : '0x1234',
    getBlock: async () => ({ number: 10n, timestamp: 1000n }),
    getContractEvents: async () => logs,
    getTransactionReceipt: async () => ({ status: 'success', blockNumber: 9n, transactionHash: hash, logs: receiptLogs }),
    readContract: async ({ functionName }) => {
      const views = { triggerMarket: addresses.market, staking: addresses.staking, nodeRegistry: addresses.registry,
        emissions: addresses.emissions, stakingToken: addresses.nil, config: addresses.config,
        nil: addresses.nil, stakingVault: addresses.staking, escrowMath: address(8), quoteEscrow: 500n };
      if (functionName === brokenView) return address(99);
      if (functionName in views) return views[functionName];
      throw new Error('Unexpected probe read');
    },
  };
  const inspect = async observedPub => {
    await observedPub.getContractEvents({ address: addresses.market, abi: sdk.triggerMarketAbi,
      eventName: 'TriggerPosted', fromBlock: 1n, toBlock: 10n });
    return plan;
  };
  return { pub, plan, services: { inspect }, snapshots: [] };
}

test('P-02 validates SDK exports and ABI getters rather than assuming a pinned version is compatible', () => {
  const capabilities = assertSdkCapabilities();
  assert.equal(capabilities.version, '0.6.1');
  assert.ok(capabilities.rootFunctions.includes('quoteEscrow'));
  assert.ok(capabilities.browserFunctions.includes('selectCommittee'));
  assert.throws(() => assertSdkCapabilities({ ...sdk, quoteEscrow: undefined }, browser), /quoteEscrow/);
  assert.throws(() => assertSdkCapabilities(sdk, { ...browser, selectCommittee: undefined }), /selectCommittee/);
  assert.throws(() => assertSdkCapabilities({ ...sdk, protocolConfigAbi: [] }, browser), /ABI/);
});

test('P-02 produces read-only evidence for deployment guards, SDK seal, quote and raw emitted-event decoding', async () => {
  const f = fixture();
  const evidence = await runDeploymentProbe(f.pub, addresses.market,
    { ...f.services, onProgress: async state => f.snapshots.push(structuredClone(state)) });
  assert.equal(evidence.status, 'passed');
  assert.equal(evidence.checks.events, 'passed');
  assert.equal(evidence.guardChecks.wrongChain, 'rejected');
  assert.equal(evidence.guardChecks.supersededMarket, 'rejected');
  assert.equal(evidence.events.samples[0].triggerId, 0n);
  assert.equal(evidence.events.samples[0].eventName, 'TriggerPosted');
  assert.equal(evidence.quoteWithoutHook.escrowWei, 500n);
  assert.equal(evidence.payload.plaintextBytes, 96);
  assert.equal(evidence.windowRules.maximumWindowGetter, null);
  assert.ok(f.snapshots.some(state => state.stage === 'contract bytecode and module consistency'));
  assert.equal(JSON.stringify(evidence, (_key, value) => typeof value === 'bigint' ? String(value) : value).includes('layers'), false);
});

test('P-02 refuses stale module wiring, codeless contracts and mismatched wire overhead', async () => {
  for (const options of [{ brokenView: 'nil' }, { missingCode: addresses.market }]) {
    const f = fixture(options);
    await assert.rejects(runDeploymentProbe(f.pub, addresses.market, f.services), error =>
      error.evidence.status === 'failed' && error.evidence.failedStage === 'contract bytecode and module consistency');
  }
  const f = fixture();
  f.plan.parameters.layerOverheadPrivateBytes = 187;
  await assert.rejects(runDeploymentProbe(f.pub, addresses.market, f.services), /overhead/);
});

test('P-02 cannot pass event acceptance from an empty scan and can recover it with a current-market receipt', async () => {
  const f = fixture({ logs: [], receiptLogs: [postingLog()] });
  const incomplete = await runDeploymentProbe(f.pub, addresses.market, f.services);
  assert.equal(incomplete.status, 'incomplete');
  assert.equal(incomplete.checks.events, 'pending');
  const complete = await runDeploymentProbe(f.pub, addresses.market, { ...f.services, eventTx: hash });
  assert.equal(complete.status, 'passed');
  assert.equal(complete.events.samples[0].transactionHash, hash);
});

test('P-02 rejects foreign, removed, undecodable and inconsistent public-window logs', async () => {
  for (const log of [
    { ...postingLog(), address: address(99) },
    { ...postingLog(), removed: true },
    { ...postingLog(), data: '0x12' },
    postingLog({ expiry: 5201n }),
    postingLog({ t1: 1601n }),
  ]) {
    const f = fixture({ logs: [log] });
    await assert.rejects(runDeploymentProbe(f.pub, addresses.market, f.services));
  }
  const f = fixture({ logs: [], receiptLogs: [{ ...postingLog(), address: address(99) }] });
  await assert.rejects(runDeploymentProbe(f.pub, addresses.market, { ...f.services, eventTx: hash }), /event/);
});

test('P-02 persists completed SDK checks and sanitized stage context when live RPC inspection fails', async () => {
  const f = fixture();
  f.services.inspect = async () => { throw Object.assign(new Error('https://user:secret@rpc.example calldata'), { code: 'EAI_AGAIN' }); };
  await assert.rejects(runDeploymentProbe(f.pub, addresses.market, f.services), error => {
    assert.equal(error.evidence.failedStage, 'deployment, live parameters and committee');
    assert.equal(error.evidence.checks.sdk, 'passed');
    assert.ok(!JSON.stringify(error.evidence).includes('secret'));
    return true;
  });
});

test('P-02 default pipeline uses actual SDK C0 resolution, candidate discovery, liveness and selection', async () => {
  const f = fixture();
  const parameters = Object.fromEntries(parameterNames.map(name => [name, 0n]));
  Object.assign(parameters, f.plan.parameters, { minStake: 1n, keyTTL: 10000 });
  const shareEvent = sdk.triggerMarketAbi.find(item => item.type === 'event' && item.name === 'SharePosted');
  const shares = f.plan.candidates.map(candidate => {
    const args = { triggerId: 0n, slot: Number(candidate.nodeId - 1n), node: candidate.nodeId, share: '0x01' };
    return { ...postingLog(), topics: encodeEventTopics({ abi: sdk.triggerMarketAbi, eventName: 'SharePosted', args }),
      data: encodeAbiParameters(shareEvent.inputs.filter(field => !field.indexed),
        shareEvent.inputs.filter(field => !field.indexed).map(field => args[field.name])) };
  });
  const pub = { ...f.pub,
    getBlock: async ({ blockNumber = 10n } = {}) => ({ number: blockNumber, timestamp: blockNumber * 100n, baseFeePerGas: 1n }),
    getContractEvents: async ({ eventName }) => (eventName === 'SharePosted' ? shares : [postingLog()])
      .map(log => ({ ...log, ...decodeEventLog({ abi: sdk.triggerMarketAbi, topics: log.topics, data: log.data }) })),
    readContract: async request => {
      if (request.functionName in parameters) return parameters[request.functionName];
      if (request.functionName === 'getActiveKeys') return f.plan.candidates;
      if (request.functionName === 'operatorOf') return f.plan.candidates.find(key => key.nodeId === request.args[0]).operator;
      if (request.functionName === 'retired') return false;
      return f.pub.readContract(request);
    },
  };
  const evidence = await runDeploymentProbe(pub, addresses.market);
  assert.equal(evidence.status, 'passed');
  assert.equal(evidence.addresses.config, SEPOLIA_CONFIG);
  assert.equal(evidence.fleet, 'serving');
  assert.equal(evidence.committee.length, 3);
  assert.equal(evidence.events.counts.SharePosted, 3);
  assert.equal(evidence.events.counts.TriggerPosted, 1);
  const productPlan = await createPlan(pub, { expectedMarket: addresses.market, registry: address(20), t1: 1600n, t2: 5200n });
  assert.equal(productPlan.committee.keys.length, 3);
  assert.equal(productPlan.committee.k, 2);
  assert.equal(productPlan.quote.escrowWei, 500n);
  assert.equal(productPlan.costs.ready, false);
});
