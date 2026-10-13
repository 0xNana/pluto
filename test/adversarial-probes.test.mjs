import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hexToBytes, keccak256, toHex } from 'viem';
import { mpkFromSecret, openLayer, reconstruct, seal } from '@nillion/covenants-sdk';
import { compileCondition } from '@nillion/covenants-sdk/browser';
import { encodeDisclosurePayload } from '../src/shared/disclosure.mjs';
import { rejectionPayload, copyPublicSeal, selectAdversarialScenarios } from '../scripts/lib/adversarial-probes.mjs';

test('partial adversarial runs select only missing cases and reject ambiguous selections', () => {
  assert.deepEqual(selectAdversarialScenarios(), ['copy-foreign', 'unbound', 'wrong-key']);
  assert.deepEqual(selectAdversarialScenarios(['wrong-key', 'unbound']), ['unbound', 'wrong-key']);
  assert.deepEqual(selectAdversarialScenarios(['wrong-key']), ['wrong-key']);
  for (const selection of [[], ['unknown'], ['unbound', 'unbound']]) {
    assert.throws(() => selectAdversarialScenarios(selection), /unique known scenarios/);
  }
});

test('copied public ciphertext preserves the complete SDK plaintext across a new public window', () => {
  const secrets = [1, 2, 3].map(n => new Uint8Array(32).fill(n));
  const mpks = secrets.map(mpkFromSecret);
  const payload = encodeDisclosurePayload(new Uint8Array(32).fill(7), `0x${'11'.repeat(32)}`);
  const first = seal(payload, 'PUBLIC_CONDITION', compileCondition({ window: { t1: 2000n, t2: 5600n } }), 2, mpks);
  const plaintext = new Uint8Array([...payload, ...first.nonce]);
  const params = { mode: 1, keyIds: [1n, 2n, 3n], k: 2, layers: first.layers.map(toHex), commit: first.commit };
  const copy = copyPublicSeal(params, compileCondition({ window: { t1: 6000n, t2: 9600n } }));
  const shares = copy.layers.map((layer, i) => openLayer(layer, secrets[i], hexToBytes(copy.commit), 'PUBLIC_CONDITION').share);
  assert.deepEqual(reconstruct(shares.slice(0, 2), 2), plaintext);
  assert.equal(copy.commit, first.commit);
  assert.equal(toHex(copy.layers[0]), toHex(first.layers[0]));
  assert.throws(() => copyPublicSeal({ ...params, mode: 0 }, copy.publicCondition), /public/);
  assert.throws(() => copyPublicSeal({ ...params, layers: [] }, copy.publicCondition), /layers/);
});

test('wrong-key probe changes only the key and leaves the committed key untouched', () => {
  const key = new Uint8Array(32).fill(7), reportId = `0x${'22'.repeat(32)}`;
  const correct = rejectionPayload('unbound', key, reportId);
  const wrong = rejectionPayload('wrong-key', key, reportId);
  assert.equal(correct.length, 64);
  assert.deepEqual(wrong.slice(32), correct.slice(32));
  assert.notEqual(keccak256(wrong.slice(0, 32)), keccak256(key));
  assert.deepEqual(key, new Uint8Array(32).fill(7));
  assert.throws(() => rejectionPayload('unknown', key, reportId), /scenario/);
});
