import { hexToBytes, keccak256, toHex, type Hex } from 'viem';
import { compileCondition, layerLenForPayload, type BrowserCrypto, type Committee, type PostSealedArgs } from '@nillion/covenants-sdk/browser';
import { validateRecoveryBundle } from '../../src/shared/report-crypto.mjs';
import { publicUrl } from './notice.mts';

export interface SealPlan { committee: Committee; t1: bigint; t2: bigint; ceilingWei: bigint; registry: Hex;
  hookGasLimit: number; retryWindowSecs: number; maxPlaintextBytes: bigint; maxCiphertextBytes: bigint }
export async function sealLocalReport(crypto: BrowserCrypto, recovery: unknown, uris: readonly string[], plan: SealPlan) {
  const report = await validateRecoveryBundle(recovery);
  if (uris.length < 2 || new Set(uris).size !== uris.length) throw new Error('Verify two independent ciphertext copies first');
  uris.forEach(uri => publicUrl(uri));
  const payload = new Uint8Array(64); payload.set(hexToBytes(report.key), 0); payload.set(hexToBytes(report.reportId), 32);
  if (plan.committee.keys.length <= plan.committee.k || plan.maxPlaintextBytes < BigInt(payload.length + 32)
      || layerLenForPayload(payload.length, 'PUBLIC_CONDITION') * BigInt(plan.committee.keys.length) > plan.maxCiphertextBytes) throw new Error('Local seal exceeds live protocol limits');
  const condition = compileCondition({ window: { t1: plan.t1, t2: plan.t2 } });
  const sealed = crypto.seal(payload, 'PUBLIC_CONDITION', condition, plan.committee.k, plan.committee.keys.map(key => hexToBytes(key.mpk)));
  if (sealed.nonce.length !== 32 || sealed.commit !== keccak256(new Uint8Array([...payload, ...sealed.nonce]))
      || !sealed.publicCondition || toHex(sealed.publicCondition) !== toHex(condition)) throw new Error('SDK seal commitments differ');
  const args: PostSealedArgs = { mode: 'PUBLIC_CONDITION', ttl: 0, keys: plan.committee.keys, k: plan.committee.k,
    t1: plan.t1, t2: plan.t2, ceilingWei: plan.ceilingWei, hook: plan.registry, hookGasLimit: plan.hookGasLimit,
    retryWindowSecs: plan.retryWindowSecs, layers: sealed.layers, commit: sealed.commit, publicCondition: sealed.publicCondition };
  return { args, recovery: { version: 1, report, cipherUris: [...uris], nonce: toHex(sealed.nonce), commit: sealed.commit } };
}
