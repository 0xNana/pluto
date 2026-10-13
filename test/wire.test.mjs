import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeWire, encodeWire } from '../packages/client/wire.mts';

test('public wire codec preserves SDK integers and bytes and rejects malformed or unbounded values', () => {
  const value = { id: 0n, maximum: (1n << 256n) - 1n, condition: new Uint8Array([0, 255, 16]), nested: [123n, 'PUBLIC_CONDITION'] };
  assert.deepEqual(decodeWire(encodeWire(value)), value);
  for (const integer of ['-1', '01', '1.2', String(1n << 256n), '9'.repeat(79)]) assert.throws(() => decodeWire(JSON.stringify({ $bigint: integer })), /integer/);
  for (const bytes of ['0x1', '0xzz', '0x' + 'ab'.repeat(50_000)]) assert.throws(() => decodeWire(JSON.stringify({ $bytes: bytes })), /bytes/);
  assert.throws(() => decodeWire(' '.repeat(2_300_001)), /large/);
});
