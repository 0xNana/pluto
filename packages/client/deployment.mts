import { fetchCandidates, resolveAddresses } from '@nillion/covenants-sdk/browser';
import { getAddress, type Abi, type Hex, type PublicClient } from 'viem';
import { SEPOLIA_CONFIG } from '../../config/deployment.mjs';
import { verifyHookDeployment } from '../../src/chain/registry-verification.mjs';

export interface RegistryArtifact { abi: Abi; runtimeBytecode: Hex; immutableReferences: Record<string, { start: number; length: number }[]>; compiler: string }
export async function checkReadDeployment(pub: PublicClient, expectedMarket: Hex, registry: Hex, artifact: RegistryArtifact) {
  if (await pub.getChainId() !== 11155111) throw new Error('Development client requires Sepolia');
  const addresses = await resolveAddresses(pub, SEPOLIA_CONFIG);
  if (getAddress(addresses.market) !== getAddress(expectedMarket)) throw new Error('Published market mismatch');
  await verifyHookDeployment(pub, registry, artifact, addresses.market);
  return addresses;
}
export async function checkDeployment(pub: PublicClient, expectedMarket: Hex, registry: Hex, artifact: RegistryArtifact) {
  const addresses = await checkReadDeployment(pub, expectedMarket, registry, artifact);
  if (!(await fetchCandidates(pub, addresses)).length) throw new Error('Current market has no candidates');
  return addresses;
}
