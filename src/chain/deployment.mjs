import { getAddress, isAddress, zeroAddress } from 'viem';
import { fetchCandidates, resolveAddresses } from '@nillion/covenants-sdk';

// Pin only C0. The market is resolved, then compared with the current docs.
import { SEPOLIA_CONFIG } from '../../config/deployment.mjs';
export { SEPOLIA_CONFIG } from '../../config/deployment.mjs';

import { DeploymentError } from '../shared/errors.mjs';
export { DeploymentError } from '../shared/errors.mjs';

export async function resolveSepolia(publicClient, expectedMarket) {
  if (!isAddress(expectedMarket ?? '') || expectedMarket.toLowerCase() === zeroAddress) {
    throw new DeploymentError('EXPECTED_MARKET must be the current published market address');
  }
  if (await publicClient.getChainId() !== 11155111) {
    throw new DeploymentError('Pluto requires Sepolia (chain 11155111)');
  }
  const addresses = await resolveAddresses(publicClient, SEPOLIA_CONFIG);
  if (getAddress(addresses.market) !== getAddress(expectedMarket)) {
    throw new DeploymentError('Resolved market does not match the current published market');
  }
  return addresses;
}

export async function inspectSepolia(publicClient, expectedMarket) {
  const addresses = await resolveSepolia(publicClient, expectedMarket);
  const candidates = await fetchCandidates(publicClient, addresses);
  if (candidates.length === 0) {
    throw new DeploymentError('Current deployment has no candidates; do not post');
  }
  return { addresses, candidates };
}
