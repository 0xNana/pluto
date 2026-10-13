import { getAddress, hexToBytes, keccak256, toHex, zeroAddress } from 'viem';
import { compileCondition } from '@nillion/covenants-sdk/browser';
import { DeploymentError } from '../../src/chain/deployment.mjs';
import { revertedName } from './probe-runtime.mjs';

export function assertSponsorshipBudget(args, authorization, ceilingCap) {
  if (getAddress(authorization.payer) === zeroAddress) throw new DeploymentError('Sponsorship requires a designated payer');
  // SDK signatures bind a floor, not an upper spending limit. Enforce our cap
  // separately immediately before handing the package to the paying wallet.
  if (args.ceilingWei < authorization.minCeiling || args.ceilingWei > ceilingCap) {
    throw new DeploymentError('Sponsored ceiling exceeds the approved budget or signed minimum');
  }
}

export function sponsoredMutations(params, authorization, { alternateHook }) {
  const window = { t1: params.t1 + 1n, t2: params.t2 + 1n };
  const change = (label, patch = {}, grant = {}) => ({ label, params: { ...params, ...patch },
    authorization: { ...authorization, ...grant }, errors: ['BadAuthSignature'] });
  return [change('sealed commitment', { commit: keccak256(params.commit) }),
    change('window', { ...window, publicCondition: toHex(compileCondition({ window })) }),
    change('hook', { hook: alternateHook }), change('author', {}, { author: alternateHook }),
    change('payer and refund destination', {}, { payer: zeroAddress }),
    change('nonce', {}, { nonce: authorization.nonce + 1n }),
    change('deadline', {}, { deadline: authorization.deadline + 1n }),
    change('minimum ceiling', {}, { minCeiling: authorization.minCeiling - 1n })];
}

export function boundaryCases(params, limits, nowUnix) {
  const maximum = BigInt(limits.maxCiphertextBytes);
  if (maximum < 1n || maximum > 16_000_000n) throw new DeploymentError('Ciphertext limit exceeds safe probe allocation');
  const oversized = new Uint8Array(Number(maximum + 1n));
  const original = hexToBytes(params.layers[0]);
  if (original.length > oversized.length) throw new DeploymentError('Control ciphertext already exceeds the live maximum');
  oversized.set(original); // Preserve the valid wire header while exceeding the length bound.
  const past = { t1: nowUnix - 2n, t2: nowUnix - 1n };
  return [
    { label: 'public TTL forbidden', params: { ...params, ttl: 1 }, errors: ['TtlForbidden'] },
    { label: 'expired public window', params: { ...params, ...past,
      publicCondition: toHex(compileCondition({ window: past })) }, errors: ['BadWindow'] },
    { label: 'window tuple differs from SDK record', params: { ...params, t1: params.t1 + 1n }, errors: ['WindowMismatch'] },
    { label: 'reversed window', params: { ...params, t2: params.t1 - 1n }, errors: ['BadWindow', 'WindowMismatch'] },
    { label: 'hook gas over maximum', params: { ...params, hookGasLimit: Number(limits.maxHookGas) + 1 }, errors: ['HookGasTooLarge'] },
    { label: 'hook retry over maximum', params: { ...params, retryWindowSecs: Number(limits.maxRetryWindowSecs) + 1 }, errors: ['RetryWindowTooLong'] },
    { label: 'ciphertext over maximum', params: { ...params,
      layers: [toHex(oversized), ...params.layers.slice(1)] }, errors: ['CiphertextTooLarge'] },
  ];
}

// Explore wire-width boundaries through eth_call only. If an extreme is rejected,
// report that result; it does not identify an undisclosed intermediate maximum.
export async function simulateWindowWidths(pub, control, onCheck = async () => {}) {
  await pub.simulateContract(control);
  const params = control.args[0];
  const results = [];
  for (const [label, t2] of [['one-second public window', params.t1 + 1n],
    ['uint64-end public window', (1n << 64n) - 1n]]) {
    const window = { t1: params.t1, t2 };
    const result = { label, ...window, widthSecs: t2 - params.t1, outcome: 'accepted' };
    try {
      await pub.simulateContract({ ...control, args: [{ ...params, ...window,
        publicCondition: toHex(compileCondition({ window })) }] });
    } catch (error) {
      const name = revertedName(error);
      if (!['BadWindow', 'TtlOutOfRange'].includes(name)) throw error;
      Object.assign(result, { outcome: 'rejected', error: name });
    }
    results.push(result);
    await onCheck(result);
  }
  return results;
}

// All controls are eth_call simulations. A funding/RPC error or an unexpected
// revert cannot count as rejection evidence for the term being tested.
export async function simulateRejections(pub, control, cases, onCheck = async () => {}) {
  await pub.simulateContract(control);
  const results = [{ label: 'valid control', passed: true }];
  await onCheck(results[0]);
  for (const item of cases) {
    const args = item.args ?? (item.authorization ? [item.params, item.authorization] : [item.params]);
    try { await pub.simulateContract({ ...control, args }); } catch (error) {
      const name = revertedName(error);
      if (!item.errors.includes(name)) throw error;
      const result = { label: item.label, error: name };
      results.push(result);
      await onCheck(result);
      continue;
    }
    throw new DeploymentError(`Simulation unexpectedly accepted: ${item.label}`);
  }
  return results;
}
