import { WORKSPACES, type WorkspaceId } from '../../../../packages/web/workspaces.ts';

const iconPaths: Record<WorkspaceId, string> = {
  researcher: 'M14 3H5v18h14V8L14 3ZM14 3v5h5M8 12h8M8 16h5',
  protocol: 'M4 21V7l8-4 8 4v14M3 21h18M8 9v2m4-2v2m4-2v2M8 14v2m4-2v2m4 3v2m-8-2v2m8-7v2',
  verifier: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3ZM8 12l3 3 5-6',
};

export function WorkspaceNavigation() {
  return (
    <nav className="workspace-navigation" aria-label="Workspaces">
      {WORKSPACES.map(({ id, label, audience }) => (
        <a key={id} href={`#${id}`} data-workspace={id} aria-current={id === 'researcher' ? 'page' : undefined}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d={iconPaths[id]} />
          </svg>
          <span className="workspace-link-copy">
            <span className="workspace-link-label">{label}</span>
            <span className="workspace-link-audience">{audience}</span>
          </span>
        </a>
      ))}
    </nav>
  );
}
