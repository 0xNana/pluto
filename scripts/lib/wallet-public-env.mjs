import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

// PROJECT_ID is a public Reown identifier. Never forward the whole environment.
export function walletPublicEnv(environment = process.env, file = new URL('../../.env', import.meta.url)) {
  let projectId = environment.NEXT_PUBLIC_REOWN_PROJECT_ID || environment.PROJECT_ID;
  if (!projectId) {
    try { projectId = parseEnv(readFileSync(file, 'utf8')).PROJECT_ID; }
    catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error; }
  }
  if (projectId && !/^[a-f0-9]{32}$/i.test(projectId.trim())) throw new Error('PROJECT_ID must be a valid public Reown project identifier');
  return { NEXT_PUBLIC_REOWN_PROJECT_ID: projectId?.trim() || '' };
}
