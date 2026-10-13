import { getAddress } from 'viem';

export function sepoliaSubmissionsEnabled(environment = process.env) {
  const value = environment.SEPOLIA_SUBMISSIONS;
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error('SEPOLIA_SUBMISSIONS must be true or false');
}

export function publicBrowserRpc(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Configure an explicitly public HTTPS browser RPC');
  return url.href;
}

export function developmentOrigin(environment = process.env) {
  const origin = new URL(environment.DEV_ORIGIN || 'http://localhost:3000');
  if (origin.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
      || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Development origin must be HTTP loopback');
  return origin.origin;
}

export function developmentConnection(environment = process.env) {
  const writesEnabled = sepoliaSubmissionsEnabled(environment);
  const origin = developmentOrigin(environment);
  const names = ['RPC_URL', 'PUBLIC_RPC_URL', 'EXPECTED_MARKET', 'REGISTRY_ADDRESS', 'REGISTRY_FIRST_BLOCK'];
  if (names.some(name => !environment[name])) {
    if (writesEnabled) throw new Error('Sepolia submissions require configured RPC_URL, PUBLIC_RPC_URL, EXPECTED_MARKET, REGISTRY_ADDRESS and REGISTRY_FIRST_BLOCK');
    return undefined;
  }
  if (!/^(0|[1-9][0-9]*)$/.test(environment.REGISTRY_FIRST_BLOCK)) throw new Error('Invalid registry first block');
  return { origin, rpcUrl: environment.RPC_URL, publicRpcUrl: publicBrowserRpc(environment.PUBLIC_RPC_URL),
    expectedMarket: getAddress(environment.EXPECTED_MARKET), registry: getAddress(environment.REGISTRY_ADDRESS),
    registryFirstBlock: BigInt(environment.REGISTRY_FIRST_BLOCK), writesEnabled };
}
