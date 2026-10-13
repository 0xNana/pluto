import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PortalStore } from '../packages/portal/store.mts';
import { Keeper } from '../packages/keeper/keeper.mts';

test('T-06/08 keeper persists archive cursor, queues content-free alerts and preserves ambiguous settlement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pluto-keeper-')); await chmod(dir, 0o700);
  const store = new PortalStore(join(dir, 'data.sqlite'), 'https://pluto.example', 11155111);
  const market = '0x' + '12'.repeat(20), hash = '0x' + '34'.repeat(32);
  let time = 2000n, failScan = false, scans = [], writes = 0;
  const pub = { getChainId: async () => 11155111, getBlock: async ({ blockNumber } = {}) => ({ number: blockNumber ?? 20n, hash, timestamp: time, baseFeePerGas: 10n }),
    getContractEvents: async args => { scans.push(args); if (failScan) throw new Error('archive unavailable'); return []; },
    readContract: async () => [1, 2, 3, 5200n, 1600n, 5200n, hash, 5n, false, 0n, 100n, 0n],
    simulateContract: async args => ({ request: args }), waitForTransactionReceipt: async () => { throw new Error('receipt unavailable'); } };
  const wallet = { account: { address: market }, chain: { id: 11155111 }, writeContract: async () => { writes++; return hash; } };
  try {
    let keeper = new Keeper(store, pub, market, 1n, { confirmations: 2n, blockSpan: 10n, alertAfterSecs: 300n });
    keeper.watch(0n, '0x' + '56'.repeat(32)); await keeper.tick();
    assert.equal(scans[0].fromBlock, 1n); assert.equal(scans.at(-1).toBlock, 18n);
    assert.deepEqual(keeper.alerts().map(a => a.kind).sort(), ['basefee-above-ceiling', 'no-shares']);
    assert.ok(!JSON.stringify(keeper.alerts()).includes('plaintext'));
    keeper = new Keeper(store, pub, market, 1n, { confirmations: 2n, blockSpan: 10n, alertAfterSecs: 300n });
    scans = []; await keeper.tick(); assert.equal(scans.length, 0);
    await assert.rejects(keeper.settle(0n, wallet, false), /explicit/); assert.equal(writes, 0);
    time = 5201n; await assert.rejects(keeper.settle(0n, wallet, true), /receipt unavailable/);
    assert.equal(writes, 1); await assert.rejects(keeper.settle(0n, wallet, true), /already/); assert.equal(writes, 1);
    keeper.resetCursorForRecovery(); failScan = true; await assert.rejects(keeper.tick(), /archive unavailable/);
  } finally { store.close(); await rm(dir, { recursive: true }); }
});

test('keeper rejects a fork change during a page and resets a persisted orphaned cursor on restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pluto-keeper-reorg-')); await chmod(dir, 0o700);
  const store = new PortalStore(join(dir, 'data.sqlite'), 'https://pluto.example', 11155111);
  const market = '0x' + '12'.repeat(20), original = '0x' + '34'.repeat(32), replacement = '0x' + '56'.repeat(32);
  let hash = original, mutateDuringScan = true, scans = 0;
  const pub = { getChainId: async () => 11155111,
    getBlock: async ({ blockNumber } = {}) => ({ number: blockNumber ?? 20n, hash, timestamp: 2000n, baseFeePerGas: 10n }),
    getContractEvents: async () => { scans++; if (mutateDuringScan) hash = replacement; return []; } };
  try {
    const make = () => new Keeper(store, pub, market, 1n, { confirmations: 2n, blockSpan: 10n, alertAfterSecs: 300n });
    await assert.rejects(make().tick(), /changed during scan/);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM keeper_cursor').get().n, 0);
    mutateDuringScan = false; await make().tick();
    assert.equal(store.db.prepare('SELECT hash FROM keeper_cursor').get().hash, replacement);
    const before = scans; hash = original; await make().tick();
    assert.equal(scans - before, 2); // Scan again from the configured first block.
    assert.equal(store.db.prepare('SELECT hash FROM keeper_cursor').get().hash, original);
  } finally { store.close(); await rm(dir, { recursive: true }); }
});
