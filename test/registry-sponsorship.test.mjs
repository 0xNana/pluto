import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toHex, zeroAddress } from 'viem';
import { createAddressFromString } from '@ethereumjs/util';
import { compileContracts } from '../scripts/lib/contracts.mjs';
import { evmHarness } from './support/evm.mjs';
import { marketMockSource } from './support/market.mjs';
import { registryDomain, signRegistryAction } from '../src/shared/registry-authorization.mjs';
import { reportIdFor } from '../src/shared/disclosure.mjs';

let artifacts;
before(async () => { artifacts = await compileContracts({ 'MockMarket.sol': marketMockSource() }); });
// Public, unfunded fixture key; never used on a real chain.
const author = privateKeyToAccount(`0x${'05'.repeat(32)}`);
const fields = { cipherHash: `0x${'22'.repeat(32)}`, keyCommit: keccak256(`0x${'11'.repeat(32)}`), t1: 1600n, t2: 5200n };
async function setup() {
  const chain = await evmHarness();
  const market = await chain.deploy(artifacts.MockMarket);
  const registry = await chain.deploy(artifacts.DisclosureRegistry, [market.address]);
  const domain = registryDomain(31337, registry.address);
  const grant = { payer: chain.foreign, nonce: 0n, deadline: 1500n };
  const auth = await signRegistryAction(author, domain, 'RegisterReport', fields, grant);
  return { chain, market, registry, domain, grant, auth };
}

test('zero-balance researcher authorizes protocol-paid registration and binding without losing author identity', async () => {
  const { chain, market, registry, domain, grant, auth } = await setup();
  const reportId = await chain.call(registry, 'registerBySig', [...Object.values(fields), auth], grant.payer);
  assert.equal(reportId, reportIdFor(author.address, fields.cipherHash, fields.keyCommit));
  assert.equal((await chain.call(registry, 'statusOf', [reportId])).researcher, author.address);
  const balance = await chain.evm.stateManager.getAccount(createAddressFromString(author.address));
  assert.equal(balance?.balance ?? 0n, 0n);
  await chain.call(market, 'setTrigger', [5n, author.address, grant.payer, registry.address, 1600n, 5200n, false]);
  const bindAuth = await signRegistryAction(author, domain, 'BindReport', { reportId, triggerId: 5n }, { ...grant, nonce: 1n });
  await chain.call(registry, 'bindBySig', [reportId, 5n, bindAuth], grant.payer);
  assert.equal((await chain.call(registry, 'statusOf', [reportId])).lastTriggerId, 5n);
  assert.equal(await chain.call(registry, 'authorizationUsed', [author.address, 0n]), true);
  assert.equal(await chain.call(registry, 'authorizationUsed', [author.address, 1n]), true);
  await assert.rejects(chain.call(registry, 'bindBySig', [reportId, 5n, bindAuth], grant.payer), /revert/);
});

test('registry grants reject tampered commitments, windows, payer, author, nonce and deadline without consuming grants', async () => {
  const { chain, registry, grant, auth } = await setup();
  for (const change of [{ cipherHash: fields.keyCommit }, { keyCommit: fields.cipherHash }, { t1: 1700n }, { t2: 5300n }]) {
    await assert.rejects(chain.call(registry, 'registerBySig', [...Object.values({ ...fields, ...change }), auth], grant.payer), /revert/);
  }
  for (const change of [{ researcher: chain.author }, { payer: chain.author }, { nonce: 1n }, { deadline: 1600n }]) {
    await assert.rejects(chain.call(registry, 'registerBySig', [...Object.values(fields), { ...auth, ...change }], grant.payer), /revert/);
  }
  await assert.rejects(chain.call(registry, 'registerBySig', [...Object.values(fields), auth], chain.author), /revert/);
  assert.equal(await chain.call(registry, 'authorizationUsed', [author.address, 0n]), false);
  chain.setTime(1501n);
  await assert.rejects(chain.call(registry, 'registerBySig', [...Object.values(fields), auth], grant.payer), /revert/);
});

test('registry signatures are scoped to the chain and registry contract', async () => {
  const { chain, registry, domain, grant } = await setup();
  for (const wrongDomain of [{ ...domain, chainId: 1 }, { ...domain, verifyingContract: chain.market }]) {
    const auth = await signRegistryAction(author, wrongDomain, 'RegisterReport', fields, grant);
    await assert.rejects(chain.call(registry, 'registerBySig', [...Object.values(fields), auth], grant.payer), /revert/);
  }
});

test('registry rejects malformed and malleable signatures and zero author grants', async () => {
  const { chain, registry, grant, auth } = await setup();
  const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const s = BigInt(`0x${auth.signature.slice(66, 130)}`);
  const v = parseInt(auth.signature.slice(130), 16);
  const malleable = auth.signature.slice(0, 66) + toHex(order - s, { size: 32 }).slice(2)
    + (v === 27 ? '1c' : '1b');
  for (const signature of ['0x', '0x1234', `0x${'00'.repeat(65)}`, malleable,
    auth.signature.slice(0, 130) + '00']) {
    await assert.rejects(chain.call(registry, 'registerBySig', [...Object.values(fields), { ...auth, signature }], grant.payer), /revert/);
  }
  await assert.rejects(chain.call(registry, 'registerBySig', [...Object.values(fields), {
    ...auth, researcher: zeroAddress, signature: `0x${'00'.repeat(65)}` }], grant.payer), /revert/);
  assert.equal(await chain.call(registry, 'authorizationUsed', [author.address, 0n]), false);
});

test('bind and retry grants sign their action fields and roll back consumed nonces on failure', async () => {
  const { chain, market, registry, domain, grant, auth } = await setup();
  const reportId = await chain.call(registry, 'registerBySig', [...Object.values(fields), auth], grant.payer);
  await assert.rejects(chain.call(registry, 'registerBySig', [...Object.values(fields), auth], grant.payer), /revert/);
  const bindAuth = await signRegistryAction(author, domain, 'BindReport', { reportId, triggerId: 5n }, { ...grant, nonce: 1n });
  // No trigger yet. Failed execution must not burn a valid authorization.
  await assert.rejects(chain.call(registry, 'bindBySig', [reportId, 5n, bindAuth], grant.payer), /revert/);
  assert.equal(await chain.call(registry, 'authorizationUsed', [author.address, 1n]), false);
  await chain.call(market, 'setTrigger', [5n, author.address, grant.payer, registry.address, 1600n, 5200n, false]);
  for (const args of [[fields.cipherHash, 5n, bindAuth], [reportId, 6n, bindAuth], [reportId, 5n, auth]]) {
    await assert.rejects(chain.call(registry, 'bindBySig', args, grant.payer), /revert/);
  }
  await chain.call(registry, 'bindBySig', [reportId, 5n, bindAuth], grant.payer);
  chain.setTime(5201n);
  const retryFields = { parentReportId: reportId, t1: 6000n, t2: 9600n };
  const retryAuth = await signRegistryAction(author, domain, 'RetryReport', retryFields,
    { ...grant, nonce: 2n, deadline: 5900n });
  for (const args of [[fields.cipherHash, 6000n, 9600n, retryAuth], [reportId, 6100n, 9600n, retryAuth],
    [reportId, 6000n, 9700n, retryAuth]]) {
    await assert.rejects(chain.call(registry, 'retryBySig', args, grant.payer), /revert/);
  }
  const retryId = await chain.call(registry, 'retryBySig', [reportId, 6000n, 9600n, retryAuth], grant.payer);
  const retry = await chain.call(registry, 'statusOf', [retryId]);
  assert.equal(retry.researcher, author.address);
  assert.equal(retry.parentReportId, reportId);
  assert.equal((await chain.call(registry, 'statusOf', [reportId])).t1, 1600n);
  await assert.rejects(chain.call(registry, 'retryBySig', [reportId, 6000n, 9600n, retryAuth], grant.payer), /revert/);
});
