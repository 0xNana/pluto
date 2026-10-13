import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import { developmentConnection, developmentOrigin } from './lib/submission-settings.mjs';
import { researcherDevelopmentHandler } from '../packages/planner/development.mts';

async function main() {
  // Missing deployment fields keep the existing offline preview. An explicit
  // submission opt-in with missing fields fails before starting any listener.
  const connection = developmentConnection();
  const prepare = spawn(process.execPath, ['scripts/build-web.mjs', '--prepare-only'], { stdio: 'inherit' });
  const [prepared] = await once(prepare, 'exit');
  if (prepared !== 0) throw new Error('Browser preparation failed');
  let backend;
  try {
    const nextEnvironment = { ...process.env, NEXT_TELEMETRY_DISABLED: '1' };
    delete nextEnvironment.PLUTO_DEV_API_ORIGIN;
    for (const name of ['AUTHOR_KEY', 'RELAYER_KEY', 'RPC_URL']) delete nextEnvironment[name];
    if (connection) {
      const pub = createPublicClient({ chain: sepolia, transport: http(connection.rpcUrl, { retryCount: 0, timeout: 20_000 }) });
      const artifact = JSON.parse(await readFile('apps/web/public/registry-artifact.json', 'utf8'));
      const handler = await researcherDevelopmentHandler({ ...connection, pub, artifact });
      backend = createServer({ requestTimeout: 30_000, maxHeaderSize: 16384 }, async (incoming, outgoing) => {
        try {
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
          const init = { method: incoming.method, headers, ...(['GET', 'HEAD'].includes(incoming.method ?? 'GET') ? {} : { body: Readable.toWeb(incoming), duplex: 'half' }) };
          const response = await handler(new Request(new URL(incoming.url ?? '/', 'http://127.0.0.1'), init));
          outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
        } catch { outgoing.writeHead(503, { 'Content-Type': 'application/json' }); outgoing.end('{"error":{"code":"UNAVAILABLE"}}'); }
      });
      backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
      const address = backend.address(); if (!address || typeof address === 'string') throw new Error('Development listener unavailable');
      nextEnvironment.PLUTO_DEV_API_ORIGIN = `http://127.0.0.1:${address.port}`;
      console.log(`Researcher development connected to Sepolia; submissions ${connection.writesEnabled ? 'enabled' : 'disabled'}. Staff intake requires the HTTPS portal.`);
    }
    const origin = new URL(connection?.origin ?? developmentOrigin());
    const child = spawn(process.execPath, [resolve('node_modules/next/dist/bin/next'), 'dev', 'apps/web', '--webpack', '--hostname', origin.hostname.replace(/[\[\]]/g, ''), '--port', origin.port || '3000'], { stdio: 'inherit', env: nextEnvironment });
    const stop = () => child.kill('SIGTERM');
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try { const [code] = await once(child, 'exit'); process.exitCode = code ?? 1; }
    finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  } finally { backend?.close(); }
}
main().catch(() => { process.stderr.write('Development startup failed. Check Sepolia configuration, browser assets and local network permissions; endpoint details withheld.\n'); process.exitCode = 1; });
