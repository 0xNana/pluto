import { hexToBytes } from 'viem';
import { encodeDisclosurePayload } from '../../src/shared/disclosure.mjs';
import { DeploymentError } from '../../src/chain/deployment.mjs';

export const adversarialScenarios = Object.freeze(['copy-foreign', 'unbound', 'wrong-key']);

export function selectAdversarialScenarios(selection = adversarialScenarios) {
  if (!Array.isArray(selection) || !selection.length || new Set(selection).size !== selection.length
      || selection.some(name => !adversarialScenarios.includes(name))) {
    throw new DeploymentError('Choose unique known scenarios: copy-foreign, unbound, wrong-key');
  }
  return adversarialScenarios.filter(name => selection.includes(name));
}

// PUBLIC mode keeps the condition outside the encrypted shares. Reuse the
// original SDK-selected slots and ciphertext to copy all 96 plaintext bytes,
// including the nonce, without depending on unexported cryptographic APIs.
export function copyPublicSeal(params, conditionRecord) {
  if (params.mode !== 1) throw new TypeError('Only public-condition ciphertext can be copied');
  if (!Array.isArray(params.layers) || params.layers.length !== params.keyIds?.length || !params.layers.length) {
    throw new TypeError('Copied layers must match the original key slots');
  }
  return { layers: params.layers.map(hexToBytes), commit: params.commit, publicCondition: conditionRecord };
}

export function rejectionPayload(scenario, key, reportId) {
  if (!['unbound', 'wrong-key'].includes(scenario)) throw new TypeError('Unknown rejection scenario');
  const payload = encodeDisclosurePayload(key, reportId);
  if (scenario === 'wrong-key') payload[0] ^= 255;
  return payload;
}
