import { encodeFunctionData, getAddress, keccak256, toHex, type Abi, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { authorKeySigner, nextAuthNonce, signPostAuthorization, resolveAddresses, quoteProtocolFee, quoteEscrow, maxLayerLen, postParamsTuple } from '@nillion/covenants-sdk/browser';
import { signRegistryAction, registryDomain } from '../../src/shared/registry-authorization.mjs';
import { checkDeployment, type RegistryArtifact } from './deployment.mts';
import { validateBrowserRecovery, savedSealArgs, fundingRequestId, type BrowserRecovery } from './recovery.mts';
import { parseSponsorInput, sponsorReleaseMessage, sponsorRequestId, sponsorProofMessage, uint, type SponsorInput, type SponsorBounds } from './sponsor-wire.mts';
import { encodeWire, decodeWire } from './wire.mts';
import { object, hex } from './notice.mts';
import { assertPostConsent, type PostConsent } from './posting.mts';
import { policy } from '../../config/policy.mjs';
import { SEPOLIA_CONFIG } from '../../config/deployment.mjs';
import { quoteTransactionCosts, type CostCall } from '../planner/costs.mts';

// Signing is local. Only the exact public posting package leaves the browser.
export async function prepareSponsorship(pub: PublicClient, recovery: BrowserRecovery, protocolId: string, payer: Hex,
  config: { expectedMarket: Hex; artifact: RegistryArtifact; marketAbi: RegistryArtifact['abi']; nonceFloor?: bigint }) {
  const local = await validateBrowserRecovery(recovery);
  if (!local.sealing) throw new Error('Save sealed recovery first');
  const addresses = await checkDeployment(pub, config.expectedMarket, local.sealing.registry, config.artifact), args = savedSealArgs(local);
  if (getAddress(addresses.market) !== getAddress(local.sealing.market)) throw new Error('Sealed deployment changed');
  const now = (await pub.getBlock()).timestamp;
  if (typeof now !== 'bigint' || now < 0n || !args.t1 || args.t1 < now + BigInt(policy.marginSecs)) throw new Error('Fresh immutable window required');
  const account = privateKeyToAccount(local.authorKey), nonce = await nextAuthNonce(pub, addresses.market, account.address, { startAt: config.nonceFloor ?? 0n, scanLimit: 32 });
  let registryNonce = nonce * 2n;
  const freeNonce = async () => {
    for (let i = 0; i < 32; i++, registryNonce++) {
      const used = await pub.readContract({ address: local.sealing!.registry, abi: config.artifact.abi, functionName: 'authorizationUsed', args: [account.address, registryNonce] });
      if (typeof used !== 'boolean') throw new Error('Registry nonce unavailable');
      if (!used) return registryNonce++;
    }
    throw new Error('Registry nonce scan exhausted');
  };
  // The SDK warns and continues on failed committee reads. Redact transport
  // errors and refuse the resulting grant if any preflight failed.
  let preflightFailed = false;
  const checked = { ...pub, readContract: async (request: Parameters<PublicClient['readContract']>[0]) => {
    try {
      const result = await pub.readContract(request);
      if ((request.functionName === 'isUsableKey' && result !== true) || (request.functionName === 'isEligibleStake' && (!Array.isArray(result) || result[0] !== true))) preflightFailed = true;
      return result;
    } catch { preflightFailed = true; throw new Error('Sponsored signing preflight unavailable'); }
  } } as PublicClient;
  const authorization = await signPostAuthorization(checked, authorKeySigner({ address: account.address, privateKey: local.authorKey }), addresses,
    { ...args, payer: getAddress(payer), minCeilingWei: args.ceilingWei, nonce, deadlineSecs: Number(args.t1 - now - 1n < 1800n ? args.t1 - now - 1n : 1800n) });
  if (preflightFailed || authorization.deadline >= args.t1) throw new Error('Sponsored signing preflight unavailable');
  const registration = await signRegistryAction(account, registryDomain(11155111, local.sealing.registry), 'RegisterReport',
    { cipherHash: local.report.cipherHash, keyCommit: local.report.keyCommit, t1: args.t1, t2: args.t2 }, { payer, nonce: await freeNonce(), deadline: authorization.deadline });
  const triggerId = uint(await pub.readContract({ address: addresses.market, abi: config.marketAbi, functionName: 'nextTriggerId' }));
  const binding = { ...await signRegistryAction(account, registryDomain(11155111, local.sealing.registry), 'BindReport',
    { reportId: local.report.reportId, triggerId }, { payer, nonce: await freeNonce(), deadline: authorization.deadline }), triggerId };
  return parseSponsorInput({ protocolId, bundle: { reportId: local.report.reportId, cipherHash: local.report.cipherHash, keyCommit: local.report.keyCommit,
    args: { ...args, keys: args.keys.map(({ keyId, nodeId, mpk }) => ({ keyId, nodeId, mpk })) }, authorization, registration }, binding });
}
export async function sponsorApi(origin: string, path: string, body?: unknown, fetcher: typeof fetch = fetch) {
  const base = new URL(origin); if (base.protocol !== 'https:' || base.origin !== origin || !path.startsWith('/api/') || path.startsWith('//')) throw new Error('Invalid sponsorship endpoint');
  const response = await fetcher(new URL(path, origin), { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', redirect: 'error',
    headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : encodeWire(body), signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error('Sponsorship request unavailable');
  const contents = await response.text(); if (contents.length > 200_000) throw new Error('Oversized sponsorship response');
  return object(decodeWire(contents));
}
// Quote directly against the public RPC. Executable author grants do not go to
// the payer's server until both disclosure confirmations are complete.
export async function priceSponsorship(pub: PublicClient, input: SponsorInput, abis: { registry: Abi; market: Abi; nil: Abi }) {
  const { bundle, binding } = input, args = bundle.args, payer = bundle.authorization.payer;
  const addresses = await resolveAddresses(pub, SEPOLIA_CONFIG);
  const fee = await quoteProtocolFee(pub, addresses, payer), escrow = await quoteEscrow(pub, addresses.market, { mode: 'PUBLIC_CONDITION', keyIds: args.keys.map(key => key.keyId), k: args.k,
    maxLayerLen: maxLayerLen(args.layers), ceilingWei: args.ceilingWei, hook: args.hook, hookGasLimit: args.hookGasLimit, retryWindowSecs: args.retryWindowSecs });
  const calls: CostCall[] = [
    { action: 'register', payer, to: args.hook!, value: 0n, data: encodeFunctionData({ abi: abis.registry, functionName: 'registerBySig', args: [bundle.cipherHash, bundle.keyCommit, args.t1, args.t2, bundle.registration] }) },
    { action: 'approve', payer, to: addresses.nil, value: 0n, data: encodeFunctionData({ abi: abis.nil, functionName: 'approve', args: [addresses.market, fee.feeNil] }) },
    { action: 'post', payer, to: addresses.market, value: escrow.escrowWei, data: encodeFunctionData({ abi: abis.market, functionName: 'postTriggerSponsored', args: [postParamsTuple(args), bundle.authorization] }) },
    { action: 'bind', payer, to: args.hook!, value: 0n, data: encodeFunctionData({ abi: abis.registry, functionName: 'bindBySig', args: [bundle.reportId, binding.triggerId, binding] }) },
  ];
  const costs = await quoteTransactionCosts(pub, calls), caps = new Map(costs.items.map(item => [item.action, item.gasUnits * BigInt(policy.gasHeadroomBps) / 10000n + 1n]));
  const reservedGas = [...caps.values()].reduce((sum, gas) => sum + gas, 0n) + caps.get('post')! + BigInt(policy.bindingAttempts - 1) * caps.get('bind')!;
  return { costs, escrowWei: escrow.escrowWei, feeNil: fee.feeNil, ethReserveWei: escrow.escrowWei + reservedGas * costs.maxFeePerGas,
    payer, requestHash: keccak256(toHex(encodeWire({ bundle, binding }))) };
}
export function reviewedSponsorBounds(input: SponsorInput, response: Record<string, unknown>, payer: Hex): SponsorBounds {
  const requestHash = keccak256(toHex(encodeWire({ bundle: input.bundle, binding: input.binding })));
  if (hex(response.requestHash, 32) !== requestHash || getAddress(hex(response.payer, 20)) !== getAddress(payer)) throw new Error('Sponsored quote context changed');
  return { requestHash, ethReserveWei: uint(response.ethReserveWei), feeNil: uint(response.feeNil) };
}
export async function releaseSponsorship(origin: string, input: SponsorInput, bounds: SponsorBounds, recovery: BrowserRecovery, consent: PostConsent) {
  assertPostConsent(consent);
  const message = sponsorReleaseMessage(origin, input.protocolId, bounds), id = sponsorRequestId(message);
  const account = privateKeyToAccount(recovery.authorKey);
  if (getAddress(account.address) !== getAddress(input.bundle.authorization.author) || input.bundle.reportId !== recovery.report.reportId
    || bounds.requestHash !== keccak256(toHex(encodeWire({ bundle: input.bundle, binding: input.binding })))) throw new Error('Funding release context mismatch');
  return { id, body: { input, bounds, release: await account.signMessage({ message }) } };
}
export async function sponsorshipProof(origin: string, id: Hex, action: 'status' | 'withdraw' | 'binding', authorKey: Hex, now = Math.floor(Date.now() / 1000)) {
  const expires = now + 300;
  return { expires, signature: await privateKeyToAccount(authorKey).signMessage({ message: sponsorProofMessage(origin, id, action, expires) }) };
}
export async function uploadSavedSponsorship(origin: string, recovery: BrowserRecovery, fetcher: typeof fetch = fetch) {
  const local = await validateBrowserRecovery(recovery);
  if (!local.funding || local.funding.origin !== origin || fundingRequestId(local) !== local.funding.id) throw new Error('Exact local funding request unavailable');
  const result = await sponsorApi(origin, '/api/sponsorship/requests', decodeWire(local.funding.body), fetcher);
  if (result.id !== local.funding.id || !['pending', 'attempted', 'withdrawn'].includes(String(result.state))) throw new Error('Funding upload response context mismatch');
  return result;
}
