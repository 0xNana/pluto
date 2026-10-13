import { getAddress, isAddress, zeroAddress, type Hex, type PublicClient } from 'viem';
import { compileCondition, deriveLivePin, fetchCandidates, layerLenForPayload, protocolConfigAbi,
  quoteEscrow, resolveAddresses, selectCommittee, suggestCeiling, type Committee } from '@nillion/covenants-sdk';
import { policy } from '../../config/policy.mjs';
import { SEPOLIA_CONFIG } from '../../config/deployment.mjs';

// Only C0 is pinned. Current published market and the application registry are
// supplied independently; resolved routing is never persisted or trusted from a client.
const config = SEPOLIA_CONFIG;
const defaults = { ...policy, ...policy.committee[11155111] };
const parameterNames = ['minStake', 'maxM', 'maxPlaintextBytes', 'maxCiphertextBytes', 'protocolFee',
  'defaultHookGas', 'maxHookGas', 'defaultRetryWindowSecs', 'maxRetryWindowSecs', 'layerOverheadPublicBytes'] as const;
export async function createPlan(pub: PublicClient, input: { expectedMarket: Hex; registry: Hex; t1: bigint; t2: bigint }) {
  if (!isAddress(input.expectedMarket) || input.expectedMarket === zeroAddress || !isAddress(input.registry) || input.registry === zeroAddress) throw new Error('Configure published market and registry');
  if (await pub.getChainId() !== 11155111) throw new Error('Development planner requires Sepolia');
  const addresses = await resolveAddresses(pub, config);
  if (getAddress(addresses.market) !== getAddress(input.expectedMarket)) throw new Error('Current published market mismatch');
  const block = await pub.getBlock();
  if (block.number === null || block.baseFeePerGas === null) throw new Error('Live block unavailable');
  if (input.t1 < block.timestamp + BigInt(defaults.marginSecs) || input.t2 - input.t1 < BigInt(defaults.minimumWindowSecs)
      || input.t2 >= 1n << 64n) throw new Error('Invalid disclosure window');
  const values = await Promise.all(parameterNames.map(functionName => pub.readContract({ address: addresses.config, abi: protocolConfigAbi, functionName })));
  const parameters = Object.fromEntries(parameterNames.map((name, i) => [name, BigInt(values[i])])) as Record<typeof parameterNames[number], bigint>;
  if (parameters.maxM < BigInt(defaults.m) || parameters.maxPlaintextBytes < 96n) throw new Error('Payload or committee exceeds live limits');
  const layerLength = layerLenForPayload(64, 'PUBLIC_CONDITION');
  if (parameters.layerOverheadPublicBytes !== layerLength - 96n) throw new Error('SDK and market wire overhead differ');
  if (layerLength * BigInt(defaults.m) > parameters.maxCiphertextBytes || parameters.defaultHookGas <= 0n || parameters.defaultHookGas > parameters.maxHookGas
      || parameters.defaultRetryWindowSecs <= 0n || parameters.defaultRetryWindowSecs > parameters.maxRetryWindowSecs) throw new Error('Invalid live settlement limits');
  let candidates = await fetchCandidates(pub, addresses);
  if (!candidates.length) throw new Error('Current deployment has no candidates');
  let committee: Committee | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const pin = await deriveLivePin(pub, addresses);
    const liveIds = new Set(pin.nodeIds.map(String));
    try {
      committee = selectCommittee(candidates.filter(key => liveIds.has(String(key.nodeId))), {
        m: defaults.m, k: defaults.k, nowUnix: block.timestamp, minStake: parameters.minStake, mode: 'PUBLIC_CONDITION' });
      break;
    } catch (error) {
      if (attempt || !(error instanceof Error) || !/^only \d+ eligible nodes; need m=\d+/.test(error.message)) throw error;
      candidates = await fetchCandidates(pub, addresses);
    }
  }
  if (!committee) throw new Error('Live committee unavailable');
  const ceilingWei = suggestCeiling(block.baseFeePerGas) * BigInt(defaults.ceilingMultiplier);
  const conditionRecord = compileCondition({ window: { t1: input.t1, t2: input.t2 } });
  const quote = await quoteEscrow(pub, addresses.market, { mode: 'PUBLIC_CONDITION', keyIds: committee.keys.map(key => key.keyId),
    k: committee.k, ceilingWei, maxLayerLen: layerLength, markupsBps: committee.keys.map(key => key.markup),
    hook: input.registry, hookGasLimit: Number(parameters.defaultHookGas), retryWindowSecs: Number(parameters.defaultRetryWindowSecs) });
  return { addresses, registry: input.registry, parameters, block: block.number, timestamp: block.timestamp,
    committee, ceilingWei, conditionRecord, t1: input.t1, t2: input.t2, ttl: 0, mode: 'PUBLIC_CONDITION' as const,
    hookGasLimit: Number(parameters.defaultHookGas), retryWindowSecs: Number(parameters.defaultRetryWindowSecs), quote,
    costs: { escrowWei: quote.escrowWei, nilUnits: parameters.protocolFee,
      postGasWei: null, registrationGasWei: null, bindingGasWei: null,
      ready: false, reason: 'Exact sealed calls and live sequential gas estimates are required before posting' } };
}
