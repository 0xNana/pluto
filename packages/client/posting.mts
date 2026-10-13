import { encodeFunctionData, getAddress, type Abi, type Hex, type PublicClient } from 'viem';
import { postParamsTuple, maxLayerLen, quoteEscrow, quoteProtocolFee, type Addresses, type DuskWallet, type PostSealedArgs } from '@nillion/covenants-sdk/browser';
import { postWithEscrowRetry } from '../../src/chain/posting.mjs';
import { verifyRegistryReceipt, verifyRegistryBinding } from '../../src/chain/registry-verification.mjs';
import { checkDeployment, type RegistryArtifact } from './deployment.mts';
import { compileCondition } from '@nillion/covenants-sdk/browser';
import { policy } from '../../config/policy.mjs';
import type { CostCall, quoteTransactionCosts } from '../planner/costs.mts';

export class SelfFundingError extends Error {}
export function selfFundingSpend(costs: Awaited<ReturnType<typeof quoteTransactionCosts>>) {
  const gas = { register: 0n, approve: 0n, post: 0n, bind: 0n };
  for (const action of Object.keys(gas) as (keyof typeof gas)[]) {
    const item = costs.items.find(item => item.action === action);
    if (!item || item.gasUnits <= 0n) throw new Error('Complete live cost review required');
    gas[action] = item.gasUnits * BigInt(policy.gasHeadroomBps) / 10000n + 1n;
  }
  return { gas, maxFeePerGas: costs.maxFeePerGas, maxPriorityFeePerGas: costs.maxPriorityFeePerGas,
    maximumGasWei: (Object.values(gas).reduce((sum, value) => sum + value, 0n) + gas.post) * costs.maxFeePerGas };
}

export interface PostConsent { recoverySaved: boolean; reviewed: boolean; confirmed: boolean; costsReady: boolean }
export function assertPostConsent(consent: PostConsent) {
  if (![consent.recoverySaved, consent.reviewed, consent.confirmed, consent.costsReady].every(value => value === true)) throw new Error('Save recovery and complete both irreversible confirmations after live costs');
}
export interface PostPackage {
  author: Hex; registry: Hex; registryAbi: Abi; marketAbi: Abi; nilAbi: Abi;
  addresses: { market: Hex; nil: Hex }; reportId: Hex; cipherHash: Hex; keyCommit: Hex;
  args: PostSealedArgs; feeNil: bigint; escrowWei: bigint; nextTriggerId: bigint;
  spend?: ReturnType<typeof selfFundingSpend>;
}
export function makeCostCalls(p: PostPackage): CostCall[] {
  return [
    { action: 'register', payer: p.author, to: p.registry, value: 0n,
      data: encodeFunctionData({ abi: p.registryAbi, functionName: 'register', args: [p.cipherHash, p.keyCommit, p.args.t1, p.args.t2] }) },
    { action: 'approve', payer: p.author, to: p.addresses.nil, value: 0n,
      data: encodeFunctionData({ abi: p.nilAbi, functionName: 'approve', args: [p.addresses.market, p.feeNil] }) },
    { action: 'post', payer: p.author, to: p.addresses.market, value: p.escrowWei,
      data: encodeFunctionData({ abi: p.marketAbi, functionName: 'postTrigger', args: [postParamsTuple(p.args)] }) },
    { action: 'bind', payer: p.author, to: p.registry, value: 0n,
      data: encodeFunctionData({ abi: p.registryAbi, functionName: 'bindTrigger', args: [p.reportId, p.nextTriggerId] }) },
  ];
}
// Persist transaction hashes locally before waiting. Callers can recover binding
// from a submitted hash; this function never retries an ambiguous transaction.
export async function submitSelfFunded(pub: PublicClient, wallet: DuskWallet,
  p: PostPackage & { addresses: Addresses }, consent: PostConsent,
  onSubmitted: (action: string, hash: Hex) => Promise<void>, writeEnabled: boolean,
  safety: { expectedMarket: Hex; artifact: RegistryArtifact; onAttempt: (action: string) => Promise<void> }) {
  assertPostConsent(consent);
  if (!writeEnabled) throw new Error('Live posting is disabled on this read-only instance');
  if (await pub.getChainId() !== 11155111 || wallet.chain?.id !== 11155111 || !wallet.account || getAddress(wallet.account.address) !== getAddress(p.author)) throw new Error('Dedicated Sepolia author required');
  const resolved = await checkDeployment(pub, safety.expectedMarket, p.registry, safety.artifact);
  if (getAddress(resolved.market) !== getAddress(p.addresses.market) || getAddress(resolved.nil) !== getAddress(p.addresses.nil)) throw new Error('Posting deployment changed');
  const now = (await pub.getBlock()).timestamp;
  if (!p.args.t1 || !p.args.t2 || p.args.t1 < now + BigInt(policy.marginSecs) || p.args.t2 - p.args.t1 < BigInt(policy.minimumWindowSecs)
      || p.args.mode !== 'PUBLIC_CONDITION' || p.args.ttl !== 0 || getAddress(p.args.hook ?? '0x') !== getAddress(p.registry)
      || !p.args.publicCondition || p.args.publicCondition.length !== 52 || p.args.publicCondition.some((byte, i) => byte !== compileCondition({ window: { t1: p.args.t1!, t2: p.args.t2! } })[i])) throw new Error('Posting terms or window are no longer valid');
  const spend = p.spend;
  if (!spend || spend.maxFeePerGas <= 0n || spend.maxPriorityFeePerGas < 0n || spend.maxPriorityFeePerGas > spend.maxFeePerGas
    || Object.values(spend.gas).some(gas => gas <= 0n)) throw new Error('Reviewed gas caps are required before submission');
  const currentFees = await pub.estimateFeesPerGas();
  if (typeof currentFees.maxFeePerGas !== 'bigint' || typeof currentFees.maxPriorityFeePerGas !== 'bigint'
    || currentFees.maxFeePerGas > spend.maxFeePerGas || currentFees.maxPriorityFeePerGas > spend.maxPriorityFeePerGas) throw new SelfFundingError('Costs increased. Refresh costs, save recovery and review again before submitting.');
  const fee = await quoteProtocolFee(pub, resolved, p.author);
  const escrow = await quoteEscrow(pub, resolved.market, { mode: 'PUBLIC_CONDITION', keyIds: p.args.keys.map(key => key.keyId), k: p.args.k,
    maxLayerLen: maxLayerLen(p.args.layers), ceilingWei: p.args.ceilingWei, hook: p.registry, hookGasLimit: p.args.hookGasLimit, retryWindowSecs: p.args.retryWindowSecs });
  if (fee.feeNil > p.feeNil || escrow.escrowWei > p.escrowWei) throw new SelfFundingError('Costs increased. Refresh costs, save recovery and review again before submitting.');
  if (fee.balanceNil < fee.feeNil) throw new SelfFundingError('Fund the report author address with the resolved Sepolia NIL token before submitting.');
  if (await pub.getBalance({ address: p.author }) < p.escrowWei + spend.maximumGasWei) throw new SelfFundingError('Fund the report author address with Sepolia ETH for escrow and the reviewed gas cap before submitting.');
  const fees = { maxFeePerGas: spend.maxFeePerGas, maxPriorityFeePerGas: spend.maxPriorityFeePerGas };
  const tracked: DuskWallet = { ...wallet, async writeContract(request) {
    const action = request.functionName === 'postTrigger' ? 'post' : request.functionName === 'approve' ? 'approve' : undefined;
    if (!action) throw new Error('Unexpected posting transaction');
    if (request.functionName === 'postTrigger' && (request.value ?? 0n) > p.escrowWei) throw new Error('Escrow exceeds reviewed cost; refresh the cost review');
    if (request.functionName === 'approve') {
      const amount: unknown = Array.isArray(request.args) ? request.args[1] : undefined;
      if (typeof amount !== 'bigint' || amount < 0n || amount > p.feeNil) throw new Error('Approval exceeds reviewed protocol fee');
    }
    if ('gasPrice' in request && request.gasPrice !== undefined) throw new Error('Reviewed EIP-1559 fees are required');
    request.gas = spend.gas[action]; request.maxFeePerGas = fees.maxFeePerGas; request.maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
    await safety.onAttempt(String(request.functionName));
    const hash = await wallet.writeContract(request); await onSubmitted(String(request.functionName), hash); return hash;
  } };
  await pub.simulateContract({ address: p.registry, abi: p.registryAbi, functionName: 'register', args: [p.cipherHash, p.keyCommit, p.args.t1, p.args.t2], account: wallet.account });
  await safety.onAttempt('register');
  const registrationHash = await wallet.sendTransaction({ account: wallet.account, chain: wallet.chain, to: p.registry, ...fees, gas: spend.gas.register,
    data: encodeFunctionData({ abi: p.registryAbi, functionName: 'register', args: [p.cipherHash, p.keyCommit, p.args.t1, p.args.t2] }) });
  await onSubmitted('register', registrationHash);
  const expected = { reportId: p.reportId, researcher: p.author, cipherHash: p.cipherHash, keyCommit: p.keyCommit,
    window: { t1: p.args.t1, t2: p.args.t2 } };
  verifyRegistryReceipt(await pub.waitForTransactionReceipt({ hash: registrationHash }), p.registry, p.registryAbi, 'Registered', expected);
  const posted = await postWithEscrowRetry(pub, tracked, p.addresses, { ...p.args, feeApprovalAmount: p.feeNil });
  const hook = await pub.readContract({ address: p.addresses.market, abi: p.marketAbi, functionName: 'hookMeta', args: [posted.triggerId] });
  const parties = await pub.readContract({ address: p.addresses.market, abi: p.marketAbi, functionName: 'postingParties', args: [posted.triggerId] });
  if (!Array.isArray(hook) || getAddress(hook[0]) !== getAddress(p.registry) || !Array.isArray(parties) || parties.some(address => getAddress(address) !== getAddress(p.author))) throw new Error('Posted hook or parties mismatch; binding blocked');
  await pub.simulateContract({ address: p.registry, abi: p.registryAbi, functionName: 'bindTrigger', args: [p.reportId, posted.triggerId], account: wallet.account });
  await safety.onAttempt('bind');
  const bindingHash = await wallet.sendTransaction({ account: wallet.account, chain: wallet.chain, to: p.registry, ...fees, gas: spend.gas.bind,
    data: encodeFunctionData({ abi: p.registryAbi, functionName: 'bindTrigger', args: [p.reportId, posted.triggerId] }) });
  await onSubmitted('bind', bindingHash);
  const receipt = await pub.waitForTransactionReceipt({ hash: bindingHash });
  verifyRegistryReceipt(receipt, p.registry, p.registryAbi, 'Bound', { ...expected, triggerId: posted.triggerId });
  await verifyRegistryBinding(pub, p.registry, p.registryAbi, { ...expected, triggerId: posted.triggerId });
  return { ...posted, registrationHash, bindingHash };
}
