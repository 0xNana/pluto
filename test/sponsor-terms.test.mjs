import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { sponsoredPostMessage, SPONSORED_POST_TYPES, compileCondition } from '@nillion/covenants-sdk';
import { signRegistryAction, registryDomain } from '../src/shared/registry-authorization.mjs';
import { validateSponsoredBundle } from '../packages/relayer/terms.mts';
import { reportIdFor } from '../src/shared/disclosure.mjs';

test('T-13/14 relayer validates SDK and registry author grants, refund payer and actual ceiling cap', async () => {
  const author = privateKeyToAccount('0x' + '12'.repeat(32)), payer = '0x' + '34'.repeat(20), registry = '0x' + '56'.repeat(20), market = '0x' + '78'.repeat(20);
  const cipherHash = '0x' + '90'.repeat(32), keyCommit = '0x' + 'ab'.repeat(32), reportId = reportIdFor(author.address, cipherHash, keyCommit);
  const args = { mode: 'PUBLIC_CONDITION', ttl: 0, k: 2, ceilingWei: 6n, hook: registry, t1: 1600n, t2: 5200n,
    publicCondition: compileCondition({ window: { t1: 1600n, t2: 5200n } }), commit: '0x' + 'cd'.repeat(32),
    keys: [1n, 2n, 3n].map(keyId => ({ keyId, nodeId: keyId, mpk: '0x01' })), layers: [1, 2, 3].map(() => new Uint8Array(230)), hookGasLimit: 250000 };
  const auth = { author: author.address, payer, minCeiling: 5n, nonce: 0n, deadline: 1500n };
  const signature = await author.signTypedData({ domain: { name: 'Covenants TriggerMarket', version: '1', chainId: 11155111, verifyingContract: market }, types: SPONSORED_POST_TYPES,
    primaryType: 'SponsoredPost', message: sponsoredPostMessage(args, auth) });
  const registration = await signRegistryAction(author, registryDomain(11155111, registry), 'RegisterReport', { cipherHash, keyCommit, t1: 1600n, t2: 5200n }, { payer, nonce: 1n, deadline: 1500n });
  const bundle = { reportId, cipherHash, keyCommit, args, authorization: { ...auth, signature }, registration };
  const policy = { market, registry, payer, nowUnix: 1000n, maxCeilingWei: 10n, maxHookGas: 1000000, maxRetryWindowSecs: 1000000, maxM: 5, maxPlaintextBytes: 1000n, maxCiphertextBytes: 10000n };
  assert.equal((await validateSponsoredBundle(bundle, policy)).author, author.address);
  for (const change of [{ args: { ...args, t2: 5201n } }, { args: { ...args, ceilingWei: 11n } }, { authorization: { ...bundle.authorization, payer: registry } },
    { registration: { ...registration, nonce: 2n } }, { keyCommit: cipherHash }]) await assert.rejects(validateSponsoredBundle({ ...bundle, ...change }, policy));
  await assert.rejects(validateSponsoredBundle(bundle, { ...policy, nowUnix: 1600n }));
});
