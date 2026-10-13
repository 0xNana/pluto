import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicEventMetadata } from '../src/shared/public-output.mjs';

test('diagnostic event projection retains identifiers but never raw data, plaintext or keys', () => {
  const secret = '0x' + 'a7'.repeat(32);
  const projected = publicEventMetadata({ eventName: 'Disclosed', transactionHash: '0x' + 'b8'.repeat(32),
    blockNumber: 4n, data: secret, topics: [secret], args: { reportId: '0x' + 'c9'.repeat(32),
      triggerId: 2n, key: secret, plaintext: secret, recipientPrivateKey: secret, arbitrary: secret } });
  const serialized = JSON.stringify(projected, (_, value) => typeof value === 'bigint' ? String(value) : value);
  assert.ok(!serialized.includes(secret));
  assert.equal(projected.args.triggerId, 2n);
  assert.equal(projected.event, 'Disclosed');
  assert.equal(projected.data, undefined);
  assert.deepEqual(Object.keys(projected.args).sort(), ['reportId', 'triggerId']);
});
