import { encodeFunctionData, getAddress, parseEventLogs, type Abi, type Hex, type PublicClient, type TransactionReceipt } from 'viem';
import { resolveAddresses, postParamsTuple, type DuskWallet } from '@nillion/covenants-sdk/browser';
import { SEPOLIA_CONFIG } from '../../config/deployment.mjs';
import { policy } from '../../config/policy.mjs';
import { verifyHookDeployment, verifyRegistryReceipt } from '../../src/chain/registry-verification.mjs';
import { validateBrowserRecovery, savedSealArgs, appendRecoveryEvent, type BrowserRecovery } from './recovery.mts';
import { object } from './notice.mts';
import { assertPostConsent, type PostConsent } from './posting.mts';
import type { RegistryArtifact } from './deployment.mts';

interface Safety { expectedMarket: Hex; artifact: RegistryArtifact; marketAbi: Abi }
const same = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const blockHash = (value: unknown) => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
function validCaps(gasLimit: unknown, maxFee: unknown, priority: unknown) {
  return typeof gasLimit === 'bigint' && gasLimit > 0n && gasLimit < 1n << 64n
    && typeof maxFee === 'bigint' && maxFee > 0n && maxFee < 1n << 256n
    && typeof priority === 'bigint' && priority >= 0n && priority <= maxFee;
}
export async function inspectBrowserRecovery(pub: PublicClient, input: BrowserRecovery, safety: Safety) {
  const recovery = await validateBrowserRecovery(input);
  if (await pub.getChainId() !== 11155111) throw new Error('Recovery requires Sepolia');
  if (!recovery.sealing || recovery.history.at(-1)?.state === 'unknown') throw new Error('Unresolved attempt or unsealed report; reconcile without resending');
  const addresses = await resolveAddresses(pub, SEPOLIA_CONFIG);
  if (!same(addresses.market, safety.expectedMarket) || !same(addresses.market, recovery.sealing.market)) throw new Error('Recovery market changed');
  const registry = recovery.sealing.registry, author = recovery.report.researcher, args = savedSealArgs(recovery);
  const marketAbi = safety.marketAbi;
  await verifyHookDeployment(pub, registry, safety.artifact, addresses.market);
  const head = await pub.getBlock({ blockTag: 'finalized' });
  if (typeof head.number !== 'bigint' || head.number < 0n || !blockHash(head.hash)) throw new Error('Finalized recovery head unavailable');
  async function canonicalReceipt(hash: Hex) {
    const [tx, receipt] = await Promise.all([pub.getTransaction({ hash }), pub.getTransactionReceipt({ hash })]);
    if (tx.hash !== hash || receipt.transactionHash !== hash || typeof receipt.blockNumber !== 'bigint' || receipt.blockNumber < 0n || !blockHash(receipt.blockHash) || !['success', 'reverted'].includes(receipt.status)
      || receipt.blockNumber > head.number! || (await pub.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error('Recovery transaction is unresolved or noncanonical');
    return { tx, receipt };
  }
  const postData = encodeFunctionData({ abi: marketAbi, functionName: 'postTrigger', args: [postParamsTuple(args)] });
  let postHash: Hex | undefined, triggerId: bigint | undefined;
  for (const event of recovery.history.filter(event => event.action === 'postTrigger' && event.hash)) {
    const hash = event.hash!, { tx, receipt } = await canonicalReceipt(hash);
    if (!same(tx.from, author) || !same(tx.to, addresses.market) || tx.input !== postData || typeof tx.value !== 'bigint' || tx.value < 0n) throw new Error('Saved post transaction differs from recovery');
    if (receipt.status === 'reverted') continue;
    const posted = parseEventLogs({ abi: marketAbi, eventName: 'TriggerPosted', logs: receipt.logs, strict: true }).filter(log => same(log.address, addresses.market) && !log.removed);
    if (triggerId !== undefined || posted.length !== 1) throw new Error('Unique authenticated posted trigger unavailable');
    const emitted = object(posted[0].args);
    if (!same(emitted.author, author) || !same(emitted.commit, args.commit) || emitted.t1 !== args.t1 || emitted.t2 !== args.t2
      || emitted.expiry !== args.t2 || emitted.mode !== 1 || typeof emitted.triggerId !== 'bigint') throw new Error('Unique authenticated posted trigger unavailable');
    triggerId = emitted.triggerId; postHash = hash;
  }
  if (triggerId === undefined || !postHash) throw new Error('No successful saved post; no repost permitted');
  const expected = { reportId: recovery.report.reportId, researcher: author, cipherHash: recovery.report.cipherHash,
    keyCommit: recovery.report.keyCommit, window: { t1: args.t1!, t2: args.t2! }, triggerId };
  const [raw, binding, hook, parties] = await Promise.all([
    pub.readContract({ address: registry, abi: safety.artifact.abi, functionName: 'statusOf', args: [expected.reportId], blockNumber: head.number }),
    pub.readContract({ address: registry, abi: safety.artifact.abi, functionName: 'bindings', args: [triggerId], blockNumber: head.number }),
    pub.readContract({ address: addresses.market, abi: marketAbi, functionName: 'hookMeta', args: [triggerId], blockNumber: head.number }),
    pub.readContract({ address: addresses.market, abi: marketAbi, functionName: 'postingParties', args: [triggerId], blockNumber: head.number }),
  ]);
  const record = object(raw);
  if (!same(record.researcher, author) || !same(record.cipherHash, expected.cipherHash) || !same(record.keyCommit, expected.keyCommit)
    || record.t1 !== args.t1 || record.t2 !== args.t2 || typeof record.registeredAt !== 'bigint' || record.registeredAt <= 0n
    || !Array.isArray(hook) || !Array.isArray(parties) || !same(hook[0], registry) || !same(parties[0], author) || !same(parties[1], author)
    || !Array.isArray(binding) || binding.length !== 2 || typeof binding[1] !== 'boolean'
    || typeof record.bindTime !== 'bigint' || (binding[1] && (!same(binding[0], expected.reportId) || record.lastTriggerId !== triggerId || record.bindTime === 0n))
    || (!binding[1] && record.bindTime !== 0n)) throw new Error('Recovery registry, hook or parties mismatch');
  for (const event of recovery.history.filter(event => event.action === 'bind' && event.hash)) {
    const { tx, receipt } = await canonicalReceipt(event.hash!);
    const data = encodeFunctionData({ abi: safety.artifact.abi, functionName: 'bindTrigger', args: [expected.reportId, triggerId] });
    if (!same(tx.from, author) || !same(tx.to, registry) || tx.input !== data || tx.value !== 0n) throw new Error('Saved binding transaction differs from recovery');
    if (receipt.status === 'success') { verifyRegistryReceipt(receipt, registry, safety.artifact.abi, 'Bound', expected); if (!binding[1]) throw new Error('Binding receipt and registry disagree'); }
  }
  if ((await pub.getBlock({ blockNumber: head.number })).hash !== head.hash) throw new Error('Recovery finality changed');
  return { recovery, args, addresses, expected, triggerId, postHash, bound: binding[1] === true, registry, author, artifact: safety.artifact };
}
export async function priceRecoveredBinding(pub: PublicClient, observed: Awaited<ReturnType<typeof inspectBrowserRecovery>>) {
  if (observed.bound) return { gasLimit: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, gasWei: 0n };
  const request = { address: observed.registry, abi: observed.artifact.abi, functionName: 'bindTrigger', args: [observed.expected.reportId, observed.triggerId], account: observed.author } as const;
  await pub.simulateContract(request);
  const [estimate, fees] = await Promise.all([pub.estimateContractGas(request), pub.estimateFeesPerGas()]);
  if (!validCaps(estimate, fees.maxFeePerGas, fees.maxPriorityFeePerGas)) throw new Error('Live binding costs unavailable');
  const gasLimit = estimate * BigInt(policy.gasHeadroomBps) / 10000n + 1n;
  if (!validCaps(gasLimit, fees.maxFeePerGas, fees.maxPriorityFeePerGas)) throw new Error('Live binding costs unavailable');
  return { gasLimit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, gasWei: gasLimit * fees.maxFeePerGas };
}
export async function resumeBrowserBinding(pub: PublicClient, wallet: DuskWallet, recovery: BrowserRecovery,
  consent: PostConsent, reviewed: Awaited<ReturnType<typeof priceRecoveredBinding>>, writesEnabled: boolean,
  safety: Safety & { onAttempt: () => Promise<void>; onSubmitted: (hash: Hex) => Promise<void> }) {
  const observed = await inspectBrowserRecovery(pub, recovery, safety);
  if (observed.bound) return { state: 'bound' as const, triggerId: observed.triggerId, postHash: observed.postHash };
  assertPostConsent(consent);
  if (!writesEnabled) throw new Error('Live recovery binding is disabled until release approval');
  if (!wallet.account || wallet.chain?.id !== 11155111 || getAddress(wallet.account.address) !== getAddress(observed.author)) throw new Error('Recovery requires its dedicated Sepolia author');
  if (!validCaps(reviewed.gasLimit, reviewed.maxFeePerGas, reviewed.maxPriorityFeePerGas)
    || typeof reviewed.gasWei !== 'bigint' || reviewed.gasWei !== reviewed.gasLimit * reviewed.maxFeePerGas) throw new Error('Reviewed binding costs unavailable');
  const timestamp = (await pub.getBlock()).timestamp;
  if (typeof timestamp !== 'bigint' || timestamp <= 0n || timestamp >= 1n << 64n) throw new Error('Live binding timestamp unavailable');
  if (timestamp >= observed.args.t1!) throw new Error('Binding deadline elapsed; never change the window');
  const fresh = await priceRecoveredBinding(pub, observed);
  const balance = await pub.getBalance({ address: observed.author });
  if (typeof balance !== 'bigint' || balance < 0n) throw new Error('Author funds unavailable');
  if (fresh.gasLimit > reviewed.gasLimit || fresh.maxFeePerGas > reviewed.maxFeePerGas || fresh.maxPriorityFeePerGas > reviewed.maxPriorityFeePerGas
    || balance < reviewed.gasWei) throw new Error('Binding exceeds reviewed cost or author funds; review again');
  await safety.onAttempt();
  const hash = await wallet.sendTransaction({ account: wallet.account, chain: wallet.chain, to: observed.registry,
    data: encodeFunctionData({ abi: observed.artifact.abi, functionName: 'bindTrigger', args: [observed.expected.reportId, observed.triggerId] }),
    gas: reviewed.gasLimit, maxFeePerGas: reviewed.maxFeePerGas, maxPriorityFeePerGas: reviewed.maxPriorityFeePerGas });
  await safety.onSubmitted(hash);
  const receipt: TransactionReceipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.transactionHash !== hash || typeof receipt.blockNumber !== 'bigint' || receipt.blockNumber < 0n || !blockHash(receipt.blockHash)
    || (await pub.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error('Binding receipt is noncanonical; inspect saved hash');
  verifyRegistryReceipt(receipt, observed.registry, observed.artifact.abi, 'Bound', observed.expected);
  // A mined receipt is retained in private storage even when finality lags.
  // Reinspect that exact history at a finalized head before reporting success.
  const submitted = appendRecoveryEvent(appendRecoveryEvent(observed.recovery, 'bind'), 'bind', hash);
  const finalized = await inspectBrowserRecovery(pub, submitted, safety);
  if (!finalized.bound) throw new Error('Binding not finalized; inspect the saved hash before retrying');
  return { state: 'bound' as const, triggerId: observed.triggerId, postHash: observed.postHash, bindingHash: hash };
}
