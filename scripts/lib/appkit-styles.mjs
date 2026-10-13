import { initializeTheming } from '@reown/appkit-ui';
import { createHash } from 'node:crypto';
import { walletTheme } from '../../packages/web/appkit-settings.mts';

// Capture the installed SDK's exact style text via its public initializer. This
// runs only at build time; no browser, network, report or wallet is involved.
export function appKitStyleHashes() {
  const previous = globalThis.document, styles = new Set();
  globalThis.document = {
    createElement: () => ({ removeAttribute() {} }),
    head: { appendChild(style) { styles.add(style); }, removeChild(style) { styles.delete(style); } },
  };
  try {
    initializeTheming(walletTheme, 'dark');
    return [...new Set([...styles].map(style => `'sha256-${createHash('sha256').update(style.textContent).digest('base64')}'`))];
  } finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
}
