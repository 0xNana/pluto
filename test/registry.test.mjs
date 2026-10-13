import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { keccak256, hexToBytes, decodeEventLog, toHex } from 'viem';
import { compileContracts } from '../scripts/lib/contracts.mjs';
import { evmHarness } from './support/evm.mjs';
import { marketMockSource } from './support/market.mjs';
import { reportIdFor } from '../src/shared/disclosure.mjs';

let artifacts;
before(async () => { artifacts = await compileContracts({ 'MockMarket.sol': marketMockSource() }); });
const cipherHash = `0x${'22'.repeat(32)}`;
const key = `0x${'11'.repeat(32)}`;
const keyCommit = keccak256(key);
const payloadFor = reportId => `0x${key.slice(2)}${reportId.slice(2)}${'33'.repeat(32)}`;
async function setup() {
  const chain = await evmHarness();
  const market = await chain.deploy(artifacts.MockMarket);
  const registry = await chain.deploy(artifacts.DisclosureRegistry, [market.address]);
  const reportId = await chain.call(registry, 'register', [cipherHash, keyCommit, 1600n, 5200n]);
  async function trigger(id, author = chain.author, start = 1600n, end = 5200n, hook = registry.address) {
    await chain.call(market, 'setTrigger', [id, author, chain.foreign, hook, start, end, false]);
  }
  return { chain, market, registry, reportId, trigger };
}

test('registration matches Solidity report ID and rejects duplicates or invalid windows', async () => {
  const { chain, registry, reportId } = await setup();
  assert.equal(reportId, reportIdFor(chain.author, cipherHash, keyCommit));
  await assert.rejects(chain.call(registry, 'register', [cipherHash, keyCommit, 1600n, 5200n]), /revert/);
  await assert.rejects(chain.call(registry, 'register', [keyCommit, cipherHash, 999n, 5200n]), /revert/);
  const status = await chain.call(registry, 'statusOf', [reportId]);
  assert.equal(status.researcher.toLowerCase(), chain.author);
  assert.equal(status.registeredAt, 1000n);
});

test('binding rejects foreign caller or author, a wrong hook/window and late binding', async () => {
  const { chain, registry, reportId, trigger } = await setup();
  await trigger(1n);
  await assert.rejects(chain.call(registry, 'bindTrigger', [reportId, 1n], chain.foreign), /revert/);
  await trigger(1n, chain.foreign);
  await assert.rejects(chain.call(registry, 'bindTrigger', [reportId, 1n]), /revert/);
  await trigger(1n, chain.author, 1700n);
  await assert.rejects(chain.call(registry, 'bindTrigger', [reportId, 1n]), /revert/);
  await trigger(1n, chain.author, 1600n, 5200n, chain.foreign);
  await assert.rejects(chain.call(registry, 'bindTrigger', [reportId, 1n]), /revert/);
  await trigger(1n);
  chain.setTime(1600n);
  await assert.rejects(chain.call(registry, 'bindTrigger', [reportId, 1n]), /revert/);
});

test('T-02–T-05: malformed, foreign, unbound and mismatched-key callbacks ACK without disclosure', async () => {
  const { chain, market, registry, reportId, trigger } = await setup();
  await trigger(1n);
  await chain.call(registry, 'bindTrigger', [reportId, 1n]);
  assert.equal(await chain.call(registry, 'onReveal', [1n, payloadFor(reportId)], chain.foreign), '0x00000000');
  for (const [id, payload] of [[2n, payloadFor(reportId)], [1n, '0x1234'], [1n, payloadFor(cipherHash)],
    [1n, `0x${'44'.repeat(32)}${reportId.slice(2)}${'33'.repeat(32)}`]]) {
    assert.equal(await chain.call(registry, 'onReveal', [id, payload], market.address), '0xd8e071b6');
    assert.equal(decodeEventLog({ abi: registry.abi, topics: chain.result().execResult.logs[0][1].map(toHex),
      data: toHex(chain.result().execResult.logs[0][2]) }).eventName, 'Rejected');
  }
  await trigger(1n, chain.foreign);
  assert.equal(await chain.call(registry, 'onReveal', [1n, payloadFor(reportId)], market.address), '0xd8e071b6');
  assert.equal((await chain.call(registry, 'statusOf', [reportId])).disclosed, false);
});

test('valid disclosure ACKs once, emits the correct key, and fits a 250k fixture gas budget', async t => {
  const { chain, market, registry, reportId, trigger } = await setup();
  await trigger(1n);
  await chain.call(registry, 'bindTrigger', [reportId, 1n]);
  assert.equal(await chain.call(registry, 'onReveal', [1n, payloadFor(reportId)], market.address, 250000n), '0xd8e071b6');
  const result = chain.result().execResult;
  assert.ok(result.executionGasUsed < 200000n);
  t.diagnostic(`Local hook execution gas: ${result.executionGasUsed}; fixture budget: 250000 (not a live measurement)`);
  const log = result.logs[0];
  const event = decodeEventLog({ abi: registry.abi, topics: log[1].map(topic => toHex(topic)), data: toHex(log[2]) });
  assert.equal(event.eventName, 'Disclosed');
  assert.equal(event.args.key, key);
  assert.equal((await chain.call(registry, 'statusOf', [reportId])).disclosed, true);
  await chain.call(registry, 'onReveal', [1n, payloadFor(reportId)], market.address);
  assert.equal(chain.result().execResult.logs.length, 1);
  await chain.call(market, 'setFailViews', [true]);
  assert.equal(await chain.call(registry, 'onReveal', [1n, payloadFor(reportId)], market.address), '0xd8e071b6');
});

test('multiple bound triggers and expired retries can accept only one disclosure across a lineage', async () => {
  const { chain, market, registry, reportId, trigger } = await setup();
  await trigger(1n);
  await trigger(2n);
  await chain.call(registry, 'bindTrigger', [reportId, 1n]);
  await chain.call(registry, 'bindTrigger', [reportId, 2n]);
  await assert.rejects(chain.call(registry, 'bindTrigger', [reportId, 1n]), /revert/);
  chain.setTime(5201n);
  await assert.rejects(chain.call(registry, 'registerRetry', [reportId, 6000n, 9600n], chain.foreign), /revert/);
  const retryId = await chain.call(registry, 'registerRetry', [reportId, 6000n, 9600n]);
  await chain.call(market, 'setTrigger', [3n, chain.author, chain.foreign, registry.address, 6000n, 9600n, false]);
  await chain.call(registry, 'bindTrigger', [retryId, 3n]);
  // A delayed callback from the parent's already-bound trigger wins the lineage race.
  await chain.call(registry, 'onReveal', [1n, payloadFor(reportId)], market.address);
  assert.equal((await chain.call(registry, 'statusOf', [reportId])).disclosed, true);
  for (const [id, report] of [[2n, reportId], [3n, retryId]]) {
    assert.equal(await chain.call(registry, 'onReveal', [id, payloadFor(report)], market.address), '0xd8e071b6');
    const log = chain.result().execResult.logs[0];
    assert.equal(decodeEventLog({ abi: registry.abi, topics: log[1].map(toHex), data: toHex(log[2]) }).eventName, 'Rejected');
  }
  assert.equal((await chain.call(registry, 'statusOf', [retryId])).disclosed, false);
});

test('transient market read failures do not revert or consume a valid disclosure', async () => {
  const { chain, market, registry, reportId, trigger } = await setup();
  await trigger(1n);
  await chain.call(registry, 'bindTrigger', [reportId, 1n]);
  await chain.call(market, 'setFailViews', [true]);
  assert.equal(await chain.call(registry, 'onReveal', [1n, payloadFor(reportId)], market.address, 250000n), '0x00000000');
  assert.equal((await chain.call(registry, 'statusOf', [reportId])).disclosed, false);
  await chain.call(market, 'setFailViews', [false]);
  assert.equal(await chain.call(registry, 'onReveal', [1n, payloadFor(reportId)], market.address, 250000n), '0xd8e071b6');
  assert.equal((await chain.call(registry, 'statusOf', [reportId])).disclosed, true);
});

test('T-10: expiry retry creates a linked immutable record and accepts only one lineage disclosure', async () => {
  const { chain, market, registry, reportId } = await setup();
  await assert.rejects(chain.call(registry, 'registerRetry', [reportId, 6000n, 9600n]), /revert/);
  chain.setTime(5201n);
  const retryId = await chain.call(registry, 'registerRetry', [reportId, 6000n, 9600n]);
  assert.notEqual(retryId, reportId);
  const retry = await chain.call(registry, 'statusOf', [retryId]);
  assert.equal(retry.parentReportId, reportId);
  assert.equal(retry.rootReportId, reportId);
  assert.equal(retry.cipherHash, cipherHash);
  assert.equal((await chain.call(registry, 'statusOf', [reportId])).t1, 1600n);
  await chain.call(market, 'setTrigger', [3n, chain.author, chain.foreign, registry.address, 6000n, 9600n, false]);
  await chain.call(registry, 'bindTrigger', [retryId, 3n]);
  await chain.call(registry, 'onReveal', [3n, payloadFor(retryId)], market.address);
  assert.equal((await chain.call(registry, 'statusOf', [retryId])).disclosed, true);
  chain.setTime(9601n);
  await assert.rejects(chain.call(registry, 'registerRetry', [retryId, 11000n, 14600n]), /revert/);
});
