import type { WalletConnector } from '../../../packages/web/appkit-connection.mts';
let loaded: Promise<typeof import('./appkit-modal')> | undefined;
const load = () => loaded ??= import('./appkit-modal').catch(error => { loaded = undefined; throw error; });
export const walletConnector: WalletConnector = {
  async connect(signal) {
    signal.throwIfAborted(); const { modal, installedWallets } = await load(); signal.throwIfAborted();
    const { connectAppKit } = await import('../generated/controller.mjs'); signal.throwIfAborted();
    return connectAppKit(modal, signal, installedWallets);
  },
  async disconnect() { if (loaded) await (await loaded).modal.disconnect('eip155'); },
  async switchNetwork() { await (await load()).switchToSepolia(); },
  async manageAccount(signal) {
    signal.throwIfAborted(); const { modal } = await load(); signal.throwIfAborted();
    const { manageAppKitAccount } = await import('../generated/controller.mjs'); signal.throwIfAborted();
    return manageAppKitAccount(modal, signal);
  },
};
