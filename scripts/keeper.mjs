import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PortalStore } from '../packages/portal/store.mts';
import { Keeper } from '../packages/keeper/keeper.mts';
import { resolveSepolia } from '../src/chain/deployment.mjs';
import { probeClient } from './lib/probe-runtime.mjs';

async function main() {
  const { values } = parseArgs({ strict: true, allowPositionals: false,
    options: { once: { type: 'boolean', default: false }, help: { type: 'boolean', default: false }, id: { type: 'string' }, 'report-id': { type: 'string' } } });
  if (values.help) { console.log('Read-only Sepolia watcher: npm run keeper -- [--once] [--id UINT256 --report-id BYTES32]\nRequires RPC_URL, EXPECTED_MARKET, MARKET_FIRST_BLOCK, PORTAL_ORIGIN, private PORTAL_DATA_DIR. Alerts are queued locally; no transactions or delivery.'); return; }
  if (!process.env.PORTAL_ORIGIN || !process.env.PORTAL_DATA_DIR || !/^(0|[1-9][0-9]*)$/.test(process.env.MARKET_FIRST_BLOCK ?? '')) throw new Error('Keeper configuration required');
  if ((values.id === undefined) !== (values['report-id'] === undefined) || (values.id !== undefined && (!/^(0|[1-9][0-9]{0,77})$/.test(values.id) || BigInt(values.id) >= 1n << 256n || !/^0x[a-fA-F0-9]{64}$/.test(values['report-id'])))) throw new Error('Invalid watch identifiers');
  const pub = probeClient(), expected = process.env.EXPECTED_MARKET;
  const addresses = await resolveSepolia(pub, expected);
  const store = new PortalStore(resolve(process.env.PORTAL_DATA_DIR, 'portal.sqlite'), process.env.PORTAL_ORIGIN, 11155111);
  const keeper = new Keeper(store, pub, addresses.market, BigInt(process.env.MARKET_FIRST_BLOCK), { confirmations: 12n, blockSpan: 100n, alertAfterSecs: 300n });
  if (values.id !== undefined) keeper.watch(BigInt(values.id), values['report-id']);
  let stop = false;
  const controller = new AbortController();
  const interrupt = () => { stop = true; controller.abort(); };
  process.once('SIGTERM', interrupt); process.once('SIGINT', interrupt);
  try {
    do {
      try {
        // Re-resolve the deployment before each scan. Never route through the
        // comparison address if C0 changes to a replacement market.
        await resolveSepolia(pub, expected); await keeper.tick();
        console.log(JSON.stringify({ status: 'scan-complete', queuedAlerts: keeper.alerts().length, writesEnabled: false }));
      } catch {
        process.stderr.write('Keeper scan failed; cursor retained and raw RPC details withheld\n');
        if (values.once) { process.exitCode = 1; break; }
      }
      if (values.once || stop) break;
      const { setTimeout } = await import('node:timers/promises');
      try { await setTimeout(30_000, undefined, { signal: controller.signal }); }
      catch (error) { if (error.name !== 'AbortError') throw error; }
    } while (!stop);
  } finally { process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt); store.close(); }
}
main().catch(() => { process.stderr.write('Keeper startup failed; check configuration, private storage and chain access\n'); process.exitCode = 1; });
