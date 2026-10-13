import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
let count = 0;
for (const directory of ['config', 'src', 'scripts', 'test', 'packages', 'apps']) {
  for (const entry of await readdir(new URL(directory + '/', root), { recursive: true, withFileTypes: true })) {
    if (/(?:^|\/)(?:node_modules|\.next|out|generated)(?:\/|$)/.test(entry.parentPath)) continue;
    if (!entry.isFile() || !/\.(mjs|mts)$/.test(entry.name)) continue;
    const result = spawnSync(process.execPath, ['--check', entry.parentPath + '/' + entry.name], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
    count++;
  }
}
// Import the two supported SDK surfaces; never use unexported deep paths.
await import('@nillion/covenants-sdk');
await import('@nillion/covenants-sdk/browser');
console.log(`Checked ${count} modules in ${fileURLToPath(root)}`);
