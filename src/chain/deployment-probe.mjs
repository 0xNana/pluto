import { decodeEventLog, getAddress, hexToBytes, zeroAddress } from 'viem';
import * as sdk from '@nillion/covenants-sdk';
import * as browser from '@nillion/covenants-sdk/browser';
import sdkPackage from '@nillion/covenants-sdk/package.json' with { type: 'json' };
import { policy } from '../../config/policy.mjs';
import { compileDisclosureWindow } from '../shared/disclosure.mjs';
import { DeploymentError, resolveSepolia, SEPOLIA_CONFIG } from './deployment.mjs';
import { assertProbeLimits, inspectFeasibility, parameterNames } from './feasibility.mjs';

const requireThat = (condition, message) => { if (!condition) throw new DeploymentError(message); };
const same = (a, b) => getAddress(a) === getAddress(b);
const functions = ['resolveAddresses', 'fetchCandidates', 'selectCommittee', 'deriveLivePin',
  'quoteEscrow', 'quoteProtocolFee', 'postSealed', 'postSponsored', 'signPostAuthorization'];

export function assertSdkCapabilities(root = sdk, client = browser) {
  for (const [surface, entry] of [['root', root], ['browser', client]]) {
    for (const name of functions) requireThat(typeof entry[name] === 'function', `SDK ${surface} export missing: ${name}`);
  }
  requireThat(typeof root.seal === 'function' && typeof client.initBrowserCrypto === 'function', 'SDK crypto entry points are missing');
  const abis = ['triggerMarketAbi', 'protocolConfigAbi', 'nodeRegistryAbi', 'stakingAbi', 'nilAbi', 'authVerifierAbi'];
  for (const name of abis) requireThat(Array.isArray(root[name]) && root[name].length > 0, `SDK ABI missing: ${name}`);
  for (const name of parameterNames) requireThat(root.protocolConfigAbi.some(item =>
    item.type === 'function' && item.name === name && item.stateMutability === 'view'), `SDK ABI getter missing: ${name}`);
  for (const name of ['TriggerPosted', 'SharePosted', 'TriggerResolved', 'HookInvoked']) {
    requireThat(root.triggerMarketAbi.some(item => item.type === 'event' && item.name === name), `SDK ABI event missing: ${name}`);
  }
  return { version: sdkPackage.version, rootFunctions: functions, browserFunctions: functions,
    abis, marketEvents: root.triggerMarketAbi.filter(item => item.type === 'event').map(item => item.name) };
}

class DeploymentProbeError extends Error {
  constructor(evidence, cause) {
    super(cause instanceof DeploymentError ? cause.message : 'Deployment probe failed', { cause });
    this.evidence = evidence;
  }
}

function eventEvidence(log, market, eventName) {
  requireThat(same(log.address, market) && !log.removed && typeof log.blockNumber === 'bigint'
    && /^0x[0-9a-fA-F]{64}$/.test(log.transactionHash), 'Market event has an invalid source or was removed');
  let decoded;
  try { decoded = decodeEventLog({ abi: sdk.triggerMarketAbi, topics: log.topics, data: log.data, strict: true }); }
  catch { throw new DeploymentError('Market event does not decode with the installed SDK ABI'); }
  requireThat(!eventName || decoded.eventName === eventName, 'Market event differs from the requested SDK event');
  const args = decoded.args;
  if (decoded.eventName === 'TriggerPosted' && args.mode === 1 && args.t2 > 0n) {
    const record = sdk.parseConditionRecord(hexToBytes(args.publicCondition));
    requireThat(record.t1 === args.t1 && record.t2 === args.t2 && args.expiry === args.t2
      && args.t1 < args.t2, 'Emitted PUBLIC window or expiry differs from its condition record');
  }
  // No layers, shares, revealed plaintext or arbitrary log fields enter the evidence file.
  return { eventName: decoded.eventName, transactionHash: log.transactionHash, block: log.blockNumber,
    logIndex: log.logIndex, triggerId: args.triggerId, nodeId: args.node,
    ...(decoded.eventName === 'TriggerPosted' ? { mode: args.mode, t1: args.t1, t2: args.t2, expiry: args.expiry } : {}) };
}

export async function runDeploymentProbe(pub, expectedMarket,
  { inspect = inspectFeasibility, onProgress = async () => {}, eventTx } = {}) {
  const evidence = { status: 'incomplete', chainId: 11155111, config: SEPOLIA_CONFIG,
    sdkVersion: sdkPackage.version, checks: {}, events: { decoded: 0, counts: {}, samples: [] } };
  const save = async stage => {
    if (stage) evidence.stage = stage;
    await onProgress(structuredClone(evidence));
  };
  const addEvent = sample => {
    evidence.events.decoded++;
    evidence.events.counts[sample.eventName] = (evidence.events.counts[sample.eventName] ?? 0) + 1;
    if (!evidence.events.samples.some(item => item.eventName === sample.eventName)) evidence.events.samples.push(sample);
  };
  try {
    await save('SDK exports and ABIs');
    evidence.sdk = assertSdkCapabilities();
    evidence.checks.sdk = 'passed';
    requireThat(eventTx === undefined || /^0x[0-9a-fA-F]{64}$/.test(eventTx), 'Event transaction must be a bytes32 hash');
    await save('deployment, live parameters and committee');
    const observedPub = { ...pub, async getContractEvents(args) {
      requireThat(typeof args.fromBlock === 'bigint' && typeof args.toBlock === 'bigint'
        && args.fromBlock >= 0n && args.fromBlock <= args.toBlock, 'SDK event scan must have explicit block bounds');
      const logs = await pub.getContractEvents({ ...args, strict: true });
      for (const log of logs) addEvent(eventEvidence(log, args.address, args.eventName));
      return logs;
    } };
    const plan = await inspect(observedPub, expectedMarket);
    const { addresses, parameters, committee, pin, block, layerLength, ceilingWei } = plan;
    Object.assign(evidence, { addresses, parameters, block: block.number, timestamp: block.timestamp,
      candidateKeys: plan.candidates.length, fleet: pin.fleet, liveNodes: pin.nodeIds, liveWindow: pin.window,
      committee: committee.keys.map(key => ({ nodeId: key.nodeId, keyId: key.keyId,
        operator: key.operator, expiresAt: key.expiresAt, markupBps: key.markup })), warnings: committee.warnings });
    evidence.checks.deployment = 'passed';

    await save('contract bytecode and module consistency');
    for (const [module, address] of Object.entries(addresses)) {
      const code = await pub.getBytecode({ address });
      requireThat(code && code !== '0x', `Resolved ${module} has no deployed bytecode`);
    }
    const moduleViews = { config: addresses.config, nil: addresses.nil,
      nodeRegistry: addresses.registry, stakingVault: addresses.staking };
    for (const [functionName, expected] of Object.entries(moduleViews)) {
      const actual = await pub.readContract({ address: addresses.market, abi: sdk.triggerMarketAbi, functionName });
      requireThat(same(actual, expected), `Market ${functionName} differs from the C0-resolved module`);
    }
    const escrowMath = await pub.readContract({ address: addresses.market, abi: sdk.triggerMarketAbi, functionName: 'escrowMath' });
    const code = await pub.getBytecode({ address: escrowMath });
    requireThat(!same(escrowMath, zeroAddress) && code && code !== '0x', 'Market escrow quoter has no deployed bytecode');
    evidence.escrowMath = escrowMath;
    evidence.checks.contracts = 'passed';

    await save('deployment rejection controls');
    const rejection = async operation => {
      try { await operation(); } catch (error) {
        if (error instanceof DeploymentError) return 'rejected';
        throw error;
      }
      throw new DeploymentError('Deployment guard unexpectedly accepted an invalid target');
    };
    // The wrong-chain control must reject before any address read. It is a guard test, not a second RPC.
    const wrongChain = await rejection(() => resolveSepolia({ getChainId: async () => 1,
      readContract: async () => { throw new Error('Wrong-chain guard attempted an RPC read'); } }, expectedMarket));
    const supersededMarket = await rejection(() => resolveSepolia(pub, addresses.config));
    evidence.guardChecks = { wrongChain, supersededMarket,
      scope: 'wrong-chain guard control; mismatched market against live C0 resolution' };
    evidence.checks.guards = 'passed';

    await save('SDK payload, limits and time window');
    requireThat(BigInt(parameters.layerOverheadPrivateBytes) === sdk.LAYER_OVERHEAD_PRIVATE_BYTES,
      'SDK private wire overhead differs from live ProtocolConfig');
    requireThat(parameters.defaultRetryWindowSecs > 0 && parameters.defaultRetryWindowSecs <= parameters.maxRetryWindowSecs,
      'Invalid live retry-window limits');
    requireThat(parameters.maxTTL > 0, 'Invalid live TTL limit');
    assertProbeLimits(parameters, { m: committee.keys.length, k: committee.k });
    const window = compileDisclosureWindow({ nowUnix: block.timestamp,
      t1: block.timestamp + BigInt(policy.marginSecs),
      t2: block.timestamp + BigInt(policy.marginSecs + policy.minimumWindowSecs) });
    const parsed = sdk.parseConditionRecord(window.conditionRecord);
    requireThat(parsed.t1 === window.t1 && parsed.t2 === window.t2, 'SDK compiled condition window does not roundtrip');
    const sealed = sdk.seal(new Uint8Array(64).fill(7), window.mode, window.conditionRecord,
      committee.k, committee.keys.map(key => hexToBytes(key.mpk)));
    requireThat(sdk.maxLayerLen(sealed.layers) === layerLength, 'SDK sealed layer differs from the quoted wire length');
    evidence.payload = { applicationBytes: 64, nonceBytes: sdk.NONCE_BYTES, plaintextBytes: 64 + sdk.NONCE_BYTES,
      layerBytes: layerLength, totalLayerBytes: layerLength * BigInt(committee.keys.length) };
    evidence.windowRules = { mode: window.mode, ttl: 0, t1: window.t1, t2: window.t2, expiry: 't2',
      productPostingMarginSecs: policy.marginSecs, productMinimumWidthSecs: policy.minimumWindowSecs,
      priceOnlyMaxTTL: parameters.maxTTL, maximumWindowGetter: null,
      source: 'https://docs.nillion.com/blacklight/l1/sdk',
      liveBoundarySimulations: 'pending P-04; no dedicated maximum PUBLIC-window getter in SDK ABI' };
    evidence.checks.limits = 'passed';

    await save('escrow quote');
    evidence.ceilingWei = ceilingWei;
    evidence.quoteWithoutHook = await sdk.quoteEscrow(pub, addresses.market, { mode: window.mode,
      keyIds: committee.keys.map(key => key.keyId), k: committee.k, ceilingWei, maxLayerLen: layerLength,
      markupsBps: committee.keys.map(key => key.markup) });
    evidence.checks.quote = 'passed';

    await save('emitted SDK events');
    if (eventTx) {
      const receipt = await pub.getTransactionReceipt({ hash: eventTx });
      requireThat(receipt?.status === 'success' && receipt.transactionHash?.toLowerCase() === eventTx.toLowerCase(),
        'Event receipt is unavailable or unsuccessful');
      const logs = receipt.logs.filter(log => same(log.address, addresses.market));
      requireThat(logs.length > 0, 'Receipt contains no current-market event');
      for (const log of logs) addEvent(eventEvidence(log, addresses.market));
    }
    evidence.checks.events = evidence.events.decoded > 0 ? 'passed' : 'pending';
    evidence.status = evidence.checks.events === 'passed' ? 'passed' : 'incomplete';
    await save('complete');
    return evidence;
  } catch (cause) {
    evidence.status = 'failed';
    evidence.failedStage = evidence.stage;
    throw new DeploymentProbeError(structuredClone(evidence), cause);
  }
}
