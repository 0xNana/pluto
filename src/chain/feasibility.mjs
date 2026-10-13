import { deriveLivePin, fetchCandidates, layerLenForPayload, LAYER_OVERHEAD_PUBLIC_BYTES,
  protocolConfigAbi, selectCommittee, suggestCeiling } from '@nillion/covenants-sdk';
import { policy } from '../../config/policy.mjs';
import { DeploymentError, inspectSepolia } from './deployment.mjs';

export const parameterNames = Object.freeze([
  'minStake', 'keyTTL', 'maxM', 'maxTTL', 'maxPlaintextBytes', 'maxCiphertextBytes',
  'protocolFee', 'defaultHookGas', 'maxHookGas', 'defaultRetryWindowSecs', 'maxRetryWindowSecs',
  'layerOverheadPrivateBytes', 'layerOverheadPublicBytes', 'unitsShare', 'unitsSharePerByte',
  'unitsResultBase', 'unitsResultPerShare', 'unitsResultPerShareByte', 'unitsResultPerByte',
  'reconMultBps', 'hookMultBps', 'hookFeeFloor',
]);

export function assertProbeLimits(parameters, { m, k }) {
  const layerLength = layerLenForPayload(64, 'PUBLIC_CONDITION');
  if (!Number.isInteger(m) || !Number.isInteger(k) || k < 1 || m <= k || m > Number(parameters.maxM)
      || 96n > BigInt(parameters.maxPlaintextBytes)
      || layerLength * BigInt(m) > BigInt(parameters.maxCiphertextBytes)) {
    throw new DeploymentError('Pluto payload or committee exceeds current chain limits');
  }
  if (BigInt(parameters.layerOverheadPublicBytes) !== LAYER_OVERHEAD_PUBLIC_BYTES) {
    throw new DeploymentError('SDK wire overhead differs from live ProtocolConfig');
  }
  if (Number(parameters.defaultHookGas) <= 0 || Number(parameters.defaultHookGas) > Number(parameters.maxHookGas)) {
    throw new DeploymentError('Invalid live hook gas limits');
  }
  return layerLength;
}

export async function inspectFeasibility(pub, expectedMarket) {
  const { addresses, candidates } = await inspectSepolia(pub, expectedMarket);
  const values = await Promise.all(parameterNames.map(functionName => pub.readContract({
    address: addresses.config, abi: protocolConfigAbi, functionName,
  })));
  const parameters = Object.fromEntries(parameterNames.map((name, index) => [name, values[index]]));
  const block = await pub.getBlock();
  const size = policy.committee[11155111];
  const layerLength = assertProbeLimits(parameters, size);
  if (block.baseFeePerGas === null || block.baseFeePerGas === undefined) {
    throw new DeploymentError('RPC returned no basefee for the latest block');
  }
  let pin;
  let committee;
  let currentCandidates = candidates;
  for (let attempt = 0; attempt < 2; attempt++) {
    pin = await deriveLivePin(pub, addresses);
    const liveIds = new Set(pin.nodeIds.map(String));
    try {
      committee = selectCommittee(currentCandidates.filter(candidate => liveIds.has(String(candidate.nodeId))), {
        ...size, nowUnix: block.timestamp, minStake: parameters.minStake, mode: 'PUBLIC_CONDITION',
      });
      break;
    } catch (error) {
      if (attempt || !/^only \d+ eligible nodes; need m=\d+/.test(error.message)) throw error;
      currentCandidates = await fetchCandidates(pub, addresses);
    }
  }
  return { addresses, candidates: currentCandidates, parameters, block, pin, committee, layerLength,
    ceilingWei: suggestCeiling(block.baseFeePerGas) * BigInt(policy.ceilingMultiplier) };
}
