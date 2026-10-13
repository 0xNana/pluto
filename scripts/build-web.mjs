import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile, cp, rm, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { triggerMarketAbi, nilAbi } from '@nillion/covenants-sdk';
import { compileContracts } from './lib/contracts.mjs';
import { appKitStyleHashes } from './lib/appkit-styles.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const app = join(root, 'apps/web'), assets = join(app, 'public'), out = join(root, 'artifacts/web');
await mkdir(assets, { recursive: true });
await mkdir(join(app, 'generated'), { recursive: true });
// Preflight the browser controller's entire dependency graph before Next builds.
const graph = await build({ entryPoints: [join(root, 'packages/web/app.mts')], bundle: true,
  outfile: join(app, 'generated/controller.mjs'), minify: true,
  platform: 'browser', format: 'esm', target: ['es2023'], metafile: true, logLevel: 'silent' });
if (Object.keys(graph.metafile.inputs).some(path => path.startsWith('node:') || /covenants-sdk\/dist\/index\.js$/.test(path))) throw new Error('Browser graph contains server SDK or Node input');
await writeFile(join(app, 'generated/controller.d.mts'), 'import type { WalletConnector } from "../../../packages/web/appkit-connection.mts";\nexport function mountDisclosureWorkspace(options?: { walletConnector?: WalletConnector }): () => void;\nexport { connectAppKit, manageAppKitAccount } from "../../../packages/web/appkit-connection.mts";\nexport { appKitSettings } from "../../../packages/web/appkit-settings.mts";\n');
const artifact = (await compileContracts()).DisclosureRegistry;
await writeFile(join(assets, 'sdk-abis.json'), JSON.stringify({ version: '0.6.1', market: triggerMarketAbi, nil: nilAbi }) + '\n');
await writeFile(join(assets, 'registry-artifact.json'), JSON.stringify({ abi: artifact.abi, compiler: artifact.compiler, runtimeBytecode: artifact.runtimeBytecode, immutableReferences: artifact.immutableReferences }) + '\n');
await writeFile(join(assets, 'appkit-style-hashes.json'), JSON.stringify(appKitStyleHashes()) + '\n');
await copyFile(join(dirname(fileURLToPath(import.meta.resolve('@nillion/covenants-sdk/browser'))), 'wasm-web/cryptomata_core_bg.wasm'), join(assets, 'cryptomata_core_bg.wasm'));
// wasm-bindgen also has an import.meta.url fallback; Next resolves that asset
// even though the application supplies its explicit same-origin WASM URL.
await copyFile(join(assets, 'cryptomata_core_bg.wasm'), join(app, 'generated/cryptomata_core_bg.wasm'));
if (process.argv.includes('--prepare-only')) {
  console.log('Prepared browser controller, SDK ABIs, registry artifact and WASM for Next.js development');
} else {
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'build', app, '--webpack'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Next.js build failed (${code})`)));
});
await rm(out, { recursive: true, force: true });
await cp(join(app, 'out'), out, { recursive: true });
const files = (await readdir(out, { recursive: true, withFileTypes: true }))
  .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(out.length + 1))
  .filter(name => /^(?:index|404|workspace)\.(?:html|txt)$|^(?:sdk-abis\.json|registry-artifact\.json|appkit-style-hashes\.json|cryptomata_core_bg\.wasm)$|^_next\/static\/.+\.(?:js|css|wasm|woff2?)$/.test(name)).sort();
await writeFile(join(out, 'manifest.json'), JSON.stringify(files) + '\n');
const html = await readFile(join(out, 'index.html'), 'utf8');
if (!html.includes('/_next/static/') || !html.includes('href="/workspace#researcher"') || html.includes('id="report-file"')) throw new Error('Next export lacks the product landing');
const workspace = await readFile(join(out, 'workspace.html'), 'utf8');
if (!workspace.includes('id="researcher-prepare-panel"') || !workspace.includes('id="researcher-recovery-panel"')) throw new Error('Next export lacks the disclosure workspace');
console.log(`Built Next.js App Router export: ${files.length} manifested assets; browser controller excludes server SDK; live writes remain disabled`);
}
