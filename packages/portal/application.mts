import { randomBytes, createHmac, createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { type Hex, type PublicClient } from 'viem';
import { triggerMarketAbi } from '@nillion/covenants-sdk';
import { exact } from '../client/notice.mts';
import { encodeWire } from '../client/wire.mts';
import { createPlan } from '../planner/planner.mts';
import { PortalStore } from './store.mts';
import { PortalInbox } from './inbox.mts';
import { ProtocolEnrollment } from './enrollment.mts';
import { portalHandler, readJson } from './http.mts';
import { resolveSepolia } from '../../src/chain/deployment.mjs';
import { sponsorHandler } from './sponsor-http.mts';
import type { SponsorRequests } from '../relayer/requests.mts';
import type { SponsorFunding } from '../relayer/funding.mts';
import { checkDeployment, type RegistryArtifact } from '../client/deployment.mts';

export interface ApplicationConfig { assetDirectory: string; publicRpcUrl: string | null; expectedMarket: Hex | null; registry: Hex | null;
  registryFirstBlock: bigint | null; writesEnabled: boolean; pub?: PublicClient; sponsorship?: { requests: SponsorRequests; funding: SponsorFunding } }
const headers = { 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self' https: wss://relay.walletconnect.com wss://relay.walletconnect.org; img-src 'self' https://api.web3modal.org data: blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Strict-Transport-Security': 'max-age=31536000' };
function reply(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json' } }); }
export async function applicationHandler(store: PortalStore, inbox: PortalInbox, enrollment: ProtocolEnrollment, config: ApplicationConfig) {
  if (typeof config.writesEnabled !== 'boolean') throw new Error('Invalid submission setting');
  if (config.writesEnabled && (store.chainId !== 11155111 || !config.pub || !config.publicRpcUrl || !config.expectedMarket || !config.registry
    || config.registryFirstBlock === null || config.registryFirstBlock < 0n)) throw new Error('Submissions require configured Sepolia reads and browser RPC');
  if (config.sponsorship && (config.sponsorship.requests.service.config.writesEnabled !== config.writesEnabled || config.sponsorship.requests.store !== store)) throw new Error('Application sponsorship must use its store and matching submission setting');
  const sponsored = config.sponsorship ? sponsorHandler(config.sponsorship.requests, config.sponsorship.funding) : undefined;
  if (config.publicRpcUrl) { const rpc = new URL(config.publicRpcUrl); if (rpc.protocol !== 'https:' || rpc.username || rpc.password || rpc.hash) throw new Error('Browser RPC must be an explicitly public HTTPS endpoint'); }
  const writesEnabled = config.writesEnabled;
  const artifact: RegistryArtifact | undefined = writesEnabled
    ? JSON.parse(await readFile(join(config.assetDirectory, 'registry-artifact.json'), 'utf8')) : undefined;
  if (writesEnabled) await checkDeployment(config.pub!, config.expectedMarket!, config.registry!, artifact!);
  // The old fixed list remains usable for regression fixtures. Next exports use
  // an explicit build manifest; request paths never become filesystem paths.
  let names: unknown;
  try { names = JSON.parse(await readFile(join(config.assetDirectory, 'manifest.json'), 'utf8')); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    names = ['index.html', 'app.js', 'app.css', 'sdk-abis.json', 'registry-artifact.json', 'cryptomata_core_bg.wasm'];
  }
  if (!Array.isArray(names) || names.length > 200 || !names.includes('index.html') || new Set(names).size !== names.length) throw new Error('Invalid asset manifest');
  const routes: Record<string, string> = { '/': 'index.html' };
  for (const name of names) {
    if (typeof name !== 'string' || name.split('/').some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || ['.', '..'].includes(part))
      || !(/^(?:index|404|workspace)\.(?:html|txt)$|^(?:app\.(?:js|css)|sdk-abis\.json|registry-artifact\.json|appkit-style-hashes\.json|cryptomata_core_bg\.wasm)$/.test(name)
        || /^_next\/static\/.+\.(?:js|css|wasm|woff2?)$/.test(name))) throw new Error('Invalid asset manifest path');
    routes['/' + name] = name;
  }
  if (names.includes('workspace.html')) {
    routes['/workspace'] = 'workspace.html';
    routes['/workspace/'] = 'workspace.html';
  }
  const directory = await realpath(config.assetDirectory);
  const assets = new Map<string, Uint8Array>();
  const htmlPolicies = new Map<string, string>();
  for (const [path, name] of Object.entries(routes)) {
    const file = await realpath(join(directory, name));
    if (!file.startsWith(directory + sep) || file !== join(directory, name)) throw new Error('Invalid asset manifest target');
    const bytes = new Uint8Array(await readFile(file)); if (bytes.length > 10_000_000) throw new Error('Asset exceeds size limit'); assets.set(path, bytes);
    if (name.endsWith('.html')) {
      const hashes = Array.from(new TextDecoder().decode(bytes).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))
        .filter(match => !/\bsrc\s*=/i.test(match[1])).map(match => `'sha256-${createHash('sha256').update(match[2]).digest('base64')}'`);
      htmlPolicies.set(path, headers['Content-Security-Policy'].replace("script-src 'self'", `script-src 'self' ${[...new Set(hashes)].join(' ')}`));
    }
  }
  const walletStyles = assets.get('/appkit-style-hashes.json');
  if (walletStyles) {
    const hashes: unknown = JSON.parse(new TextDecoder().decode(walletStyles));
    if (!Array.isArray(hashes) || !hashes.length || hashes.length > 16 || hashes.some(hash => typeof hash !== 'string' || !/^'sha256-[A-Za-z0-9+/]{43}='$/.test(hash))) throw new Error('Invalid wallet style hashes');
    for (const [path, csp] of htmlPolicies) htmlPolicies.set(path, csp.replace("style-src 'self'", `style-src 'self' ${[...new Set(hashes)].join(' ')}`));
  }
  const portal = portalHandler(store, inbox, enrollment), secret = randomBytes(32), limits = new Map<string, { window: number; count: number }>();
  return async (request: Request, clientAddress = 'local'): Promise<Response> => {
    const url = new URL(request.url);
    if (url.origin !== store.origin) return reply({ error: { code: 'FORBIDDEN' } }, 403);
    // Immutable, allowlisted in-memory assets do not consume the API quota.
    // AppKit's lazy chunks must not exhaust the budget for session checks.
    const asset = assets.get(url.pathname);
    if (request.method === 'GET' && asset) {
      const type = url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.json') ? 'application/json' : url.pathname.endsWith('.wasm') ? 'application/wasm' : url.pathname.endsWith('.woff2') ? 'font/woff2' : url.pathname.endsWith('.woff') ? 'font/woff' : url.pathname.endsWith('.txt') ? 'text/plain' : 'text/html';
      return new Response(new Uint8Array(asset), { headers: { ...headers,
        'Content-Security-Policy': htmlPolicies.get(url.pathname) ?? headers['Content-Security-Policy'],
        'Content-Type': `${type}${type.startsWith('font/') || type === 'application/wasm' ? '' : '; charset=utf-8'}` } });
    }
    const now = store.now(), identity = createHmac('sha256', secret).update(clientAddress).digest('hex');
    for (const [key, entry] of limits) if (entry.window + 60 <= now) limits.delete(key);
    if (!limits.has(identity) && limits.size >= 10000) return reply({ error: { code: 'RATE_LIMITED' } }, 429);
    const limit = limits.get(identity) ?? { window: now, count: 0 }; limits.set(identity, limit); limit.count++;
    if (limit.count > 120) return reply({ error: { code: 'RATE_LIMITED' } }, 429);
    try {
      if (request.method === 'GET' && url.pathname === '/favicon.ico') return new Response(null, { status: 204, headers });
      if (request.method === 'GET' && url.pathname === '/healthz') return reply({ ready: true, chainConfigured: !!config.pub, liveWritesEnabled: writesEnabled });
      if (request.method === 'GET' && url.pathname === '/api/runtime') return reply({ serviceMode: 'portal', chainId: store.chainId, publicRpcUrl: config.publicRpcUrl, expectedMarket: config.expectedMarket, registry: config.registry,
        registryFirstBlock: config.registryFirstBlock === null ? null : String(config.registryFirstBlock), writesEnabled, privateRetentionDays: inbox.retention / 86400,
        sponsorship: config.sponsorship ? { payer: config.sponsorship.requests.service.wallet.account.address, maxCeilingWei: String(config.sponsorship.requests.service.config.maxCeilingWei) } : null });
      if (request.method === 'POST' && url.pathname === '/api/plan') {
        if (request.headers.get('origin') !== store.origin) return reply({ error: { code: 'FORBIDDEN' } }, 403);
        if (!config.pub || !config.expectedMarket || !config.registry) return reply({ error: { code: 'CHAIN_NOT_CONFIGURED' } }, 503);
        if (artifact) await checkDeployment(config.pub, config.expectedMarket, config.registry, artifact);
        const input = await readJson(request, 512); exact(input, ['t1', 't2']);
        if (![input.t1, input.t2].every(n => typeof n === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(n))) throw new Error('Invalid time');
        const plan = await createPlan(config.pub, { expectedMarket: config.expectedMarket, registry: config.registry, t1: BigInt(String(input.t1)), t2: BigInt(String(input.t2)) });
        return new Response(encodeWire(plan), { headers: { ...headers, 'Content-Type': 'application/json' } });
      }
      const trigger = /^\/api\/status\/(0|[1-9][0-9]{0,77})$/.exec(url.pathname);
      if (request.method === 'GET' && trigger) {
        if (!config.pub || !config.expectedMarket) return reply({ error: { code: 'CHAIN_NOT_CONFIGURED' } }, 503);
        await resolveSepolia(config.pub, config.expectedMarket);
        const id = BigInt(trigger[1]); if (id >= 1n << 256n) throw new Error('Invalid trigger');
        const meta = await config.pub.readContract({ address: config.expectedMarket, abi: triggerMarketAbi, functionName: 'triggerMeta', args: [id] });
        if (!meta[2]) return reply({ error: { code: 'NOT_FOUND' } }, 404);
        const block = await config.pub.getBlock();
        return new Response(encodeWire({ triggerId: id, block: block.number, timestamp: block.timestamp, mode: meta[0], k: meta[1], m: meta[2], expiry: meta[3], t1: meta[4], t2: meta[5], ceilingWei: meta[7], resolved: meta[8], firstShareAt: meta[9] }), { headers: { ...headers, 'Content-Type': 'application/json' } });
      }
      const sponsoredResponse = await sponsored?.(request);
      return sponsoredResponse ?? await portal(request);
    } catch { return reply({ error: { code: 'UNAVAILABLE' } }, 503); }
  };
}
