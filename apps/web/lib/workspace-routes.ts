import { WORKSPACES } from '../../../packages/web/workspaces.ts';
import { RESEARCHER_STAGES } from '../../../packages/web/researcher-steps.ts';

const legacyFragments = new Set<string>([
  ...WORKSPACES.map(workspace => workspace.id), 'funding-console',
  ...RESEARCHER_STAGES.map(stage => `researcher/${stage.id}`), 'researcher/recovery',
]);

export function legacyWorkspaceDestination(hash: string): string | undefined {
  const fragment = hash.slice(1);
  return hash.startsWith('#') && legacyFragments.has(fragment) ? `/workspace#${fragment}` : undefined;
}
