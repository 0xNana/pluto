import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeAbiParameters, keccak256 } from 'viem';
import { parseConditionRecord } from '@nillion/covenants-sdk/browser';
import { compileDisclosureWindow, encodeDisclosurePayload, reportIdFor } from '../src/shared/disclosure.mjs';

const researcher = '0x1111111111111111111111111111111111111111';
const cipherHash = `0x${'22'.repeat(32)}`;
const keyCommit = `0x${'33'.repeat(32)}`;

test('report ID matches Solidity abi.encode and changes with the researcher', () => {
  const expected = keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' }],
    [researcher, cipherHash, keyCommit],
  ));
  assert.equal(reportIdFor(researcher, cipherHash, keyCommit), expected);
  assert.notEqual(reportIdFor('0x4444444444444444444444444444444444444444', cipherHash, keyCommit), expected);
});

test('payload is exactly K followed by report ID, without the SDK nonce', () => {
  const key = new Uint8Array(32).fill(7);
  const reportId = reportIdFor(researcher, cipherHash, keyCommit);
  const payload = encodeDisclosurePayload(key, reportId);
  assert.equal(payload.length, 64);
  assert.deepEqual(payload.slice(0, 32), key);
  assert.equal(`0x${Buffer.from(payload.slice(32)).toString('hex')}`, reportId);
  assert.throws(() => encodeDisclosurePayload(new Uint8Array(31), reportId), /32 bytes/);
  assert.throws(() => encodeDisclosurePayload(key, '0x1234'), /bytes32/);
});

test('window compiles into PUBLIC mode with zero TTL and matching timestamps', () => {
  const result = compileDisclosureWindow({ nowUnix: 1000n, t1: 1600n, t2: 5200n });
  const record = parseConditionRecord(result.conditionRecord);
  assert.equal(result.mode, 'PUBLIC_CONDITION');
  assert.equal(result.ttl, 0);
  assert.equal(record.assetId, 0);
  assert.equal(record.t1, result.t1);
  assert.equal(record.t2, result.t2);
});

test('windows that could mine too late or miss the minimum width are rejected', () => {
  assert.throws(() => compileDisclosureWindow({ nowUnix: 1000n, t1: 1599n, t2: 5200n }), /margin/);
  assert.throws(() => compileDisclosureWindow({ nowUnix: 1000n, t1: 1600n, t2: 5199n }), /minimum/);
  assert.throws(() => compileDisclosureWindow({ nowUnix: 1000n, t1: 1600.5, t2: 5200n }), /integer/);
  assert.throws(() => compileDisclosureWindow({ nowUnix: 1000n, t1: 1600n, t2: 1n << 64n }), /uint64/);
});
