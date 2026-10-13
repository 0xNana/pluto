import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { PortalStore } from '../packages/portal/store.mts';
import { SponsorBudget } from '../packages/relayer/budget.mts';

const pool = { payer: '0x' + 'ab'.repeat(20), nil: '0x' + 'cd'.repeat(20), market: '0x' + 'ef'.repeat(20), ethWei: 10000n, nilUnits: 1000n, blockNumber: 10n, blockHash: '0x' + 'ab'.repeat(32) };

test('T-14 atomic durable reservations reject replay, changed intents and overspend; disabling cannot erase submitted work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pluto-budget-')); await chmod(directory, 0o700);
  let store;
  try {
    const account = privateKeyToAccount('0x' + '12'.repeat(32));
    store = new PortalStore(join(directory, 'portal.sqlite'), 'https://pluto.example', 11155111);
    store.enrollVerifiedProtocol('alpha.example', account.address);
    const challenge = store.challenge(account.address), session = await store.authenticate(challenge.id, await account.signMessage({ message: challenge.message }));
    const authority = Symbol('trusted sponsorship service');
    let budget = new SponsorBudget(store, authority);
    budget.configure(session, 'alpha.example', { ethWei: 1000n, nilUnits: 100n, perPostWei: 500n, perPostNil: 50n });
    const intent = { id: '0x' + '11'.repeat(32), requestHash: '0x' + '22'.repeat(32), author: account.address, nonce: '0', ethWei: 400n, nilUnits: 40n };
    assert.throws(() => budget.reserve(authority, 'alpha.example', intent), /snapshot required/);
    assert.throws(() => budget.reserve(authority, 'alpha.example', intent, { ...pool, nilUnits: 39n }), /payer pool/);
    budget.reserve(authority, 'alpha.example', intent, pool);
    assert.equal(budget.reserve(authority, 'alpha.example', intent, pool).state, 'reserved');
    assert.throws(() => budget.reserve(authority, 'alpha.example', { ...intent, requestHash: '0x' + '33'.repeat(32) }, pool), /changed/);
    assert.throws(() => budget.reserve(authority, 'alpha.example', { ...intent, id: '0x' + '44'.repeat(32) }, pool), /nonce/);
    const second = { ...intent, id: '0x' + '55'.repeat(32), nonce: '1' };
    assert.throws(() => budget.reserve(authority, 'alpha.example', second, { ...pool, payer: pool.nil }), /context/);
    assert.throws(() => budget.reserve(authority, 'alpha.example', second, { ...pool, blockNumber: 9n }), /snapshot/);
    budget.reserve(authority, 'alpha.example', second, pool);
    assert.throws(() => budget.reserve(authority, 'alpha.example', { ...intent, id: '0x' + '66'.repeat(32), nonce: '2' }, pool), /budget/);
    budget.begin(authority, intent.id); assert.throws(() => budget.begin(authority, intent.id), /already/);
    assert.throws(() => budget.recordHash(authority, intent.id, 'post', '0x' + '77'.repeat(32)), /attempt/);
    budget.startAction(authority, intent.id, 'post', { to: account.address, data: '0x', value: 200n, gasUnits: 20n, maxFeePerGas: 2n, nilUnits: 0n });
    store.setEnabled(session, 'alpha.example', false);
    assert.throws(() => budget.begin(authority, '0x' + '55'.repeat(32)), /disabled/);
    assert.throws(() => budget.startAction(authority, intent.id, 'approve', { to: account.address, data: '0x', value: 0n, gasUnits: 20n, maxFeePerGas: 2n, nilUnits: 0n }), /disabled/);
    budget.recordHash(authority, intent.id, 'post', '0x' + '77'.repeat(32));
    store.close(); store = new PortalStore(join(directory, 'portal.sqlite'), 'https://pluto.example', 11155111); budget = new SponsorBudget(store, authority);
    assert.equal(budget.intent(authority, intent.id).state, 'submitted');
    assert.equal(budget.intent(authority, intent.id).transactions.length, 1);
    await assert.rejects(budget.reconcile(authority, intent.id, {}, {}), /unresolved|complete|Invalid/);
    assert.equal(budget.intent(authority, intent.id).state, 'submitted');
    assert.throws(() => budget.reserve(Symbol('untrusted'), 'alpha.example', intent, pool), /authority/);
    assert.throws(() => budget.reserve(authority, 'alpha.example', { ...intent, id: '0x' + '88'.repeat(32), nonce: '3' }, pool), /disabled/);
    assert.throws(() => budget.summary(session, 'beta.example'), /Not authorized/);
  } finally { store?.close(); await rm(directory, { recursive: true }); }
});

test('sponsor ledger refuses a legacy spending schema and a mainnet portal context', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pluto-budget-schema-')); await chmod(directory, 0o700);
  const store = new PortalStore(join(directory, 'legacy.sqlite'), 'https://pluto.example', 11155111);
  const mainnet = new PortalStore(join(directory, 'mainnet.sqlite'), 'https://pluto.example', 1);
  try {
    store.db.exec('CREATE TABLE transaction_attempts(intent_id TEXT, action TEXT, destination TEXT, data_hash TEXT, value TEXT, PRIMARY KEY(intent_id,action))');
    assert.throws(() => new SponsorBudget(store, Symbol('trusted')), /explicit migration/);
    assert.throws(() => new SponsorBudget(mainnet, Symbol('trusted')), /Sepolia portal context/);
  } finally { store.close(); mainnet.close(); await rm(directory, { recursive: true }); }
});
