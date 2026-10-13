import { getAddress } from 'viem';

const grant = [
  { name: 'researcher', type: 'address' }, { name: 'payer', type: 'address' },
  { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' },
];
export const registryTypes = Object.freeze({
  RegisterReport: [
    { name: 'cipherHash', type: 'bytes32' }, { name: 'keyCommit', type: 'bytes32' },
    { name: 't1', type: 'uint64' }, { name: 't2', type: 'uint64' }, ...grant,
  ],
  BindReport: [{ name: 'reportId', type: 'bytes32' }, { name: 'triggerId', type: 'uint256' }, ...grant],
  RetryReport: [{ name: 'parentReportId', type: 'bytes32' },
    { name: 't1', type: 'uint64' }, { name: 't2', type: 'uint64' }, ...grant],
});

export function registryDomain(chainId, registry) {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new RangeError('Invalid chain ID');
  return { name: 'Pluto Registry', version: '1', chainId, verifyingContract: getAddress(registry) };
}

export async function signRegistryAction(signer, domain, action, fields, { payer, nonce, deadline }) {
  if (!registryTypes[action]) throw new TypeError('Unknown registry action');
  const message = { ...fields, researcher: signer.address, payer: getAddress(payer), nonce, deadline };
  const signature = await signer.signTypedData({ domain, types: { [action]: registryTypes[action] },
    primaryType: action, message });
  return { researcher: signer.address, payer: message.payer, nonce, deadline, signature };
}
