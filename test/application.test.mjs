import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, chmod, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PortalStore } from '../packages/portal/store.mts';
import { PortalInbox } from '../packages/portal/inbox.mts';
import { ProtocolEnrollment } from '../packages/portal/enrollment.mts';
import { applicationHandler } from '../packages/portal/application.mts';

test('application serves a fixed asset list, rejects foreign origins and rate limits without live writes or IP logs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pluto-app-')); await chmod(dir, 0o700);
  const origin = 'https://pluto.example', store = new PortalStore(join(dir, 'portal.sqlite'), origin, 11155111);
  try {
    const inbox = new PortalInbox(store, 90 * 86400), enrollment = new ProtocolEnrollment(store, async () => []);
    for (const name of ['index.html', 'app.js', 'app.css', 'sdk-abis.json', 'registry-artifact.json', 'cryptomata_core_bg.wasm']) await writeFile(join(dir, name), name);
    const config = { assetDirectory: dir, publicRpcUrl: null, expectedMarket: null, registry: null, registryFirstBlock: null, writesEnabled: false };
    const handler = await applicationHandler(store, inbox, enrollment, config);
    const root = await handler(new Request(origin)); assert.equal(root.status, 200); assert.equal(await root.text(), 'index.html');
    assert.match(root.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal((await handler(new Request(origin + '/favicon.ico'))).status, 204);
    assert.equal((await handler(new Request(origin + '/../../.env'))).status, 404);
    assert.equal((await handler(new Request('https://evil.example/'))).status, 403);
    assert.equal((await handler(new Request(origin + '/api/runtime'))).status, 200);
    const runtime = await (await handler(new Request(origin + '/api/runtime'))).json(); assert.equal(runtime.writesEnabled, false);
    const plan = await handler(new Request(origin + '/api/plan', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{"t1":"1600","t2":"5200"}' })); assert.equal(plan.status, 503);
    let last; for (let i = 0; i < 125; i++) last = await handler(new Request(origin + '/healthz'), 'fixture-address');
    assert.equal(last.status, 429); assert.equal(store.db.prepare('SELECT count(*) AS n FROM access_log').get().n, 0);
    await assert.rejects(applicationHandler(store, inbox, enrollment, { ...config, writesEnabled: true }), /configured Sepolia/);
  } finally { store.close(); await rm(dir, { recursive: true }); }
});

test('Next export serves only manifested assets and authorizes exact bootstrap hashes without unsafe-inline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pluto-next-app-')); await chmod(dir, 0o700);
  const origin = 'https://pluto.example', store = new PortalStore(join(dir, 'portal.sqlite'), origin, 11155111);
  try {
    const script = 'self.__next_f.push([1,"public shell"]);';
    const html = `<html><script>${script}</script></html>`;
    await mkdir(join(dir, '_next/static/chunks'), { recursive: true });
    await writeFile(join(dir, 'index.html'), html);
    const workspaceScript = 'self.__next_f.push([1,"workspace shell"]);';
    const workspaceHtml = `<html><script>${workspaceScript}</script></html>`;
    await writeFile(join(dir, 'workspace.html'), workspaceHtml);
    await writeFile(join(dir, '_next/static/chunks/ui.js'), '/* browser fixture */');
    await writeFile(join(dir, '_next/static/chunks/ui.css'), 'body {}');
    const styleHash = `'sha256-${createHash('sha256').update(':root { color: white; }').digest('base64')}'`;
    await writeFile(join(dir, 'appkit-style-hashes.json'), JSON.stringify([styleHash]));
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(['index.html', 'workspace.html', '_next/static/chunks/ui.js', '_next/static/chunks/ui.css', 'appkit-style-hashes.json']));
    const config = { assetDirectory: dir, publicRpcUrl: null, expectedMarket: null, registry: null, registryFirstBlock: null, writesEnabled: false };
    const inbox = new PortalInbox(store, 86400), enrollment = new ProtocolEnrollment(store, async () => []);
    const handler = await applicationHandler(store, inbox, enrollment, config);
    const response = await handler(new Request(origin));
    assert.equal(await response.text(), html);
    const csp = response.headers.get('content-security-policy');
    assert.ok(csp.includes(`'sha256-${createHash('sha256').update(script).digest('base64')}'`));
    assert.doesNotMatch(csp, /'unsafe-inline'|'unsafe-eval'/);
    assert.ok(csp.split('style-src ')[1].split(';')[0].includes(styleHash));
    assert.match(csp, /connect-src[^;]*wss:\/\/relay\.walletconnect\.com/);
    assert.doesNotMatch(csp.split('script-src ')[1].split(';')[0], /reown|walletconnect|data:|blob:/);
    for (const path of ['/workspace', '/workspace/', '/workspace.html']) {
      const workspace = await handler(new Request(origin + path));
      assert.equal(workspace.status, 200);
      assert.equal(await workspace.text(), workspaceHtml);
      const workspaceCsp = workspace.headers.get('content-security-policy');
      assert.ok(workspaceCsp.includes(`'sha256-${createHash('sha256').update(workspaceScript).digest('base64')}'`));
      assert.equal(workspaceCsp.includes(`'sha256-${createHash('sha256').update(script).digest('base64')}'`), false, 'each document authorizes only its own bootstrap');
      assert.doesNotMatch(workspaceCsp, /'unsafe-inline'|'unsafe-eval'/);
    }
    assert.equal((await handler(new Request(origin + '/workspace/private'))).status, 404);
    const chunk = await handler(new Request(origin + '/_next/static/chunks/ui.js'));
    assert.equal(chunk.status, 200); assert.match(chunk.headers.get('content-type'), /^text\/javascript/);
    assert.equal((await handler(new Request(origin + '/_next/static/chunks/ui.css'))).status, 200);
    assert.equal((await handler(new Request(origin + '/_next/static/chunks/missing.js'))).status, 404);
    assert.equal((await handler(new Request(origin + '/manifest.json'))).status, 404);
    assert.equal((await handler(new Request(origin + '/api/runtime'))).headers.get('content-security-policy').includes('sha256-'), false);
    for (let i = 0; i < 128; i++) assert.equal((await handler(new Request(origin + '/_next/static/chunks/ui.js'), 'static-burst')).status, 200);
    assert.equal((await handler(new Request(origin + '/api/runtime'), 'static-burst')).status, 200, 'lazy assets leave the API rate limit available');
    await writeFile(join(dir, 'appkit-style-hashes.json'), JSON.stringify(["'unsafe-inline'"]));
    await assert.rejects(applicationHandler(store, inbox, enrollment, config), /wallet style hashes/i);
    for (const invalid of ['../.env', '_next/static/../../.env', '/index.html', '.env', '_next/static/chunks/ui.js?x=1']) {
      await writeFile(join(dir, 'manifest.json'), JSON.stringify(['index.html', invalid]));
      await assert.rejects(applicationHandler(store, inbox, enrollment, config), /manifest/i);
    }
    await writeFile(join(dir, '.env'), 'synthetic private sentinel');
    await symlink('../../../.env', join(dir, '_next/static/chunks/leak.js'));
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(['index.html', '_next/static/chunks/leak.js']));
    await assert.rejects(applicationHandler(store, inbox, enrollment, config), /manifest/i);
  } finally { store.close(); await rm(dir, { recursive: true }); }
});
