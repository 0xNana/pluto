import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbi } from 'viem';
import { triggerMarketAbi } from '@nillion/covenants-sdk';
import { verifyRejectionReceipt } from '../scripts/lib/rejection-receipt.mjs';

const market = '0x1111111111111111111111111111111111111111', hook = '0x2222222222222222222222222222222222222222';
const abi = parseAbi(['event Rejected(uint256 indexed triggerId, uint8 reason)',
  'event Disclosed(bytes32 indexed reportId, uint256 indexed triggerId, bytes32 key)']);
const plaintext = `0x${'07'.repeat(96)}`;
const expected = { market, hook, triggerId: 2n, commit: keccak256(plaintext), expectedReason: 5 };
function log(address, abi, eventName, args) {
  const event = abi.find(item => item.type === 'event' && item.name === eventName);
  return { address, topics: encodeEventTopics({ abi, eventName, args }),
    data: encodeAbiParameters(event.inputs.filter(field => !field.indexed), event.inputs.filter(field => !field.indexed).map(field => args[field.name])) };
}
const logs = [log(market, triggerMarketAbi, 'TriggerResolved', { triggerId: 2n, usedSlots: [0, 1], reconstructor: market, plaintext }),
  log(market, triggerMarketAbi, 'HookInvoked', { triggerId: 2n, ok: true }),
  log(hook, abi, 'Rejected', { triggerId: 2n, reason: 5 })];

test('rejection proof requires committed market reveal, successful hook ACK and matching registry reason', () => {
  assert.equal(verifyRejectionReceipt({ status: 'success', logs }, expected, abi).reason, 5);
  for (const patch of [{ status: 'reverted' }, { logs: logs.slice(0, 2) }, { logs: [...logs, logs[2]] },
    { logs: logs.map((entry, i) => i === 2 ? { ...entry, address: market } : entry) },
    { logs: logs.map(entry => ({ ...entry, removed: true })) }]) {
    assert.throws(() => verifyRejectionReceipt({ status: 'success', logs, ...patch }, expected, abi));
  }
  assert.throws(() => verifyRejectionReceipt({ status: 'success', logs }, { ...expected, expectedReason: 1 }, abi));
  assert.throws(() => verifyRejectionReceipt({ status: 'success', logs }, { ...expected, commit: `0x${'00'.repeat(32)}` }, abi));
  const disclosed = log(hook, abi, 'Disclosed', { reportId: `0x${'01'.repeat(32)}`, triggerId: 2n, key: `0x${'07'.repeat(32)}` });
  assert.throws(() => verifyRejectionReceipt({ status: 'success', logs: [...logs, disclosed] }, expected, abi));
});
