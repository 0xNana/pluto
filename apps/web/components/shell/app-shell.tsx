import type { ReactNode } from 'react';
import { WorkspaceNavigation } from './workspace-navigation';
import { WalletButton } from './wallet-button';

// Shared presentation only. Workflow state and controller lifetime belong to
// DisclosureWorkspace, so navigation never remounts an in-progress report.
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <a className="skip" href="#main">Skip to content</a>
      <header className="app-header">
        <a className="brand" href="#researcher" aria-label="Pluto researcher workspace">pluto<span className="orbit" aria-hidden="true">◌</span></a>
        <WalletButton />
      </header>
      <aside className="app-sidebar">
        <p className="sidebar-label">Workspaces</p>
        <WorkspaceNavigation />
        <div className="sidebar-note">
          <p>Independent disclosure</p>
          <p>A protocol can fund a report. It cannot change a posted deadline.</p>
        </div>
      </aside>
      <main id="main" className="app-main" tabIndex={-1}>
        <div className="app-workspace-content">{children}</div>
        <footer className="app-footer">Keys and private recovery stay in your browser. Keep a secure copy of your recovery file.</footer>
      </main>
    </div>
  );
}
