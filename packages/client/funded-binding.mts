import { encodeFunctionData, parseEventLogs, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { postParamsTuple, resolveAddresses } from '@nillion/covenants-sdk/browser';
import type { RegistryArtifact } from './deployment.mts';
import { SEPOLIA_CONFIG } from '../../config/deployment.mjs';
import { verifyHookDeployment } from '../../src/chain/registry-verification.mjs';
import { savedSealArgs, validateBrowserRecovery, fundingRequestId, type BrowserRecovery } from './recovery.mts';
import { parseSponsorInput, type BindingGrant } from './sponsor-wire.mts';
import { decodeWire } from './wire.mts';
import { object, hex } from './notice.mts';
import { signRegistryAction, registryDomain } from '../../src/shared/registry-authorization.mjs';
import { policy } from '../../config/policy.mjs';

interface Safety { expectedMarket: Hex; artifact: RegistryArtifact; marketAbi: RegistryArtifact['abi'] }
const same = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
export async function inspectFundedBinding(pub: PublicClient, recovery: BrowserRecovery, proof: { postHash: Hex; triggerId: bigint }, safety: Safety) {
  const local = await validateBrowserRecovery(recovery);
  if (!local.sealing || !local.funding || fundingRequestId(local) !== local.funding.id) throw new Error('Active saved funded request required');
  const input = parseSponsorInput(object(decodeWire(local.funding.body)).input), args = savedSealArgs(local);
  if (await pub.getChainId() !== 11155111) throw new Error('Funded recovery requires Sepolia');
  const addresses = await resolveAddresses(pub, SEPOLIA_CONFIG);
  if (!same(addresses.market, safety.expectedMarket) || !same(addresses.market, local.sealing.market)) throw new Error('Funded deployment changed');
  await verifyHookDeployment(pub, local.sealing.registry, safety.artifact, addresses.market);
  const head = await pub.getBlock({ blockTag: 'finalized' });
  if (typeof head.number !== 'bigint' || head.number < 0n) throw new Error('Finalized head unavailable'); hex(head.hash, 32);
  const postHash = hex(proof.postHash, 32), payer = input.bundle.authorization.payer;
  const [tx, receipt] = await Promise.all([pub.getTransaction({ hash: postHash }), pub.getTransactionReceipt({ hash: postHash })]);
  const data = encodeFunctionData({ abi: safety.marketAbi, functionName: 'postTriggerSponsored', args: [postParamsTuple(args), input.bundle.authorization] });
  if (tx.hash !== postHash || receipt.transactionHash !== postHash || !same(tx.from, payer) || !same(tx.to, addresses.market) || tx.input !== data
    || typeof tx.value !== 'bigint' || tx.value < 0n || receipt.status !== 'success' || typeof receipt.blockNumber !== 'bigint' || receipt.blockNumber < 0n
    || receipt.blockNumber > head.number || (await pub.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error('Canonical funded post proof unavailable');
  const events = parseEventLogs({ abi: safety.marketAbi, eventName: 'TriggerPosted', logs: receipt.logs, strict: true }).filter(event => same(event.address, addresses.market) && !event.removed);
  const emitted = events.length === 1 ? object(events[0].args) : {};
  if (emitted.triggerId !== proof.triggerId || !same(emitted.author, local.report.researcher) || emitted.commit !== args.commit || emitted.mode !== 1
    || emitted.t1 !== args.t1 || emitted.t2 !== args.t2 || emitted.expiry !== args.t2) throw new Error('Funded event terms mismatch');
  const request = (address: Hex, abi: RegistryArtifact['abi'], functionName: string, callArgs: unknown[]) => pub.readContract({ address, abi, functionName, args: callArgs, blockNumber: head.number! });
  const [raw, binding, hook, parties] = await Promise.all([
    request(local.sealing.registry, safety.artifact.abi, 'statusOf', [local.report.reportId]), request(local.sealing.registry, safety.artifact.abi, 'bindings', [proof.triggerId]),
    request(addresses.market, safety.marketAbi, 'hookMeta', [proof.triggerId]), request(addresses.market, safety.marketAbi, 'postingParties', [proof.triggerId]),
  ]);
  const record = object(raw);
  if (!same(record.researcher, local.report.researcher) || record.cipherHash !== local.report.cipherHash || record.keyCommit !== local.report.keyCommit
    || record.t1 !== args.t1 || record.t2 !== args.t2 || typeof record.registeredAt !== 'bigint' || record.registeredAt <= 0n
    || !Array.isArray(binding) || typeof binding[1] !== 'boolean' || typeof record.bindTime !== 'bigint'
    || (binding[1] && (!same(binding[0], local.report.reportId) || record.lastTriggerId !== proof.triggerId || record.bindTime === 0n)) || (!binding[1] && record.bindTime !== 0n)
    || !Array.isArray(hook) || !same(hook[0], local.sealing.registry) || !Array.isArray(parties) || !same(parties[0], local.report.researcher) || !same(parties[1], payer)
    || (await pub.getBlock({ blockNumber: head.number })).hash !== head.hash) throw new Error('Funded registry, parties or finality mismatch');
  return { recovery: local, args, payer, registry: local.sealing.registry, artifact: safety.artifact, bound: binding[1], triggerId: proof.triggerId, postHash };
}
export async function priceFundedBinding(pub: PublicClient, observed: Awaited<ReturnType<typeof inspectFundedBinding>>) {
  if (observed.bound) throw new Error('Binding already finalized');
  const now = (await pub.getBlock()).timestamp;
  if (typeof now !== 'bigint' || now < 0n || now + 1n >= observed.args.t1!) throw new Error('Existing binding window elapsed');
  const author = privateKeyToAccount(observed.recovery.authorKey); let nonce = 0n, found = false;
  for (let i = 0; i < 32; i++, nonce++) {
    const used = await pub.readContract({ address: observed.registry, abi: observed.artifact.abi, functionName: 'authorizationUsed', args: [author.address, nonce] });
    if (typeof used !== 'boolean') throw new Error('Binding nonce unavailable'); if (!used) { found = true; break; }
  }
  if (!found) throw new Error('Binding nonce scan exhausted');
  const deadline = now + 300n < observed.args.t1! ? now + 300n : observed.args.t1! - 1n;
  const grant: BindingGrant = { ...await signRegistryAction(author, registryDomain(11155111, observed.registry), 'BindReport',
    { reportId: observed.recovery.report.reportId, triggerId: observed.triggerId }, { payer: observed.payer, nonce, deadline }), triggerId: observed.triggerId };
  const request = { address: observed.registry, abi: observed.artifact.abi, functionName: 'bindBySig', args: [observed.recovery.report.reportId, observed.triggerId, grant], account: observed.payer };
  await pub.simulateContract(request);
  const [estimate, fees] = await Promise.all([pub.estimateContractGas(request), pub.estimateFeesPerGas()]);
  if (typeof estimate !== 'bigint' || estimate <= 0n || typeof fees.maxFeePerGas !== 'bigint' || fees.maxFeePerGas <= 0n
    || typeof fees.maxPriorityFeePerGas !== 'bigint' || fees.maxPriorityFeePerGas < 0n || fees.maxPriorityFeePerGas > fees.maxFeePerGas) throw new Error('Live binding cost unavailable');
  const gasLimit = estimate * BigInt(policy.gasHeadroomBps) / 10000n + 1n;
  return { grant, gasLimit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, gasWei: gasLimit * fees.maxFeePerGas };
}
