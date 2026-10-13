import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeFunctionData, encodeFunctionResult, keccak256, parseAbi } from 'viem';
import { measureHookTrace, reconcileRefunds, sponsorshipDecision } from '../src/chain/spike-observation.mjs';

const market = '0x1111111111111111111111111111111111111111';
const hook = '0x2222222222222222222222222222222222222222';
const abi = parseAbi(['function onReveal(uint256 triggerId, bytes plaintext) returns (bytes4)']);
const plaintext = `0x${'07'.repeat(96)}`;
const call = { type: 'CALL', from: market, to: hook, gas: '0x3d090', gasUsed: '0xb564',
  input: encodeFunctionData({ abi, functionName: 'onReveal', args: [0n, plaintext] }),
  output: encodeFunctionResult({ abi, functionName: 'onReveal', result: '0xd8e071b6' }) };
const expected = { market, hook, abi, triggerId: 0n, commit: keccak256(plaintext), gasLimit: 250000n };

test('P-04 measures callback gas from nested callTracer frames, distinct from transaction gas', () => {
  const measured = measureHookTrace({ type: 'CALL', calls: [{ type: 'DELEGATECALL', calls: [call] }] }, expected);
  assert.equal(measured.gasUsed, 46436n);
  assert.equal(measured.ack, '0xd8e071b6');
  assert.throws(() => measureHookTrace({ calls: [call, call] }, expected), /exactly one/);
  for (const patch of [{ from: hook }, { error: 'execution reverted' }, { gasUsed: 'nonsense' },
    { output: '0x' }, { gasUsed: '0x40000' }, { input: encodeFunctionData({ abi, functionName: 'onReveal', args: [1n, plaintext] }) }]) {
    assert.throws(() => measureHookTrace({ ...call, ...patch }, expected));
  }
  const retry = measureHookTrace({ ...call, gas: '0x80000', gasUsed: '0x40000' }, expected);
  assert.equal(retry.withinDeclaredBudget, false);
  assert.equal(retry.forwardingCapped, false);
});

test('P-04 reconciles automatic refunds and later claims without double-counting escrow', () => {
  const events = [ { eventName: 'RefundOwed', args: { amount: 300n } },
    { eventName: 'RefundClaimed', args: { amount: 300n } }, { eventName: 'RefundIssued', args: { amount: 100n } } ];
  const result = reconcileRefunds({ deposited: 1000n, remaining: 0n, owed: 0n, events });
  assert.equal(result.spentWei, 600n);
  assert.equal(result.paidWei, 400n);
  assert.equal(result.allocatedWei, 400n);
  assert.equal(reconcileRefunds({ deposited: 1000n, remaining: 200n, owed: 300n, events: events.slice(0, 1) }).spentWei, 500n);
  assert.throws(() => reconcileRefunds({ deposited: 100n, remaining: 0n, owed: 0n, events }), /refund/);
  assert.throws(() => reconcileRefunds({ deposited: 1000n, remaining: 0n, owed: 1n, events }), /refund/);
});

test('FR-211 decision stays pending until zero-prepayment, payer costs and an actual refund are verified', () => {
  const evidence = { mode: 'sponsored', payer: market, sponsorshipVerified: true, feeNil: '25',
    payerNilBefore: '100', payerNilAfter: '75', researcherFundsBefore: { ethWei: '0', nilWei: '0', nonce: 0 },
    researcherFundsAfter: { ethWei: '0', nilWei: '0', nonce: 0 }, transactions: [{ sender: market, status: 'success' }] };
  const observation = { state: 'revealed-accepted', refundRecipient: market,
    refundReconciliation: { paidWei: 400n, owedWei: 0n } };
  assert.equal(sponsorshipDecision(evidence, observation).decision, 'go');
  assert.equal(sponsorshipDecision(evidence).decision, 'pending');
  assert.equal(sponsorshipDecision({ ...evidence, sponsorshipVerified: false }, observation).decision, 'pending');
  assert.equal(sponsorshipDecision({ ...evidence, researcherFundsAfter: { ethWei: '1', nilWei: '0', nonce: 0 } }, observation).decision, 'no-go');
  assert.equal(sponsorshipDecision(evidence, { ...observation, refundReconciliation: { paidWei: 0n, owedWei: 0n } }).decision, 'pending');
});
