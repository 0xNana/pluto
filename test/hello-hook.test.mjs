import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak256, toHex, zeroAddress } from 'viem';
import { compileContracts } from '../scripts/lib/contracts.mjs';
import { evmHarness } from './support/evm.mjs';

test('hello-world hook authenticates the market, strips nonce, and acknowledges once', async () => {
  const artifacts = await compileContracts();
  const chain = await evmHarness();
  const hook = await chain.deploy(artifacts.HelloRevealHook, [chain.market]);
  const payload = `0x${'11'.repeat(32)}${'22'.repeat(32)}${'33'.repeat(32)}`;
  assert.equal(await chain.call(hook, 'onReveal', [1n, payload], chain.foreign), '0x00000000');
  assert.equal(await chain.call(hook, 'onReveal', [1n, payload], chain.market), keccak256(toHex('onReveal(uint256,bytes)')).slice(0, 10));
  assert.equal(await chain.call(hook, 'accepted', [1n]), true);
  assert.equal(await chain.call(hook, 'onReveal', [1n, payload], chain.market), '0xd8e071b6');
  assert.equal(await chain.call(hook, 'onReveal', [2n, '0x1234'], chain.market), '0xd8e071b6');
  assert.equal(await chain.call(hook, 'accepted', [2n]), false);
  await assert.rejects(chain.deploy(artifacts.HelloRevealHook, [zeroAddress]), /revert/);
});
