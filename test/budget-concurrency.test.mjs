import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { PortalStore } from '../packages/portal/store.mts';
import { SponsorBudget } from '../packages/relayer/budget.mts';

const pool = { payer: '0x' + 'ab'.repeat(20), nil: '0x' + 'cd'.repeat(20), market: '0x' + 'ef'.repeat(20), ethWei: 10000n, nilUnits: 1000n, blockNumber: 10n, blockHash: '0x' + 'ab'.repeat(32) };

test('T-14 two SQLite connections serialize conflicting reservations and budget reductions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pluto-concurrent-')); await chmod(dir, 0o700);
  const path = join(dir, 'portal.sqlite'), store = new PortalStore(path, 'https://pluto.example', 11155111);
  const account = privateKeyToAccount('0x' + '12'.repeat(32)), authority = Symbol('trusted'), budget = new SponsorBudget(store, authority);
  const workers = [];
  try {
    store.enrollVerifiedProtocol('alpha.example', account.address);
    const c = store.challenge(account.address), session = await store.authenticate(c.id, await account.signMessage({ message: c.message }));
    budget.configure(session, 'alpha.example', { ethWei: 1000n, nilUnits: 100n, perPostWei: 1000n, perPostNil: 100n });
    const run = async (actions, nonce) => {
      const gate = new SharedArrayBuffer(8), view = new Int32Array(gate);
      const results = actions.map((action, index) => new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./support/budget-worker.mjs', import.meta.url), { workerData: { path, gate, action, session, pool, intent: {
          id: '0x' + String(index + nonce).repeat(64), requestHash: '0x' + 'ab'.repeat(32), author: account.address, nonce: String(index + nonce), ethWei: 600n, nilUnits: 30n,
        } } }); workers.push(worker); worker.once('message', resolve); worker.once('error', reject);
      }));
      const deadline = Date.now() + 10_000;
      while (Atomics.load(view, 0) !== 2) { if (Date.now() > deadline) throw new Error('Workers did not become ready'); await new Promise(resolve => setTimeout(resolve, 5)); }
      Atomics.store(view, 1, 1); Atomics.notify(view, 1);
      return Promise.all(results);
    };
    const reservations = await run(['reserve', 'reserve'], 1);
    assert.equal(reservations.filter(r => r.ok).length, 1);
    assert.equal(budget.summary(session, 'alpha.example').reserved_eth, '600');
    const next = await run(['configure', 'reserve'], 3);
    assert.ok(next.every(r => !r.ok));
    const summary = budget.summary(session, 'alpha.example');
    assert.equal(summary.eth, '1000'); assert.equal(summary.reserved_eth, '600');
  } finally { await Promise.all(workers.map(worker => worker.terminate())); store.close(); await rm(dir, { recursive: true }); }
});

test('T-14 concurrent tenants cannot over-reserve a shared payer despite independent available tenant budgets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pluto-pool-')); await chmod(dir, 0o700);
  const path = join(dir, 'portal.sqlite'), store = new PortalStore(path, 'https://pluto.example', 11155111);
  const account = privateKeyToAccount('0x' + '12'.repeat(32)), authority = Symbol('trusted'), budget = new SponsorBudget(store, authority), workers = [];
  try {
    for (const domain of ['alpha.example', 'beta.example']) store.enrollVerifiedProtocol(domain, account.address);
    const c = store.challenge(account.address), session = await store.authenticate(c.id, await account.signMessage({ message: c.message }));
    for (const domain of ['alpha.example', 'beta.example']) budget.configure(session, domain, { ethWei: 1000n, nilUnits: 100n, perPostWei: 1000n, perPostNil: 100n });
    const gate = new SharedArrayBuffer(8), view = new Int32Array(gate);
    const results = ['alpha.example', 'beta.example'].map((protocolId, index) => new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./support/budget-worker.mjs', import.meta.url), { workerData: { path, gate, action: 'reserve', protocolId, pool: { ...pool, ethWei: 1000n }, intent: {
        id: '0x' + String(index + 1).repeat(64), requestHash: '0x' + 'ab'.repeat(32), author: account.address, nonce: String(index), ethWei: 600n, nilUnits: 30n,
      } } }); workers.push(worker); worker.once('message', resolve); worker.once('error', reject);
    }));
    const deadline = Date.now() + 10_000;
    while (Atomics.load(view, 0) !== 2) { if (Date.now() > deadline) throw new Error('Workers did not become ready'); await new Promise(resolve => setTimeout(resolve, 5)); }
    Atomics.store(view, 1, 1); Atomics.notify(view, 1);
    const outcomes = await Promise.all(results);
    assert.equal(outcomes.filter(result => result.ok).length, 1);
    assert.match(outcomes.find(result => !result.ok).reason, /payer pool/);
    const reserved = ['alpha.example', 'beta.example'].reduce((sum, domain) => sum + BigInt(budget.summary(session, domain).reserved_eth), 0n);
    assert.equal(reserved, 600n);
  } finally { await Promise.all(workers.map(worker => worker.terminate())); store.close(); await rm(dir, { recursive: true }); }
});
