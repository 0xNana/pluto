// @ts-check
import { walletPublicEnv } from '../../scripts/lib/wallet-public-env.mjs';
import { developmentApiRewrites } from '../../scripts/lib/development-rewrites.mjs';

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  poweredByHeader: false,
  env: walletPublicEnv(),
  reactStrictMode: true,
  images: { unoptimized: true },
  webpack(config) {
    config.externals.push('pino-pretty', 'lokijs', 'encoding');
    // AppKit uses injected/WalletConnect providers. These optional connector
    // SDKs are not installed or enabled; do not bundle their dynamic imports.
    config.resolve.alias = { ...config.resolve.alias, '@base-org/account': false, '@metamask/connect-evm': false, accounts: false };
    return config;
  },
  // Use the installed TypeScript 5 compiler API; retain full build type checks.
  experimental: { cpus: 1, useTypeScriptCli: false, webpackBuildWorker: false },
};
/** @param {string} phase */
export default function configuration(phase) {
  if (phase !== 'phase-development-server') return config;
  return { ...config, output: undefined, rewrites: async () => developmentApiRewrites(phase) };
}
