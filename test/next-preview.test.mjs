import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GET, dynamic } from '../apps/web/app/api/runtime/route.ts';

test('Next preview provides explicit read-only runtime without private or chain configuration', async () => {
  const response = GET();
  assert.equal(response.status, 200); assert.equal(dynamic, 'force-static');
  const runtime = await response.json();
  assert.equal(runtime.serviceMode, 'preview'); assert.equal(runtime.writesEnabled, false);
  assert.equal(runtime.chainId, 11155111);
  for (const key of ['publicRpcUrl', 'expectedMarket', 'registry', 'registryFirstBlock', 'sponsorship']) assert.equal(runtime[key], null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(Object.keys(runtime).sort(), ['chainId', 'expectedMarket', 'privateRetentionDays', 'publicRpcUrl', 'registry', 'registryFirstBlock', 'serviceMode', 'sponsorship', 'writesEnabled'].sort());
});
