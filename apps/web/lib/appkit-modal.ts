// Imported only from a browser Connect action; module initialization is singleton.
import { createAppKit } from '@reown/appkit';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { sepolia } from '@reown/appkit/networks';
import { appKitSettings } from '../generated/controller.mjs';

const settings = appKitSettings(window.location.origin, process.env.NEXT_PUBLIC_REOWN_PROJECT_ID);
const adapter = new WagmiAdapter({ networks: [sepolia], projectId: settings.projectId, ssr: true });
export const modal = createAppKit({ ...settings, adapters: [adapter], networks: [sepolia], defaultNetwork: sepolia });
export const switchToSepolia = () => modal.switchNetwork(sepolia, { throwOnFailure: true });
// Use the adapter belonging to this AppKit instance. Its account/provider
// watchers keep the existing Account view and disconnect controls synchronized.
export const installedWallets = {
  ready: () => modal.ready(),
  getConnectors: () => modal.getConnectors(),
  connect: (connector: ReturnType<typeof modal.getConnectors>[number]) => adapter.connect({
    id: connector.id, type: connector.type, provider: connector.provider, info: connector.info, chain: 'eip155', chainId: sepolia.id,
  }),
};
