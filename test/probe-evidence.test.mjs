import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak256, hexToBytes } from 'viem';
import { verifySpikeReveal, classifyObservation } from '../src/chain/probe-evidence.mjs';
import { encodeDisclosurePayload } from '../src/shared/disclosure.mjs';
import { publicFailure, receiptEvidence } from '../scripts/lib/probe-runtime.mjs';

const key = `0x${'07'.repeat(32)}`;
const reportId = `0x${'08'.repeat(32)}`;
const evidence = { reportId, keyCommit: keccak256(key) };
const payload = encodeDisclosurePayload(hexToBytes(key), reportId);
const accepted = { args: { reportId, key } };

test('M0 observation checks the revealed key and report against the evidence and hook event', () => {
  assert.equal(verifySpikeReveal(evidence, payload, accepted), true);
  for (const data of [payload.slice(0, 63), new Uint8Array(64), new Uint8Array(96)]) {
    assert.throws(() => verifySpikeReveal(evidence, data, accepted));
  }
  for (const event of [undefined, { args: { reportId: key, key } }, { args: { reportId, key: reportId } }]) {
    assert.throws(() => verifySpikeReveal(evidence, payload, event));
  }
  assert.throws(() => verifySpikeReveal({ ...evidence, keyCommit: reportId }, payload, accepted));
});

test('M0 observation refuses to infer settlement from empty escrow or incomplete event scans', () => {
  assert.equal(classifyObservation({ nowUnix: 5000n, expiry: 5000n, escrowWei: 0n }), 'pending');
  assert.equal(classifyObservation({ nowUnix: 5001n, expiry: 5000n, escrowWei: 0n }), 'expired-unsettled');
  assert.equal(classifyObservation({ nowUnix: 5001n, expiry: 5000n, escrowWei: 0n, settlementConfirmed: true }), 'expired-settled');
  assert.equal(classifyObservation({ nowUnix: 5001n, expiry: 5000n, escrowWei: 0n,
    resolved: true, settlementConfirmed: true }), 'expired-settled');
  assert.equal(classifyObservation({ nowUnix: 5001n, expiry: 5000n, escrowWei: 0n,
    resolved: true, verifiedReveal: true }), 'revealed-accepted');
  assert.throws(() => classifyObservation({ nowUnix: 5001n, expiry: 5000n, resolved: true }));
  assert.throws(() => classifyObservation({ nowUnix: 5001n, expiry: 5000n, verifiedReveal: true }));
});

test('M0 errors with credential-bearing URLs and signed calldata never enter public evidence', () => {
  const error = new Error('RPC https://user:secret@rpc.example/signed-calldata');
  error.cause = Object.assign(new Error('secret private key'), { code: 'EAI_AGAIN' });
  const result = publicFailure(error);
  assert.deepEqual(result.codes, ['EAI_AGAIN']);
  assert.doesNotMatch(JSON.stringify(result), /secret|rpc\.example|signed-calldata|private key/);
  const receipt = receiptEvidence({ transactionHash: 'hash', blockNumber: 42n, from: 'payer',
    status: 'success', gasUsed: 21000n, effectiveGasPrice: 9n, logs: [{ secret: 'key' }] });
  assert.equal(receipt.gasCostWei, 189000n);
  assert.equal(receipt.logs, undefined);
});

test('known numeric SDK committee failures stay actionable without exposing arbitrary error text', () => {
  for (const message of [
    'only 2 eligible nodes; need m=3',
    'need 2 distinct operators for m=3 k=2, found 1',
    'the operator cap of 2 admits at most 2 of 3 eligible nodes; need m=3',
    'operator cap 2 left only 2 of m=3 selectable'
  ]) {
    assert.equal(publicFailure(new Error(message)).detail, message);
    const secret = message + '\nhttps://rpc.invalid/secret';
    assert.doesNotMatch(JSON.stringify(publicFailure(new Error(secret))), /rpc.invalid|secret|eligible|operator/);
  }
});
