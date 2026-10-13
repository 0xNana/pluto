import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { createAddressFromString } from '@ethereumjs/util';
import { keccak256, toHex } from 'viem';
import { compileContracts } from '../scripts/lib/contracts.mjs';
import { verifyHookDeployment, verifyRegistryReceipt, verifyRegistryBinding } from '../src/chain/registry-verification.mjs';
import { evmHarness } from './support/evm.mjs';
import { marketMockSource } from './support/market.mjs';

let artifacts;
before(async () => { artifacts = await compileContracts({ 'MockMarket.sol': marketMockSource() }); });
async function fixture() {
  const chain = await evmHarness();
  const market = await chain.deploy(artifacts.MockMarket);
  const registry = await chain.deploy(artifacts.DisclosureRegistry, [market.address]);
  const client = { getBytecode: async ({ address }) => toHex(await chain.evm.stateManager.getCode(createAddressFromString(address))),
    readContract: args => chain.call({ address: args.address, abi: args.abi }, args.functionName, args.args) };
  const expected = { researcher: chain.author, cipherHash: keccak256('0x1234'), keyCommit: keccak256('0x5678'),
    window: { t1: 1600n, t2: 5200n }, triggerId: 0n };
  const receipt = () => ({ status: 'success', logs: chain.result().execResult.logs.map(([address, topics, data]) =>
    ({ address: toHex(address), topics: topics.map(topic => toHex(topic)), data: toHex(data) })) });
  return { chain, market, registry, client, expected, receipt };
}

test('P-05 verifies deployed compiled runtime and immutable market, rejecting proxies and altered code', async () => {
  const { client, registry, market } = await fixture();
  const result = await verifyHookDeployment(client, registry.address, artifacts.DisclosureRegistry, market.address);
  assert.equal(result.runtimeMatches, true);
  await assert.rejects(verifyHookDeployment(client, registry.address, artifacts.DisclosureRegistry, registry.address), /market/);
  await assert.rejects(verifyHookDeployment({ ...client, getBytecode: async () => '0x6000' }, registry.address,
    artifacts.DisclosureRegistry, market.address), /runtime/);
  const code = await client.getBytecode({ address: registry.address });
  await assert.rejects(verifyHookDeployment({ ...client, getBytecode: async () => `0x00${code.slice(4)}` },
    registry.address, artifacts.DisclosureRegistry, market.address), /runtime/);
  const offset = Object.values(artifacts.DisclosureRegistry.immutableReferences)[0][0].start * 2 + 2;
  const alteredImmutable = code.slice(0, offset) + 'ff' + code.slice(offset + 2);
  await assert.rejects(verifyHookDeployment({ ...client, getBytecode: async () => alteredImmutable },
    registry.address, artifacts.DisclosureRegistry, market.address), /immutable market/);
});

test('P-05 decodes actual EVM Registered/Bound receipts and verifies registry state for trigger zero', async () => {
  const { chain, registry, market, client, expected, receipt } = await fixture();
  expected.reportId = await chain.call(registry, 'register', [expected.cipherHash, expected.keyCommit, 1600n, 5200n]);
  const registered = receipt();
  assert.equal(verifyRegistryReceipt(registered, registry.address, registry.abi, 'Registered', expected).event, 'Registered');
  assert.throws(() => verifyRegistryReceipt(registered, market.address, registry.abi, 'Registered', expected), /event/);
  assert.throws(() => verifyRegistryReceipt(registered, registry.address, registry.abi, 'Registered',
    { ...expected, cipherHash: expected.keyCommit }), /event/);
  await chain.call(market, 'setTrigger', [0n, chain.author, chain.foreign, registry.address, 1600n, 5200n, false]);
  await chain.call(registry, 'bindTrigger', [expected.reportId, 0n]);
  assert.equal(verifyRegistryReceipt(receipt(), registry.address, registry.abi, 'Bound', expected).triggerId, 0n);
  assert.equal((await verifyRegistryBinding(client, registry.address, registry.abi, expected)).bound, true);
  await assert.rejects(verifyRegistryBinding(client, registry.address, registry.abi,
    { ...expected, researcher: chain.foreign }), /registry/);
  assert.throws(() => verifyRegistryReceipt({ ...registered, status: 'reverted' }, registry.address,
    registry.abi, 'Registered', expected), /receipt/);
});
