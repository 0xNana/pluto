import { createServer } from 'node:http';
import { Readable, Transform } from 'node:stream';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, getAddress, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { SponsorService } from '../packages/relayer/service.mts';
import { SponsorRequests } from '../packages/relayer/requests.mts';
import { SponsorFunding } from '../packages/relayer/funding.mts';
import { sepolia } from 'viem/chains';
import { PortalStore } from '../packages/portal/store.mts';
import { PortalInbox } from '../packages/portal/inbox.mts';
import { ProtocolEnrollment } from '../packages/portal/enrollment.mts';
import { applicationHandler } from '../packages/portal/application.mts';
import { checkDeployment } from '../packages/client/deployment.mts';
import { readFile } from 'node:fs/promises';
import { policy } from '../config/policy.mjs';
import { sepoliaSubmissionsEnabled } from './lib/submission-settings.mjs';

async function main() {
const origin = process.env.PORTAL_ORIGIN;
const dataDirectory = process.env.PORTAL_DATA_DIR;
if (!origin || !dataDirectory) throw new Error('Set HTTPS PORTAL_ORIGIN and a private PORTAL_DATA_DIR; see docs/operations.md');
const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid server port');
const assetDirectory = resolve('artifacts/web');
const store = new PortalStore(resolve(dataDirectory, 'portal.sqlite'), origin, 11155111);
const days = Number(process.env.PRIVATE_RETENTION_DAYS ?? policy.privateRetentionDays);
const inbox = new PortalInbox(store, days * 86400);
const enrollment = new ProtocolEnrollment(store);
const expectedMarket = process.env.EXPECTED_MARKET ? getAddress(process.env.EXPECTED_MARKET) : null;
const registry = process.env.REGISTRY_ADDRESS ? getAddress(process.env.REGISTRY_ADDRESS) : null;
const registryFirstBlock = process.env.REGISTRY_FIRST_BLOCK ? BigInt(process.env.REGISTRY_FIRST_BLOCK) : null;
const publicRpcUrl = process.env.PUBLIC_RPC_URL ?? null;
const writesEnabled = sepoliaSubmissionsEnabled();
const pub = process.env.RPC_URL ? createPublicClient({ chain: sepolia, transport: http(process.env.RPC_URL, { retryCount: 0, timeout: 20_000 }) }) : undefined;
if (pub) {
  if (!expectedMarket || !registry || registryFirstBlock === null || registryFirstBlock < 0n) throw new Error('Live reads require published market, compiled registry and registry first block');
  await checkDeployment(pub, expectedMarket, registry, JSON.parse(await readFile(resolve(assetDirectory, 'registry-artifact.json'), 'utf8')));
}
let sponsorship;
if (process.env.RELAYER_KEY) {
  if (!pub || !registry || !expectedMarket || !process.env.MAX_CEILING_WEI) throw new Error('Sponsorship requires validated Sepolia reads and a spending ceiling');
  const wallet = createWalletClient({ account: privateKeyToAccount(process.env.RELAYER_KEY), chain: sepolia, transport: http(process.env.RPC_URL, { retryCount: 0 }) });
  const service = new SponsorService(store, pub, wallet, { expectedMarket, registry, artifact: JSON.parse(await readFile(resolve(assetDirectory, 'registry-artifact.json'), 'utf8')), maxCeilingWei: BigInt(process.env.MAX_CEILING_WEI), writesEnabled });
  sponsorship = { requests: new SponsorRequests(store, service), funding: new SponsorFunding(store, pub, wallet.account.address, expectedMarket) };
}
const handler = await applicationHandler(store, inbox, enrollment, { assetDirectory, publicRpcUrl, expectedMarket, registry, registryFirstBlock, writesEnabled, pub, sponsorship });
inbox.purgeExpired();
const maintenance = setInterval(() => { try { inbox.purgeExpired(); } catch { process.stderr.write('Portal retention maintenance failed\n'); } }, 60_000);
maintenance.unref();
const server = createServer({ maxHeaderSize: 16384, requestTimeout: 30_000, headersTimeout: 10_000, keepAliveTimeout: 5_000 }, async (incoming, outgoing) => {
  try {
    const target = incoming.url ?? '/';
    if (!target.startsWith('/') || target.startsWith('//') || target.length > 4096) { outgoing.writeHead(400); outgoing.end(); return; }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    let size = 0;
    const limited = new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; callback(size > 2_300_000 ? new Error('Request too large') : null, chunk); } });
    const controller = new AbortController(); incoming.on('aborted', () => controller.abort());
    const timer = setTimeout(() => { controller.abort(); incoming.destroy(); }, 30_000); timer.unref();
    try {
      const init = { method: incoming.method, headers, signal: controller.signal,
        ...(['GET', 'HEAD'].includes(incoming.method ?? 'GET') ? {} : { body: Readable.toWeb(incoming.pipe(limited)), duplex: 'half' }) };
      const result = await handler(new Request(new URL(target, origin), init), incoming.socket.remoteAddress ?? 'unknown');
      outgoing.writeHead(result.status, Object.fromEntries(result.headers)); outgoing.end(Buffer.from(await result.arrayBuffer()));
    } finally { clearTimeout(timer); }
  } catch { if (!outgoing.headersSent) outgoing.writeHead(503, { 'Content-Type': 'application/json' }); outgoing.end('{"error":{"code":"UNAVAILABLE"}}'); }
});
server.listen(port, '127.0.0.1'); await once(server, 'listening');
console.log(`Pluto portal listening on 127.0.0.1:${port}; Sepolia submissions ${writesEnabled ? 'enabled' : 'disabled'}`);
async function stop() { clearInterval(maintenance); server.close(); await once(server, 'close'); store.close(); }
process.once('SIGTERM', () => { stop().catch(() => { process.exitCode = 1; }); });
process.once('SIGINT', () => { stop().catch(() => { process.exitCode = 1; }); });
}

// Startup RPC errors can include credentials and calldata. Keep them off logs.
main().catch(() => { process.stderr.write('Portal startup failed; check local configuration, assets and chain access\n'); process.exitCode = 1; });
