import { WalletAccessError } from './wallet-access.mts';

// Public example from the installed AppKit skill, restricted to loopback origins.
const localProjectId = 'b56e18d47c72ab683b10814fe9495694';
export const walletTheme = { '--w3m-font-family': 'system-ui, sans-serif' };
export function appKitSettings(origin: string, configuredId?: string) {
  const url = new URL(origin);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const projectId = configuredId?.trim() || (local ? localProjectId : undefined);
  if (!projectId) throw new WalletAccessError('Set NEXT_PUBLIC_REOWN_PROJECT_ID to your Reown project ID, then restart the app.');
  if (!/^[a-f0-9]{32}$/i.test(projectId)) throw new WalletAccessError('The Reown project ID is invalid. Check NEXT_PUBLIC_REOWN_PROJECT_ID.');
  if (!local && projectId === localProjectId) throw new WalletAccessError('The example Reown project ID is for localhost only. Configure your own project ID.');
  return {
    projectId, metadata: { name: 'Pluto', description: 'Encrypted disclosure workspace', url: url.origin, icons: [] },
    // Installed SDK otherwise allows cloud settings to override local features.
    // Basic connection mode skips remote optional-feature activation entirely.
    basic: true, themeMode: 'dark' as const, themeVariables: walletTheme,
    enableReconnect: false, enableCoinbase: false, enableBaseAccount: false, allowUnsupportedChain: false,
    defaultAccountTypes: { eip155: 'eoa' as const },
    features: { analytics: false, email: false, socials: false as const, swaps: false, onramp: false,
      history: false, send: false, receive: false, smartSessions: false, pay: false, reownAuthentication: false },
  };
}
