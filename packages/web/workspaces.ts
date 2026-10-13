// Shared by the React shell and the native browser navigation controller.
export const WORKSPACES = [
  { id: 'researcher', label: 'Researcher', audience: 'Independent researcher' },
  { id: 'protocol', label: 'Protocol portal', audience: 'Protocol customer' },
  { id: 'verifier', label: 'Public verifier', audience: 'Public access' },
] as const;

export type WorkspaceId = typeof WORKSPACES[number]['id'];
