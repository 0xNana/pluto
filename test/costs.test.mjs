import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quoteTransactionCosts } from '../packages/planner/costs.mts';

test('FR-207 costs use sequential RPC simulation and current fee estimates with payer per item', async () => {
  const payer = '0x' + '12'.repeat(20);
  const calls = ['approve', 'register', 'post', 'bind'].map(action => ({ action, payer, to: '0x' + '34'.repeat(20), data: '0x1234', value: 0n }));
  const pub = { getChainId: async () => 11155111, getBlock: async () => ({ number: 10n }),
    estimateFeesPerGas: async () => ({ maxFeePerGas: 3n, maxPriorityFeePerGas: 1n }),
    simulateBlocks: async args => { assert.equal(args.blockNumber, 10n); assert.equal(args.blocks[0].calls.length, 4); return [{ calls: calls.map(() => ({ status: 'success', gasUsed: 100n })) }]; } };
  const costs = await quoteTransactionCosts(pub, calls);
  assert.equal(costs.totalGasWei, 1200n);
  assert.equal(costs.items.every(x => x.payer === payer && x.gasWei === 300n), true);
  pub.simulateBlocks = async () => { throw new Error('eth_simulateV1 unsupported'); };
  await assert.rejects(quoteTransactionCosts(pub, calls), /Sequential gas simulation unavailable/);
  pub.simulateBlocks = async () => [{ calls: [{ status: 'failure', gasUsed: 100n }] }];
  await assert.rejects(quoteTransactionCosts(pub, calls));
});
