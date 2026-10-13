// Local acceptance only: no .env, chain connection, signing key, or release flag.
import { createServer } from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { PortalStore } from '../packages/portal/store.mts';
import { PortalInbox } from '../packages/portal/inbox.mts';
import { ProtocolEnrollment } from '../packages/portal/enrollment.mts';
import { applicationHandler } from '../packages/portal/application.mts';
import { DevToolsPipe } from './lib/devtools-pipe.mjs';
import { decodeWire } from '../packages/client/wire.mts';
import { sponsorReleaseMessage, sponsorRequestId } from '../packages/client/sponsor-wire.mts';

const evidence = resolve(process.env.BROWSER_ACCEPTANCE_OUT ?? 'artifacts/browser-acceptance/result.json');
const report = { version: 1, startedAt: new Date().toISOString(), scope: 'Chrome + real IndexedDB + production assets/portal; synthetic funding HTTP and committee; NO live chain',
  complete: false, releaseAccepted: false, phase: 'prepare', checks: [], browser: null, failure: null, keyboard: {} };
const scratch = await mkdtemp(join(tmpdir(), 'pluto-browser-'));
let server, chrome, client, store;
let handler;
let uploads = [], badUpload = false;
let errorResponses = 0;
let runtimeExceptions = 0;
let browserErrors = 0, expectedHttpFailures = 0;
let unexpectedWrites = 0;
let interrupted = false;
const interrupt = () => { interrupted = true; client?.close('Acceptance interrupted'); chrome?.kill('SIGTERM'); };
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
const sleep = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
function ensure(ok, code = 'ASSERTION_FAILED') { if (!ok) throw Object.assign(new Error('Acceptance assertion failed'), { code }); }
async function check(name, job) {
  ensure(!interrupted);
  report.phase = name;
  await job(); report.checks.push({ name, result: 'pass' });
  console.log(`PASS ${name}`);
}
async function evaluate(sessionId, expression) {
  const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error('Browser evaluation failed');
  return result.result.value;
}
async function wait(sessionId, expression) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await evaluate(sessionId, expression)) return; await sleep(50); }
  throw new Error('Browser condition timed out');
}
async function open(url) {
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  await client.send('Page.enable', {}, sessionId);
  await client.send('Runtime.enable', {}, sessionId);
  await client.send('Network.enable', {}, sessionId);
  await client.send('Log.enable', {}, sessionId);
  await client.send('Page.navigate', { url }, sessionId);
  await wait(sessionId, `location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`);
  return sessionId;
}
async function reload(sessionId) {
  const previous = await evaluate(sessionId, 'performance.timeOrigin');
  await client.send('Page.reload', {}, sessionId);
  await wait(sessionId, `performance.timeOrigin !== ${previous} && document.readyState === 'complete'`);
}
async function fixture(sessionId) {
  await evaluate(sessionId, "import('/acceptance.js').then(value => { globalThis.acceptance = value; return true; })");
}
try {
  report.phase = 'build acceptance fixture';
  const bundle = await build({ entryPoints: ['test/browser/acceptance.mts'], bundle: true, platform: 'browser', format: 'esm', write: false,
    metafile: true, target: ['es2023'], minify: true, logLevel: 'silent' });
  ensure(!Object.keys(bundle.metafile.inputs).some(path => path.startsWith('node:') || /covenants-sdk\/dist\/index\.js$/.test(path)));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(scratch, 'tls.key'), '-out', join(scratch, 'tls.pem'),
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  report.phase = 'HTTPS listener';
  server = createServer({ key: await readFile(join(scratch, 'tls.key')), cert: await readFile(join(scratch, 'tls.pem')) }, async (incoming, outgoing) => {
    try {
      const path = incoming.url;
      if (incoming.method !== 'GET' && path !== '/acceptance/upload') unexpectedWrites++;
      if (path === '/acceptance.js') { outgoing.writeHead(200, { 'Content-Type': 'text/javascript' }); outgoing.end(bundle.outputFiles[0].contents); return; }
      if (path === '/acceptance.html') {
        outgoing.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self';" });
        outgoing.end('<!doctype html><html lang="en"><title>Isolated acceptance fixture</title><body>Private browser fixture</body></html>'); return;
      }
      if (path === '/acceptance/upload' && incoming.method === 'POST') {
        const parts = []; let length = 0;
        for await (const part of incoming) { length += part.length; if (length > 200000) throw new Error('Bounded fixture body exceeded'); parts.push(part); }
        const body = Buffer.concat(parts).toString(), parsed = decodeWire(body);
        const id = sponsorRequestId(sponsorReleaseMessage(store.origin, parsed.input.protocolId, parsed.bounds));
        if (uploads.length && body !== uploads[0]) badUpload = true;
        uploads.push(body); // Temporary, public signed posting terms only; never archived.
        outgoing.writeHead(uploads.length === 1 ? 503 : 200, { 'Content-Type': 'application/json' });
        outgoing.end(JSON.stringify(uploads.length === 1 ? { error: { code: 'UNAVAILABLE' } } : { id, state: 'pending' })); return;
      }
      if (!handler || !path?.startsWith('/') || path.startsWith('//') || incoming.method !== 'GET') { outgoing.writeHead(400); outgoing.end(); return; }
      const response = await handler(new Request(new URL(path, store.origin)), 'isolated-browser');
      if (response.status >= 400) errorResponses++;
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { errorResponses++; outgoing.writeHead(503); outgoing.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `https://127.0.0.1:${server.address().port}`;
  store = new PortalStore(join(scratch, 'portal.sqlite'), origin, 11155111);
  handler = await applicationHandler(store, new PortalInbox(store, 86400), new ProtocolEnrollment(store), {
    assetDirectory: resolve('artifacts/web'), publicRpcUrl: null, expectedMarket: null, registry: null, registryFirstBlock: null, writesEnabled: false,
  });
  ensure(!interrupted);
  report.phase = 'Chrome launch';
  const args = ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${join(scratch, 'profile')}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-dev-shm-usage', '--disable-crash-reporter',
    '--ignore-certificate-errors', 'about:blank'];
  // TLS exception is confined to a disposable profile and our loopback origin.
  // Preserve Chrome sandbox by default. Root/container test runners can opt in.
  if (process.env.PLUTO_TEST_NO_SANDBOX === '1') args.unshift('--no-sandbox');
  chrome = spawn(process.env.CHROME_BIN ?? 'google-chrome', args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  client = new DevToolsPipe(chrome.stdio[3], chrome.stdio[4]);
  client.onEvent = (method, _sessionId, params) => {
    if (method === 'Runtime.exceptionThrown') runtimeExceptions++;
    if (method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(params.type)) browserErrors++;
    if (method === 'Network.loadingFailed') browserErrors++;
    if (method === 'Network.responseReceived' && params.response.status >= 400) {
      if (params.response.url === origin + '/acceptance/upload' && params.response.status === 503) expectedHttpFailures++;
      else browserErrors++;
    }
    if (method === 'Log.entryAdded' && params.entry.level === 'error'
      && !(params.entry.source === 'network' && params.entry.url === origin + '/acceptance/upload')) browserErrors++;
  };
  chrome.on('error', () => client.close('Chrome launch failed'));
  chrome.on('exit', () => client.close('Chrome exited before acceptance completed'));
  const version = await client.send('Browser.getVersion'); report.browser = String(version.product).replace(/[^a-zA-Z0-9./ -]/g, '').slice(0, 100);
  const ui = await open(origin + '/');
  await wait(ui, "!!document.getElementById('landing-title') && document.readyState === 'complete'");
  await check('landing explains the product and Get started opens the real researcher workspace', async () => {
    ensure(await evaluate(ui, "!document.getElementById('report-file') && !document.getElementById('connect-wallet') && !!document.querySelector('a[href=\"/workspace#protocol\"]') && !!document.querySelector('a[href=\"/workspace#verifier\"]')"));
    for (const width of [320, 768, 1024, 1440]) {
      await client.send('Emulation.setDeviceMetricsOverride', { width, height: 960, deviceScaleFactor: 1, mobile: false }, ui);
      ensure(await evaluate(ui, 'document.documentElement.scrollWidth <= window.innerWidth'), 'LANDING_OVERFLOW');
      const screenshot = await client.send('Page.captureScreenshot', { format: 'png' }, ui);
      await mkdir(join(evidence, '..'), { recursive: true });
      await writeFile(join(evidence, '..', `landing-${width}.png`), Buffer.from(screenshot.data, 'base64'));
    }
    await evaluate(ui, "document.querySelector('main a[href=\"/workspace#researcher\"]').click()");
    await wait(ui, "location.pathname === '/workspace' && location.hash === '#researcher' && !!document.getElementById('researcher-title')");
  });
  await wait(ui, "document.getElementById('global-status').textContent.includes('Offline preparation available')");
  await check('Next.js production shell hydrates and starts the browser workflow', async () => {
    ensure(await evaluate(ui, "!!document.querySelector('script[src*=\"/_next/static/\"]') && Array.isArray(window.__next_f)"));
  });
  await check('previously signed verifier links still open the public verifier', async () => {
    const legacy = await open(origin + '/#verifier');
    await wait(legacy, "location.pathname === '/workspace' && location.hash === '#verifier' && !!document.getElementById('verifier') && !document.getElementById('verifier').hidden");
    ensure(await evaluate(legacy, "document.getElementById('post').disabled && !document.querySelector('.landing-page')"));
  });
  await check('production runtime loads with writes disabled', async () => {
    ensure(await evaluate(ui, "fetch('/api/runtime').then(r => r.json()).then(r => r.writesEnabled === false && r.publicRpcUrl === null)"));
    ensure(await evaluate(ui, "['post','request-sponsorship','resume-binding','complete-funded-binding','approve-funding'].every(id => document.getElementById(id).disabled)"));
  });
  await check('header wallet button supports anonymous access without a wallet prompt or dropdown', async () => {
    await wait(ui, "!document.getElementById('connect-wallet').disabled");
    ensure(await evaluate(ui, "document.getElementById('connect-wallet').textContent === 'Connect wallet' && document.getElementById('logout').disabled"));
    ensure(await evaluate(ui, "['wallet-menu','wallet-provider','wallet-account','wallet-status','wallet-sign-in','wallet-sign-out','disconnect-wallet'].every(id => !document.getElementById(id))"));
    await client.send('Accessibility.enable', {}, ui);
    const { nodes } = await client.send('Accessibility.getFullAXTree', {}, ui);
    ensure(nodes.filter(node => !node.ignored && ['button', 'combobox'].includes(node.role?.value)).every(node => !!node.name?.value), 'WALLET_CONTROL_NAMES');
  });
  await check('workspace links, focus, Back and Forward', async () => {
    for (const role of ['protocol', 'verifier', 'researcher']) {
      await evaluate(ui, `document.querySelector('[data-workspace="${role}"]').click()`);
      await wait(ui, `!document.getElementById('${role}').hidden && document.activeElement.id === '${role}-title'`);
    }
    await evaluate(ui, 'history.back()'); await wait(ui, "!document.getElementById('verifier').hidden");
    await evaluate(ui, 'history.forward()'); await wait(ui, "!document.getElementById('researcher').hidden");
    await evaluate(ui, "location.hash = 'funding-console'"); await wait(ui, "!document.getElementById('protocol').hidden && document.activeElement.id === 'funding-title'");
  });
  await check('responsive layout at 320, 768, 1024, 1440 pixels', async () => {
    for (const width of [320, 768, 1024, 1440]) {
      await client.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }, ui);
      for (const role of ['researcher', 'protocol', 'verifier']) {
        await evaluate(ui, `location.hash = '${role}'`); await wait(ui, `!document.getElementById('${role}').hidden`);
        ensure(await evaluate(ui, 'document.documentElement.scrollWidth <= window.innerWidth + 1'));
        ensure(await evaluate(ui, `(() => {
          const main = document.getElementById('main').getBoundingClientRect();
          const sidebar = document.querySelector('.app-sidebar').getBoundingClientRect();
          const links = [...document.querySelectorAll('nav a[data-workspace]')];
          return links.length === 3 && links.every(link => link.getBoundingClientRect().height >= 44)
            && document.querySelector('nav a[aria-current="page"]').dataset.workspace === '${role}'
            && (${width} >= 1024 ? sidebar.right <= main.left + 1 : sidebar.bottom <= main.top + 1);
        })()`));
        if (role === 'researcher') ensure(await evaluate(ui, `(() => {
          const flow = document.querySelector('.researcher-flow').getBoundingClientRect();
          const support = document.querySelector('.researcher-support').getBoundingClientRect();
          return ${width} >= 1280 ? flow.right <= support.left + 1 : flow.bottom <= support.top + 1;
        })()`));
        // Only pristine public UI is captured, before preparing any report,
        // recovery, wallet session or private portal record.
        const screenshot = await client.send('Page.captureScreenshot', { format: 'png' }, ui);
        await mkdir(join(evidence, '..'), { recursive: true });
        await writeFile(join(evidence, '..', `ui-${width}-${role}.png`), Buffer.from(screenshot.data, 'base64'));
      }
    }
  });
  await check('keyboard first Tab reaches the skip link', async () => {
    // Fragment navigation changes the browser's sequential focus starting point
    // even when activeElement is BODY. Test initial Tab without a fragment.
    await client.send('Page.navigate', { url: origin + '/workspace' }, ui);
    await wait(ui, "location.pathname === '/workspace' && !location.hash && document.readyState === 'complete'");
    await wait(ui, "document.getElementById('global-status').textContent.includes('Offline preparation available')");
    await client.send('Page.bringToFront', {}, ui);
    await client.send('Emulation.setFocusEmulationEnabled', { enabled: true }, ui);
    const snapshot = "(() => { const a = document.activeElement; return { focused: document.hasFocus(), tag: a.tagName, id: a.id, class: a.className, hash: location.hash }; })()";
    report.keyboard.beforeTab = await evaluate(ui, snapshot);
    await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }, ui);
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }, ui);
    // Native focus may settle after the key command's response.
    try { await wait(ui, "document.activeElement.classList.contains('skip')"); }
    finally { report.keyboard.afterTab = await evaluate(ui, snapshot); }
    ensure(report.keyboard.afterTab.class.includes('skip'), 'SKIP_LINK_FOCUS');
  });
  await check('keyboard skip link Enter focuses main content', async () => {
    await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, ui);
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, ui);
    await wait(ui, "document.activeElement.id === 'main'");
  });
  await check('accessibility controls have computed names', async () => {
    const { nodes } = await client.send('Accessibility.getFullAXTree', {}, ui);
    const controls = nodes.filter(n => !n.ignored && ['button', 'textbox', 'checkbox', 'combobox'].includes(n.role?.value));
    report.accessibility = { controls: controls.length, unnamed: controls.filter(n => !n.name?.value).length };
    ensure(controls.length >= 8 && report.accessibility.unnamed === 0, 'UNNAMED_AX_CONTROLS');
  });
  await check('all researcher sections are browsable before preparation while actions remain guarded', async () => {
    for (const [stage, heading] of [['seal', 'seal-title'], ['review', 'review-title'], ['share', 'delivery-title'], ['prepare', 'prepare-title']]) {
      ensure(await evaluate(ui, `!document.getElementById('researcher-${stage}').disabled`));
      await evaluate(ui, `document.getElementById('researcher-${stage}').click()`);
      await wait(ui, `location.hash === '#researcher/${stage}' && !document.getElementById('researcher-${stage}-panel').hidden && document.activeElement.id === '${heading}'`);
      ensure(await evaluate(ui, "['plan', 'review', 'post', 'send-delivery'].every(id => document.getElementById(id).disabled)"));
    }
    ensure(uploads.length === 0 && unexpectedWrites === 0);
  });
  await check('UI encrypts a synthetic report without an upload', async () => {
    // DataTransfer is confined to this owned synthetic fixture; it invokes the
    // real UI action. No wallet extension, network RPC, or signing is involved.
    ensure(await evaluate(ui, `(() => { const transfer = new DataTransfer(); transfer.items.add(new File(['synthetic UI report'], 'fixture.txt')); document.getElementById('report-file').files = transfer.files; document.getElementById('encrypt').click(); return true; })()`));
    await wait(ui, "document.getElementById('report-status').textContent.startsWith('Encrypted locally.') && !document.getElementById('save-recovery').disabled");
    ensure(uploads.length === 0 && unexpectedWrites === 0);
  });
  await check('researcher stages, saved-report navigation and history preserve an encrypted draft', async () => {
    ensure(await evaluate(ui, "document.getElementById('researcher-next').disabled === false && document.getElementById('researcher-review').disabled === false && document.getElementById('review').disabled"));
    await evaluate(ui, "document.getElementById('researcher-next').click()");
    await wait(ui, "location.hash === '#researcher/seal' && !document.getElementById('researcher-seal-panel').hidden && document.activeElement.id === 'seal-title'");
    ensure(await evaluate(ui, "document.getElementById('researcher-prepare-panel').hidden && document.getElementById('researcher-next').disabled === false && document.getElementById('review').disabled"));
    await evaluate(ui, "document.getElementById('upload-a').value = 'https://storage.example/synthetic'; document.getElementById('researcher-saved').click()");
    await wait(ui, "!document.getElementById('researcher-recovery-panel').hidden && document.activeElement.id === 'researcher-recovery-title'");
    await evaluate(ui, 'history.back()');
    await wait(ui, "!document.getElementById('researcher-seal-panel').hidden && document.activeElement.id === 'seal-title'");
    await evaluate(ui, 'history.forward()'); await wait(ui, "!document.getElementById('researcher-recovery-panel').hidden");
    await evaluate(ui, "document.getElementById('researcher-prepare').click()");
    await wait(ui, "!document.getElementById('researcher-prepare-panel').hidden");
    ensure(await evaluate(ui, "document.getElementById('report-file').files.length === 1 && document.getElementById('author').value.startsWith('0x') && document.getElementById('upload-a').value === 'https://storage.example/synthetic' && document.getElementById('post').disabled"));
    ensure(uploads.length === 0 && unexpectedWrites === 0);
  });
  const first = await open(origin + '/acceptance.html'); await fixture(first);
  let id;
  await check('real WebCrypto, SDK WASM, private export/import and IndexedDB save', async () => { id = await evaluate(first, 'acceptance.seed()'); ensure(/^0x[a-f0-9]{64}$/.test(id)); });
  const second = await open(origin + '/acceptance.html'); await fixture(second);
  await check('IndexedDB persists across reload and a second tab', async () => {
    await reload(first); await fixture(first);
    for (const tab of [first, second]) { const state = await evaluate(tab, `acceptance.load(${JSON.stringify(id)})`); ensure(state.sealed && state.events === 0); }
  });
  await check('cross-tab stale histories cannot claim two register attempts', async () => {
    const results = await Promise.all([first, second].map(tab => evaluate(tab, 'acceptance.claimRegister()')));
    ensure(results.filter(result => result === 'claimed').length === 1 && results.filter(result => result === 'stale').length === 1);
    const state = await evaluate(first, `acceptance.load(${JSON.stringify(id)})`); ensure(state.events === 1);
  });
  await check('failed funding upload preserves exact signed request on retry', async () => {
    id = await evaluate(first, 'acceptance.fundingFailureAndRetry()'); ensure(uploads.length === 2 && !badUpload);
  });
  await check('funding request survives reload and private export/import', async () => {
    await reload(first); await fixture(first);
    ensure(await evaluate(first, `acceptance.fundingReloadProof(${JSON.stringify(id)})`)); ensure(uploads.length === 3 && !badUpload);
  });
  ensure(errorResponses === 0);
  await check('no unexpected browser or HTTP errors', async () => { ensure(runtimeExceptions === 0 && browserErrors === 0 && expectedHttpFailures === 1); });
  report.complete = true; report.phase = 'complete';
} catch (error) {
  // Only controlled labels and system error codes reach durable evidence.
  report.failure = { phase: report.phase, code: interrupted ? 'INTERRUPTED' : typeof error.code === 'string' ? error.code.replace(/[^A-Z0-9_]/g, '').slice(0, 50) : 'ACCEPTANCE_FAILED' };
  console.error(`FAIL ${report.phase} (${report.failure.code}); acceptance incomplete`); process.exitCode = 1;
} finally {
  client?.close();
  if (chrome?.pid && chrome.exitCode === null && chrome.signalCode === null) {
    const exited = once(chrome, 'exit'); chrome.kill('SIGTERM');
    const timer = setTimeout(() => chrome.kill('SIGKILL'), 2000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  if (server?.listening) { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); }
  store?.close(); uploads = [];
  await rm(scratch, { recursive: true, force: true });
  if (interrupted) { report.complete = false; report.failure = { phase: report.phase, code: 'INTERRUPTED' }; process.exitCode = 1; }
  await mkdir(join(evidence, '..'), { recursive: true });
  await writeFile(evidence, JSON.stringify({ ...report, endedAt: new Date().toISOString() }, null, 2) + '\n');
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  console.log(`Public acceptance evidence: ${evidence}`);
}
