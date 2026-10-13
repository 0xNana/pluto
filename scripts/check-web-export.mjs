// Exercise the actual Next production export through the portal, without sockets,
// environment loading, wallets, provider fixtures or chain transactions.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { PortalStore } from '../packages/portal/store.mts';
import { PortalInbox } from '../packages/portal/inbox.mts';
import { ProtocolEnrollment } from '../packages/portal/enrollment.mts';
import { applicationHandler } from '../packages/portal/application.mts';

const dir = await mkdtemp(join(tmpdir(), 'pluto-next-export-'));
await chmod(dir, 0o700);
const origin = 'https://pluto.example', store = new PortalStore(join(dir, 'portal.sqlite'), origin, 11155111);
try {
  const handler = await applicationHandler(store, new PortalInbox(store, 86400), new ProtocolEnrollment(store, async () => []), {
    assetDirectory: resolve('artifacts/web'), publicRpcUrl: null, expectedMarket: null, registry: null, registryFirstBlock: null, writesEnabled: false,
  });
  const root = await handler(new Request(origin)), html = await root.text();
  assert.equal(root.status, 200); assert.match(html, /\/_next\/static\//);
  assert.match(html, /href="\/workspace#researcher"/);
  assert.doesNotMatch(html, /id="report-file"|id="connect-wallet"|id="global-status"/);
  const workspace = await handler(new Request(origin + '/workspace')), workspaceHtml = await workspace.text();
  assert.equal(workspace.status, 200); assert.match(workspaceHtml, /id="researcher-prepare-panel"/);
  assert.match(workspaceHtml, /id="connect-wallet"/);
  for (const alias of ['/workspace/', '/workspace.html']) {
    const response = await handler(new Request(origin + alias));
    assert.equal(response.status, 200); assert.equal(await response.text(), workspaceHtml);
  }
  const walletStyles = JSON.parse(await readFile('artifacts/web/appkit-style-hashes.json', 'utf8'));
  assert.ok(walletStyles.length > 0);
  let inline = 0;
  for (const [document, response] of [[html, root], [workspaceHtml, workspace]]) {
    const csp = response.headers.get('content-security-policy');
    assert.doesNotMatch(csp, /'unsafe-inline'|'unsafe-eval'/);
    for (const hash of walletStyles) assert.ok(csp.includes(hash), 'installed AppKit theme is authorized by exact hash');
    assert.match(csp, /wss:\/\/relay\.walletconnect\.com/);
    let documentInline = 0;
    for (const script of document.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (/\bsrc\s*=/i.test(script[1])) continue;
      const hash = createHash('sha256').update(script[2]).digest('base64');
      assert.ok(csp.includes(`'sha256-${hash}'`)); inline++; documentInline++;
    }
    assert.ok(documentInline > 0, 'each Next document bootstrap exists and is authorized');
  }
  const manifest = JSON.parse(await readFile('artifacts/web/manifest.json', 'utf8'));
  const preview = JSON.parse(await readFile('apps/web/out/api/runtime', 'utf8'));
  assert.equal(preview.serviceMode, 'preview'); assert.equal(preview.writesEnabled, false);
  for (const key of ['publicRpcUrl', 'expectedMarket', 'registry', 'registryFirstBlock', 'sponsorship']) assert.equal(preview[key], null);
  assert.equal(manifest.some(name => name.startsWith('api/')), false, 'preview API exports must not shadow the production portal');
  for (const name of manifest) {
    const response = await handler(new Request(origin + '/' + name));
    assert.equal(response.status, 200, name);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array(await readFile(join('artifacts/web', name))), name);
    if (name.endsWith('.wasm')) assert.equal(response.headers.get('content-type'), 'application/wasm');
    if (name.endsWith('.js')) assert.match(response.headers.get('content-type'), /^text\/javascript/);
  }
  for (const document of [html, workspaceHtml]) for (const script of document.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)) {
    assert.ok(script[1].startsWith('/_next/static/')); assert.ok(manifest.includes(script[1].slice(1)));
  }
  const runtime = await (await handler(new Request(origin + '/api/runtime'))).json();
  assert.equal(runtime.writesEnabled, false); assert.equal(runtime.publicRpcUrl, null);
  assert.equal(runtime.serviceMode, 'portal');
  assert.equal((await handler(new Request(origin + '/.env'))).status, 404);
  console.log('PASS Next preview runtime exports read-only configuration; production portal supplies its own runtime');
  console.log(`PASS actual Next landing and workspace export through portal: ${manifest.length} exact assets; ${inline} CSP-authorized bootstrap scripts; runtime writes disabled`);
  console.log('Browser hydration, keyboard, WebCrypto and IndexedDB: not run by this command; use npm run test:browser');
} finally { store.close(); await rm(dir, { recursive: true, force: true }); }
