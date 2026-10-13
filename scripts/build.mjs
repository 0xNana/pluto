import { mkdir, writeFile } from 'node:fs/promises';
import { compileContracts } from './lib/contracts.mjs';

const directory = new URL('../artifacts/contracts/', import.meta.url);
const artifacts = await compileContracts();
await mkdir(directory, { recursive: true });
for (const [name, artifact] of Object.entries(artifacts)) {
  await writeFile(new URL(`${name}.json`, directory), JSON.stringify(artifact, null, 2) + '\n');
}
console.log(`Built ${Object.keys(artifacts).join(', ')} with ${Object.values(artifacts)[0].compiler}`);
