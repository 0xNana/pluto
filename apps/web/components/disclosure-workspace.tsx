"use client";

import { useEffect } from 'react';
import { ResearcherWorkspace } from './researcher-workspace';
import { ProtocolWorkspace } from './protocol-workspace';
import { VerifierWorkspace } from './verifier-workspace';
import { AppShell } from './shell/app-shell';
import { walletConnector } from '../lib/wallet-connector';

// React owns the persistent screen structure; the browser controller owns
// sensitive workflow state and native controls until the screen unmounts.
export function DisclosureWorkspace() {
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void import('../generated/controller.mjs').then(({ mountDisclosureWorkspace }) => {
      if (!disposed) cleanup = mountDisclosureWorkspace({ walletConnector });
    }).catch(() => {
      if (disposed) return;
      const status = document.getElementById('global-status');
      if (status) status.textContent = 'Workspace could not start. Reload to try again. Your saved recovery is preserved.';
    });
    return () => { disposed = true; cleanup?.(); };
  }, []);
  return (
    <AppShell>
      <h1 className="visually-hidden">Pluto workspace</h1>
      <p id="global-status" className="status" role="status" aria-live="polite">Loading configuration…</p>
      <noscript><p className="critical">JavaScript is required for local encryption, recovery and verification. No report or key is uploaded by this page.</p></noscript>
      <ResearcherWorkspace />
      <ProtocolWorkspace />
      <VerifierWorkspace />
    </AppShell>
  );
}
