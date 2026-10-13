import type { WalletProvider } from './wallet-access.mts';
export interface DiscoveredWallet { id: string; name: string; provider: WalletProvider }
export function isWalletProvider(value: unknown): value is WalletProvider {
  if (!value || typeof value !== 'object') return false;
  const provider = value as Record<string, unknown>;
  return typeof provider.request === 'function' && typeof provider.on === 'function' && typeof provider.removeListener === 'function';
}
// Announced names are untrusted labels, not proof of a wallet's identity.
// No icons, remote URLs or wallet scripts are loaded.
export function discoverWallets(host: EventTarget & { ethereum?: unknown }, update: (wallets: DiscoveredWallet[]) => void) {
  const wallets: DiscoveredWallet[] = [];
  let count = 0;
  const add = (provider: WalletProvider, name: string) => {
    const existing = wallets.find(wallet => wallet.provider === provider);
    if (existing) existing.name = name;
    else if (wallets.length < 16) wallets.push({ id: `wallet-${++count}`, name, provider });
    update(wallets.map(wallet => ({ ...wallet })));
  };
  const announce = (event: Event) => {
    const detail: unknown = (event as CustomEvent<unknown>).detail;
    if (!detail || typeof detail !== 'object') return;
    const data = detail as Record<string, unknown>, info = data.info;
    if (!isWalletProvider(data.provider) || !info || typeof info !== 'object') return;
    const metadata = info as Record<string, unknown>;
    if (typeof metadata.uuid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(metadata.uuid)
      || typeof metadata.name !== 'string' || !metadata.name.trim() || metadata.name.length > 80 || /[\u0000-\u001f\u007f]/.test(metadata.name)) return;
    add(data.provider, metadata.name.trim());
  };
  host.addEventListener('eip6963:announceProvider', announce);
  if (isWalletProvider(host.ethereum)) add(host.ethereum, 'Browser wallet');
  update(wallets.map(wallet => ({ ...wallet })));
  host.dispatchEvent(new Event('eip6963:requestProvider'));
  return () => host.removeEventListener('eip6963:announceProvider', announce);
}
