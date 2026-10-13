import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, encodeEventTopics, encodeAbiParameters, toHex } from 'viem';
import { nilAbi } from '@nillion/covenants-sdk';
import { PortalStore } from '../packages/portal/store.mts';
import { SponsorFunding } from '../packages/relayer/funding.mts';

test('NFR-10/11 customer credit requires finalized canonical inbound deposits and cannot recreate spent funds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pluto-funding-')); await chmod(dir, 0o700);
  const store = new PortalStore(join(dir, 'portal.sqlite'), 'https://pluto.example', 11155111, () => 1000);
  const staff = privateKeyToAccount('0x' + '12'.repeat(32)), payer = toHex(34n, { size: 20 }), nil = toHex(35n, { size: 20 }), market = toHex(36n, { size: 20 });
  const hash = n => toHex(BigInt(n), { size: 32 });
  let tx = { hash: hash(1), from: staff.address, to: payer, input: '0x', value: 1000n }, receipt = { transactionHash: hash(1), status: 'success', blockNumber: 10n, blockHash: hash(99), logs: [] };
  let resolvedNil = nil;
  const pub = { getChainId: async () => 11155111, getBlock: async ({ blockNumber } = {}) => ({ number: blockNumber ?? 20n, hash: hash(99) }),
    getTransaction: async () => tx, getTransactionReceipt: async () => receipt,
    readContract: async ({ functionName }) => ({ triggerMarket: market, stakingToken: resolvedNil })[functionName] ?? payer };
  try {
    store.enrollVerifiedProtocol('alpha.example', staff.address); store.enrollVerifiedProtocol('beta.example', staff.address);
    const c = store.challenge(staff.address), session = await store.authenticate(c.id, await staff.signMessage({ message: c.message }));
    const funding = new SponsorFunding(store, pub, payer, market);
    const initial = receipt; receipt = { ...receipt, status: 'reverted' };
    await assert.rejects(funding.credit(session, 'alpha.example', hash(1)));
    assert.equal(store.db.prepare('SELECT nil_address FROM funding_context').get().nil_address, null);
    receipt = initial;
    const credited = await funding.credit(session, 'alpha.example', hash(1)); assert.equal(credited.ethWei, 1000n); assert.equal(credited.nilUnits, 0n);
    assert.throws(() => new SponsorFunding(store, pub, toHex(99n, { size: 20 }), market), /Funding context mismatch/);
    assert.equal((await funding.credit(session, 'alpha.example', hash(1))).ethWei, 1000n); // exactly once
    await assert.rejects(funding.credit(session, 'beta.example', hash(1)), /already credited/);
    await assert.rejects(funding.credit('forged', 'alpha.example', hash(1)), /Not authorized/);
    for (const bad of [ { ...tx, from: payer }, { ...tx, from: toHex(55n, { size: 20 }) }, { ...tx, input: '0x1234' } ]) {
      const original = tx; tx = bad; await assert.rejects(funding.credit(session, 'alpha.example', hash(1))); tx = original;
    }
    const original = receipt;
    for (const bad of [ { ...receipt, status: 'reverted' }, { ...receipt, blockNumber: 21n }, { ...receipt, blockHash: hash(98) } ]) { receipt = bad; await assert.rejects(funding.credit(session, 'alpha.example', hash(1))); }
    receipt = original;
    const transfer = nilAbi.find(e => e.type === 'event' && e.name === 'Transfer');
    const args = { from: staff.address, to: payer, value: 250n };
    tx = { hash: hash(2), from: staff.address, to: nil, input: encodeFunctionData({ abi: nilAbi, functionName: 'transfer', args: [payer, 250n] }), value: 0n };
    receipt = { ...receipt, transactionHash: hash(2), logs: [{ address: nil, topics: encodeEventTopics({ abi: nilAbi, eventName: 'Transfer', args }), data: encodeAbiParameters(transfer.inputs.filter(i => !i.indexed), [250n]) }] };
    assert.equal((await funding.credit(session, 'alpha.example', hash(2))).nilUnits, 250n);
    store.db.exec("CREATE TABLE intents(protocol_id TEXT,spent_eth TEXT,spent_nil TEXT)");
    store.db.prepare('INSERT INTO intents VALUES(?,?,?)').run('alpha.example', '400', '25');
    assert.deepEqual(funding.available('alpha.example'), { ethWei: 600n, nilUnits: 225n });
    resolvedNil = toHex(77n, { size: 20 });
    await assert.rejects(funding.credit(session, 'alpha.example', hash(2)), /Funding asset context mismatch/);
    resolvedNil = nil;
    await assert.rejects(funding.credit(session, 'beta.example', hash(2)), /already credited/);
  } finally { store.close(); await rm(dir, { recursive: true }); }
});
