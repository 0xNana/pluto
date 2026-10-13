import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertPostConsent, makeCostCalls, selfFundingSpend } from '../packages/client/posting.mts';
import { triggerMarketAbi, nilAbi } from '@nillion/covenants-sdk';
import { compileContracts } from '../scripts/lib/contracts.mjs';
import { decodeFunctionData } from 'viem';

test('FR-105/208 browser posting requires saved recovery, two separate confirmations and live costs', () => {
  const consent = { recoverySaved: true, reviewed: true, confirmed: true, costsReady: true };
  assert.doesNotThrow(() => assertPostConsent(consent));
  for (const flag of Object.keys(consent)) assert.throws(() => assertPostConsent({ ...consent, [flag]: false }));
});
test('self-funded transaction caps reserve a bounded retry and reject incomplete gas reviews', () => {
  const costs = { maxFeePerGas: 3n, maxPriorityFeePerGas: 1n, items: ['register', 'approve', 'post', 'bind'].map(action => ({ action, gasUnits: 100n })) };
  const spend = selfFundingSpend(costs);
  assert.equal(spend.gas.post, 126n);
  assert.equal(spend.maximumGasWei, 1890n, 'four actions plus one additional post, using live fee and policy headroom');
  assert.throws(() => selfFundingSpend({ ...costs, items: costs.items.slice(1) }), /Complete live/);
});
test('FR-207 browser cost sequence uses SDK ABIs and next trigger ID without transmitting secrets', async () => {
  const registryAbi = (await compileContracts()).DisclosureRegistry.abi;
  const author = '0x' + '12'.repeat(20), registry = '0x' + '34'.repeat(20), market = '0x' + '56'.repeat(20);
  const args = { mode: 'PUBLIC_CONDITION', keys: [1n, 2n, 3n].map(keyId => ({ keyId, nodeId: keyId, mpk: '0x01' })), k: 2,
    ttl: 0, ceilingWei: 6n, t1: 1600n, t2: 5200n, hook: registry, layers: [new Uint8Array(1), new Uint8Array(1), new Uint8Array(1)],
    commit: '0x' + '78'.repeat(32), publicCondition: new Uint8Array(52), hookGasLimit: 250000 };
  const calls = makeCostCalls({ author, registry, registryAbi, marketAbi: triggerMarketAbi, nilAbi,
    addresses: { market, nil: '0x' + '90'.repeat(20) }, reportId: '0x' + 'ab'.repeat(32),
    cipherHash: '0x' + 'cd'.repeat(32), keyCommit: '0x' + 'ef'.repeat(32), args, feeNil: 25n, escrowWei: 500n, nextTriggerId: 0n });
  assert.deepEqual(calls.map(c => c.action), ['register', 'approve', 'post', 'bind']);
  assert.equal(decodeFunctionData({ abi: triggerMarketAbi, data: calls[2].data }).functionName, 'postTrigger');
  assert.equal(decodeFunctionData({ abi: registryAbi, data: calls[3].data }).args[1], 0n);
});
