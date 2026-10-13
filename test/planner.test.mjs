import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPlan } from '../packages/planner/planner.mts';

test('NFR-3 planner rejects wrong chain and missing published market before reading deployment data', async () => {
  let reads = 0;
  const pub = { getChainId: async () => 1, readContract: async () => { reads++; throw new Error('Must not read'); } };
  await assert.rejects(createPlan(pub, { expectedMarket: '0x' + '12'.repeat(20), registry: '0x' + '34'.repeat(20), t1: 1600n, t2: 5200n }), /Sepolia/);
  assert.equal(reads, 0);
  await assert.rejects(createPlan(pub, { registry: '0x' + '34'.repeat(20), t1: 1600n, t2: 5200n }));
});
