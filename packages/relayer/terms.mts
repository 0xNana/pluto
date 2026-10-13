import { getAddress, recoverTypedDataAddress, zeroAddress, type Hex } from 'viem';
import { layerLenForPayload, parseConditionRecord, SPONSORED_DOMAIN_NAME, SPONSORED_DOMAIN_VERSION,
  SPONSORED_POST_TYPES, sponsoredPostMessage, type Authorization, type PostSealedArgs } from '@nillion/covenants-sdk';
import { policy } from '../../config/policy.mjs';
import { reportIdFor } from '../../src/shared/disclosure.mjs';
import { registryDomain, registryTypes } from '../../src/shared/registry-authorization.mjs';
import { hex } from '../client/notice.mts';

export interface RegistryGrant { researcher: Hex; payer: Hex; nonce: bigint; deadline: bigint; signature: Hex }
export interface SponsoredBundle { reportId: Hex; cipherHash: Hex; keyCommit: Hex; args: PostSealedArgs; authorization: Authorization; registration: RegistryGrant }
export interface SponsorPolicy { market: Hex; registry: Hex; payer: Hex; nowUnix: bigint; maxCeilingWei: bigint;
  maxHookGas: number; maxRetryWindowSecs: number; maxM: number; maxPlaintextBytes: bigint; maxCiphertextBytes: bigint }
export async function validateSponsoredBundle(bundle: SponsoredBundle, limits: SponsorPolicy) {
  const { args, authorization: auth, registration: grant } = bundle;
  const payer = getAddress(limits.payer), registry = getAddress(limits.registry), author = getAddress(auth.author);
  if (payer === zeroAddress || author === zeroAddress || getAddress(auth.payer) !== payer || getAddress(grant.payer) !== payer || getAddress(grant.researcher) !== author) throw new Error('Sponsor author or refund payer mismatch');
  hex(bundle.reportId, 32); hex(bundle.cipherHash, 32); hex(bundle.keyCommit, 32); hex(auth.signature, 65); hex(grant.signature, 65);
  if (reportIdFor(author, bundle.cipherHash, bundle.keyCommit) !== bundle.reportId) throw new Error('Report commitment mismatch');
  if (args.mode !== 'PUBLIC_CONDITION' || args.ttl !== 0 || !args.publicCondition || !args.t1 || !args.t2
      || args.t1 < limits.nowUnix + BigInt(policy.marginSecs) || args.t2 - args.t1 < BigInt(policy.minimumWindowSecs)
      || getAddress(args.hook ?? zeroAddress) !== registry || args.noBounty === true || args.skipLivenessCheck === true || args.allowUndeployedHook === true) throw new Error('Invalid sponsored disclosure terms');
  const condition = parseConditionRecord(args.publicCondition);
  if (condition.t1 !== args.t1 || condition.t2 !== args.t2 || args.publicCondition.length !== 52) throw new Error('Sponsored window record mismatch');
  const timeOnly = (await import('@nillion/covenants-sdk')).compileCondition({ window: { t1: args.t1, t2: args.t2 } });
  if (args.publicCondition.some((byte, i) => byte !== timeOnly[i])) throw new Error('Only time conditions are permitted');
  const m = args.keys.length, layerLength = layerLenForPayload(64, 'PUBLIC_CONDITION');
  if (!Number.isInteger(args.k) || args.k < 1 || m <= args.k || m > limits.maxM || args.layers.length !== m
      || new Set(args.keys.map(key => String(key.keyId))).size !== m || new Set(args.keys.map(key => String(key.nodeId))).size !== m
      || args.layers.some(layer => !(layer instanceof Uint8Array) || BigInt(layer.length) !== layerLength)
      || limits.maxPlaintextBytes < 96n || layerLength * BigInt(m) > limits.maxCiphertextBytes) throw new Error('Sponsored committee or wire size invalid');
  if (args.ceilingWei < auth.minCeiling || args.ceilingWei > limits.maxCeilingWei || args.ceilingWei < 1n
      || (args.hookGasLimit ?? 0) > limits.maxHookGas || (args.retryWindowSecs ?? 0) > limits.maxRetryWindowSecs) throw new Error('Sponsored spending exceeds live policy');
  if (auth.deadline <= limits.nowUnix || grant.deadline <= limits.nowUnix || auth.deadline >= args.t1 || grant.deadline >= args.t1 || auth.nonce < 0n || grant.nonce < 0n) throw new Error('Expired or invalid sponsor grant');
  const marketAuthor = await recoverTypedDataAddress({ domain: { name: SPONSORED_DOMAIN_NAME, version: SPONSORED_DOMAIN_VERSION,
    chainId: 11155111, verifyingContract: limits.market }, types: SPONSORED_POST_TYPES, primaryType: 'SponsoredPost', message: sponsoredPostMessage(args, auth), signature: auth.signature });
  const registrationAuthor = await recoverTypedDataAddress({ domain: registryDomain(11155111, registry), types: { RegisterReport: registryTypes.RegisterReport },
    primaryType: 'RegisterReport', message: { cipherHash: bundle.cipherHash, keyCommit: bundle.keyCommit, t1: args.t1, t2: args.t2,
      researcher: grant.researcher, payer: grant.payer, nonce: grant.nonce, deadline: grant.deadline }, signature: grant.signature });
  if (getAddress(marketAuthor) !== author || getAddress(registrationAuthor) !== author) throw new Error('Sponsor authorization signature mismatch');
  return { author, payer, refundDestination: payer, reportId: bundle.reportId, nonce: auth.nonce };
}
