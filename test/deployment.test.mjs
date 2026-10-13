import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectSepolia, resolveSepolia } from '../src/chain/deployment.mjs';

const market = '0x1111111111111111111111111111111111111111';
const moduleAddress = '0x2222222222222222222222222222222222222222';
function fakeClient({ chainId = 11155111, activeKeys = [{ nodeId: 1n, keyId: 1n }] } = {}) {
  return {
    getChainId: async () => chainId,
    readContract: async ({ functionName }) => {
      if (functionName === 'triggerMarket') return market;
      if (functionName === 'getActiveKeys') return activeKeys;
      if (functionName === 'retired') return false;
      return moduleAddress;
    },
  };
}

test('probe refuses mainnet rather than relying on a client chain setting', async () => {
  await assert.rejects(inspectSepolia(fakeClient({ chainId: 1 }), market), /Sepolia/);
});

test('a superseded but responsive market is rejected', async () => {
  await assert.rejects(inspectSepolia(fakeClient(), moduleAddress), /current published market/);
});

test('probe refuses a deployment with no active candidate keys', async () => {
  await assert.rejects(inspectSepolia(fakeClient({ activeKeys: [] }), market), /no candidates/);
});

test('candidate discovery joins operator and retirement data from resolved modules', async () => {
  const result = await inspectSepolia(fakeClient(), market);
  assert.equal(result.addresses.market.toLowerCase(), market);
  assert.equal(result.candidates[0].nodeId, 1n);
  assert.equal(result.candidates[0].operator.toLowerCase(), moduleAddress);
  assert.equal(result.candidates[0].retired, false);
});

test('an absent or malformed current-market comparison value is rejected', async () => {
  await assert.rejects(inspectSepolia(fakeClient(), undefined), /EXPECTED_MARKET/);
  await assert.rejects(inspectSepolia(fakeClient(), '0x1234'), /EXPECTED_MARKET/);
});

test('historical report reads resolve the deployment without requiring an active committee', async () => {
  const addresses = await resolveSepolia(fakeClient({ activeKeys: [] }), market);
  assert.equal(addresses.market, market);
});
