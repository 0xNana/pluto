import { getAddress, keccak256, toHex, type Hex } from 'viem';
import { compileCondition, layerLenForPayload } from '@nillion/covenants-sdk/browser';
import { exact, hex, object } from './notice.mts';
import type { SponsoredBundle, RegistryGrant } from '../relayer/terms.mts';

export interface BindingGrant extends RegistryGrant { triggerId: bigint }
export interface SponsorInput { protocolId: string; bundle: SponsoredBundle; binding: BindingGrant }
export interface SponsorBounds { requestHash: Hex; ethReserveWei: bigint; feeNil: bigint }
export function uint(value: unknown, bits = 256): bigint {
  if (typeof value !== 'bigint' || value < 0n || value >= 1n << BigInt(bits)) throw new Error('Invalid sponsored integer');
  return value;
}
function number(value: unknown, bits: number) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value >= 2 ** bits) throw new Error('Invalid sponsored number');
  return value;
}
export function protocolDomain(value: unknown) {
  if (typeof value !== 'string' || value.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value)) throw new Error('Invalid protocol domain');
  return value;
}
export function parseBindingGrant(raw: unknown): BindingGrant {
  const value = object(raw); exact(value, ['researcher', 'payer', 'nonce', 'deadline', 'signature', 'triggerId']);
  return { ...grant(value), triggerId: uint(value.triggerId) };
}
function grant(value: Record<string, unknown>): RegistryGrant {
  return { researcher: getAddress(hex(value.researcher, 20)), payer: getAddress(hex(value.payer, 20)), nonce: uint(value.nonce), deadline: uint(value.deadline, 64), signature: hex(value.signature, 65) };
}
// This boundary rejects entire recovery files and extra fields at every level.
// Committee metadata is intentionally reduced to the three SDK posting fields.
export function parseSponsorInput(raw: unknown): SponsorInput {
  const value = object(raw); exact(value, ['protocolId', 'bundle', 'binding']);
  const bundle = object(value.bundle); exact(bundle, ['reportId', 'cipherHash', 'keyCommit', 'args', 'authorization', 'registration']);
  const args = object(bundle.args);
  exact(args, ['mode', 'ttl', 'keys', 'k', 't1', 't2', 'ceilingWei', 'hook', 'hookGasLimit', 'retryWindowSecs', 'layers', 'commit', 'publicCondition']);
  if (args.mode !== 'PUBLIC_CONDITION' || args.ttl !== 0 || !Array.isArray(args.keys) || !Array.isArray(args.layers)
    || args.keys.length > 255 || args.keys.length !== args.layers.length || args.keys.length <= number(args.k, 8)) throw new Error('Invalid sponsored wire terms');
  const keys = args.keys.map(rawKey => { const key = object(rawKey); exact(key, ['keyId', 'nodeId', 'mpk']);
    if (typeof key.mpk !== 'string' || !/^0x(?:[a-fA-F0-9]{2})+$/.test(key.mpk) || key.mpk.length > 1026) throw new Error('Invalid sponsored key');
    return { keyId: uint(key.keyId), nodeId: uint(key.nodeId), mpk: key.mpk as Hex };
  });
  const layers = args.layers.map(layer => { if (!(layer instanceof Uint8Array) || layer.length !== Number(layerLenForPayload(64, 'PUBLIC_CONDITION'))) throw new Error('Invalid sponsored layer'); return layer; });
  const t1 = uint(args.t1, 64), t2 = uint(args.t2, 64), condition = compileCondition({ window: { t1, t2 } });
  if (!(args.publicCondition instanceof Uint8Array) || toHex(args.publicCondition) !== toHex(condition)) throw new Error('Invalid sponsored window');
  const auth = object(bundle.authorization), registration = object(bundle.registration);
  exact(auth, ['author', 'payer', 'minCeiling', 'nonce', 'deadline', 'signature']); exact(registration, ['researcher', 'payer', 'nonce', 'deadline', 'signature']);
  return { protocolId: protocolDomain(value.protocolId), binding: parseBindingGrant(value.binding), bundle: {
    reportId: hex(bundle.reportId, 32), cipherHash: hex(bundle.cipherHash, 32), keyCommit: hex(bundle.keyCommit, 32),
    args: { mode: 'PUBLIC_CONDITION', ttl: 0, keys, k: Number(args.k), t1, t2, ceilingWei: uint(args.ceilingWei), hook: getAddress(hex(args.hook, 20)),
      hookGasLimit: number(args.hookGasLimit, 32), retryWindowSecs: number(args.retryWindowSecs, 32), layers, commit: hex(args.commit, 32), publicCondition: args.publicCondition },
    authorization: { author: getAddress(hex(auth.author, 20)), payer: getAddress(hex(auth.payer, 20)), minCeiling: uint(auth.minCeiling), nonce: uint(auth.nonce), deadline: uint(auth.deadline, 64), signature: hex(auth.signature, 65) }, registration: grant(registration),
  } };
}
export function sponsorReleaseMessage(origin: string, protocolId: string, bounds: SponsorBounds) {
  const url = new URL(origin); if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('Invalid sponsor origin');
  return ['Pluto sponsored disclosure release v1', `Origin: ${origin}`, 'Chain: 11155111', `Protocol: ${protocolDomain(protocolId)}`,
    `Request: ${hex(bounds.requestHash, 32)}`, `Maximum reserved ETH wei: ${uint(bounds.ethReserveWei)}`, `Maximum NIL units: ${uint(bounds.feeNil)}`,
    'I authorize this exact immutable disclosure after reviewing costs and saving private recovery. No cancellation, extension or amendment.'].join('\n');
}
export const sponsorRequestId = (message: string) => keccak256(toHex(message));
export function sponsorProofMessage(origin: string, id: Hex, action: 'status' | 'withdraw' | 'binding', expires: number) {
  if (!['status', 'withdraw', 'binding'].includes(action) || !Number.isSafeInteger(expires) || expires <= 0) throw new Error('Invalid sponsor proof');
  const url = new URL(origin); if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('Invalid sponsor origin');
  return `Pluto sponsored request ${action} v1\nOrigin: ${origin}\nChain: 11155111\nRequest: ${hex(id, 32)}\nExpires: ${expires}\n${action === 'withdraw' ? 'Withdraw only an unsubmitted funding request; no posted deadline changes.' : action === 'status' ? 'Read only; this does not authorize spending.' : 'Recover only this existing funded binding; no new post.'}`;
}
