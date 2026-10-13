import { getAddress, type Abi, type Hex, type PublicClient } from 'viem';
import { deriveLivePin, fetchCandidates, maxLayerLen, quoteEscrow, quoteProtocolFee, validate } from '@nillion/covenants-sdk/browser';
import { checkDeployment, type RegistryArtifact } from './deployment.mts';
import { canStartPosting, savedSealArgs, validateBrowserRecovery, type BrowserRecovery } from './recovery.mts';
import { makeCostCalls, selfFundingSpend, type PostPackage } from './posting.mts';
import { quoteTransactionCosts } from '../planner/costs.mts';
import type { createPlan } from '../planner/planner.mts';
import { policy } from '../../config/policy.mjs';

// Refresh pricing only. Preserve the ciphertext, committee seal, deadline and
// request history when changing from withdrawn sponsorship to self-funding.
export async function priceSavedSelfFunded(pub: PublicClient, recovery: BrowserRecovery, plan: Awaited<ReturnType<typeof createPlan>>,
  safety: { expectedMarket: Hex; artifact: RegistryArtifact; marketAbi: Abi; nilAbi: Abi }) {
  const local = await validateBrowserRecovery(recovery);
  if (!local.sealing || !canStartPosting(local)) throw new Error('Reconcile existing attempts before self-funding');
  const args = savedSealArgs(local), addresses = await checkDeployment(pub, safety.expectedMarket, local.sealing.registry, safety.artifact);
  const now = (await pub.getBlock()).timestamp;
  if (typeof now !== 'bigint' || now < 0n || args.t1! < now + BigInt(policy.marginSecs) || plan.t1 !== args.t1 || plan.t2 !== args.t2
    || getAddress(plan.registry) !== getAddress(local.sealing.registry) || getAddress(local.sealing.market) !== getAddress(addresses.market)
    || args.keys.length > Number(plan.parameters.maxM) || plan.parameters.maxPlaintextBytes < 96n
    || maxLayerLen(args.layers) * BigInt(args.layers.length) > plan.parameters.maxCiphertextBytes
    || args.hookGasLimit! > Number(plan.parameters.maxHookGas) || args.retryWindowSecs! > Number(plan.parameters.maxRetryWindowSecs)) throw new Error('Saved terms exceed current admission limits');
  const pin = await deriveLivePin(pub, addresses), candidates = await fetchCandidates(pub, addresses);
  const selected = args.keys.map(key => candidates.find(candidate => candidate.keyId === key.keyId && candidate.nodeId === key.nodeId && candidate.mpk === key.mpk && pin.nodeIds.includes(candidate.nodeId)));
  if (selected.some(key => !key)) throw new Error('Saved committee is no longer live');
  validate(selected.filter(key => key !== undefined), { mode: 'PUBLIC_CONDITION', m: args.keys.length, k: args.k, nowUnix: now, minStake: plan.parameters.minStake });
  const fee = await quoteProtocolFee(pub, addresses, local.report.researcher);
  const escrow = await quoteEscrow(pub, addresses.market, { mode: 'PUBLIC_CONDITION', keyIds: args.keys.map(key => key.keyId), k: args.k,
    maxLayerLen: maxLayerLen(args.layers), ceilingWei: args.ceilingWei, hook: local.sealing.registry, hookGasLimit: args.hookGasLimit, retryWindowSecs: args.retryWindowSecs });
  const nextTriggerId = await pub.readContract({ address: addresses.market, abi: safety.marketAbi, functionName: 'nextTriggerId' });
  if (typeof nextTriggerId !== 'bigint' || nextTriggerId < 0n) throw new Error('Next trigger unavailable');
  const postPackage: PostPackage = { author: local.report.researcher, registry: local.sealing.registry, registryAbi: safety.artifact.abi, marketAbi: safety.marketAbi, nilAbi: safety.nilAbi,
    addresses, reportId: local.report.reportId, cipherHash: local.report.cipherHash, keyCommit: local.report.keyCommit,
    args: { ...args, feeApprovalAmount: fee.feeNil }, feeNil: fee.feeNil, escrowWei: escrow.escrowWei, nextTriggerId };
  const costs = await quoteTransactionCosts(pub, makeCostCalls(postPackage));
  postPackage.spend = selfFundingSpend(costs);
  return { postPackage, costs, addresses };
}
