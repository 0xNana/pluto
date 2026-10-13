import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withPaginatedEvents } from '../src/chain/rpc.mjs';

test('SDK event scans cover every block once and retain filters and event order', async () => {
  const calls = [];
  const client = {
    getChainId: async () => 11155111,
    getContractEvents: async args => {
      calls.push(args);
      return [{ blockNumber: args.fromBlock }, { blockNumber: args.toBlock }];
    },
  };
  const paged = withPaginatedEvents(client, { blockSpan: 10n, minimumIntervalMs: 0 });
  const filters = { address: '0x123', abi: [], eventName: 'SharePosted', strict: true };
  const events = await paged.getContractEvents({ ...filters, fromBlock: 5n, toBlock: 25n });
  assert.deepEqual(calls.map(c => [c.fromBlock, c.toBlock]), [[5n, 14n], [15n, 24n], [25n, 25n]]);
  for (const call of calls) for (const key of Object.keys(filters)) assert.equal(call[key], filters[key]);
  assert.deepEqual(events.map(e => e.blockNumber), [5n, 14n, 15n, 24n, 25n, 25n]);
  assert.equal(await paged.getChainId(), 11155111);
});

test('an unavailable log page fails the whole scan rather than reporting an idle fleet', async () => {
  const client = { getContractEvents: async args => {
    if (args.fromBlock === 10n) throw new Error('archive unavailable');
    return [];
  } };
  await assert.rejects(withPaginatedEvents(client, { minimumIntervalMs: 0 }).getContractEvents({ fromBlock: 0n, toBlock: 20n }), /archive unavailable/);
});

test('simultaneous SDK scans share one request queue to respect provider throughput', async () => {
  let active = 0;
  let peak = 0;
  const client = { getContractEvents: async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return [];
  } };
  const paged = withPaginatedEvents(client, { minimumIntervalMs: 0 });
  await Promise.all(['SharePosted', 'TriggerPosted'].map(eventName =>
    paged.getContractEvents({ eventName, fromBlock: 0n, toBlock: 30n })));
  assert.equal(peak, 1);
});

test('pagination requires a positive block span and preserves block-hash or tagged queries', async () => {
  const query = { fromBlock: 'latest', toBlock: 'latest' };
  const client = { getContractEvents: async args => { assert.equal(args, query); return []; } };
  assert.throws(() => withPaginatedEvents(client, { blockSpan: 0n }), /positive/);
  assert.deepEqual(await withPaginatedEvents(client).getContractEvents(query), []);
});
