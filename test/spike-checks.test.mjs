import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContractFunctionRevertedError, encodeErrorResult, keccak256, recoverTypedDataAddress, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { SPONSORED_POST_TYPES, SPONSORED_DOMAIN_NAME, SPONSORED_DOMAIN_VERSION, sponsoredPostMessage,
  triggerMarketAbi } from '@nillion/covenants-sdk';
import { compileCondition, parseConditionRecord, postParamsTuple } from '@nillion/covenants-sdk/browser';
import { sponsoredMutations, boundaryCases, simulateRejections, simulateWindowWidths, assertSponsorshipBudget } from '../scripts/lib/spike-checks.mjs';

const author = privateKeyToAccount(`0x${'05'.repeat(32)}`);
const payer = '0x1111111111111111111111111111111111111111';
const hook = '0x2222222222222222222222222222222222222222';
const record = (t1, t2) => compileCondition({ window: { t1, t2 } });
const args = { mode: 'PUBLIC_CONDITION', ttl: 0, t1: 1600n, t2: 5200n, publicCondition: record(1600n, 5200n),
  layers: [new Uint8Array(230), new Uint8Array(230), new Uint8Array(230)],
  keys: [1n, 2n, 3n].map(keyId => ({ keyId })), k: 2, commit: keccak256('0x1234'),
  ceilingWei: 90n, hook, hookGasLimit: 250000 };
const revert = name => new ContractFunctionRevertedError({ abi: triggerMarketAbi,
  data: encodeErrorResult({ abi: triggerMarketAbi, errorName: name }), functionName: 'postTrigger' });

test('P-03 mutations change authenticated report/window/hook/author/payer/nonce/deadline terms', async () => {
  const grant = { author: author.address, payer, minCeiling: 90n, nonce: 0n, deadline: 1500n };
  const domain = { name: SPONSORED_DOMAIN_NAME, version: SPONSORED_DOMAIN_VERSION, chainId: 11155111, verifyingContract: payer };
  const signature = await author.signTypedData({ domain, types: SPONSORED_POST_TYPES, primaryType: 'SponsoredPost',
    message: sponsoredPostMessage(args, grant) });
  const auth = { ...grant, signature };
  const mutations = sponsoredMutations(postParamsTuple(args), auth, { alternateHook: payer });
  assert.deepEqual(mutations.map(item => item.label), ['sealed commitment', 'window', 'hook', 'author', 'payer and refund destination',
    'nonce', 'deadline', 'minimum ceiling']);
  for (const item of mutations) {
    const params = item.params;
    const message = sponsoredPostMessage({ ...args, t1: params.t1, t2: params.t2, commit: params.commit,
      publicCondition: params.publicCondition, hook: params.hook }, item.authorization);
    const recovered = await recoverTypedDataAddress({ domain, types: SPONSORED_POST_TYPES, primaryType: 'SponsoredPost', message, signature });
    assert.notEqual(recovered, item.authorization.author, item.label);
  }
  assertSponsorshipBudget(args, auth, 90n);
  assert.throws(() => assertSponsorshipBudget({ ...args, ceilingWei: 91n }, auth, 90n), /budget/);
  assert.throws(() => assertSponsorshipBudget(args, { ...auth, payer: zeroAddress }, 90n), /payer/);
});

test('P-04 boundary cases preserve the SDK window record for past windows and bound probe allocation', () => {
  const limits = { maxCiphertextBytes: 1000n, maxHookGas: 500000n, maxPlaintextBytes: 1000n,
    layerOverheadPublicBytes: 134n, maxRetryWindowSecs: 604800n };
  const cases = boundaryCases(postParamsTuple(args), limits, 1000n);
  assert.ok(cases.some(item => item.label === 'expired public window' && item.params.t2 < 1000n));
  assert.equal(cases.find(item => item.label === 'expired public window').params.publicCondition,
    `0x${Buffer.from(record(998n, 999n)).toString('hex')}`);
  assert.equal(cases.find(item => item.label === 'ciphertext over maximum').params.layers[0].length, 2 + 1001 * 2);
  assert.throws(() => boundaryCases(postParamsTuple(args), { ...limits, maxCiphertextBytes: 20_000_000n }, 1000n), /probe allocation/);
});

test('simulation proof requires a passing control and exact decoded rejection; RPC failures are never proof', async () => {
  const base = { address: payer, abi: triggerMarketAbi, functionName: 'postTrigger', args: [postParamsTuple(args)], account: payer, value: 500n };
  const cases = [{ label: 'ttl', params: { ...base.args[0], ttl: 1 }, errors: ['TtlForbidden'] }];
  const result = await simulateRejections({ simulateContract: async request => {
    if (request.args[0].ttl) throw revert('TtlForbidden');
  } }, base, cases);
  assert.deepEqual(result, [{ label: 'valid control', passed: true }, { label: 'ttl', error: 'TtlForbidden' }]);
  await assert.rejects(simulateRejections({ simulateContract: async () => { throw revert('WrongValue'); } }, base, cases));
  await assert.rejects(simulateRejections({ simulateContract: async request => {
    if (request.args[0].ttl) throw revert('WrongValue');
  } }, base, cases));
  await assert.rejects(simulateRejections({ simulateContract: async () => {} }, base, cases), /accepted/);
});

test('public-width exploration reports actual one-second/uint64-boundary outcomes without inventing a maximum', async () => {
  const control = { args: [postParamsTuple(args)] };
  const observations = await simulateWindowWidths({ simulateContract: async request => {
    const params = request.args[0];
    const decoded = parseConditionRecord(Buffer.from(params.publicCondition.slice(2), 'hex'));
    assert.equal(params.t1, decoded.t1);
    assert.equal(params.t2, decoded.t2);
    if (params.t2 === (1n << 64n) - 1n) throw revert('BadWindow');
  } }, control);
  assert.deepEqual(observations.map(item => item.outcome), ['accepted', 'rejected']);
  assert.equal(observations[0].widthSecs, 1n);
  assert.equal(observations[1].t2, (1n << 64n) - 1n);
  assert.equal(observations[1].error, 'BadWindow');
  await assert.rejects(simulateWindowWidths({ simulateContract: async request => {
    if (request.args[0].t2 !== 5200n) throw revert('WrongValue');
  } }, control));
});
