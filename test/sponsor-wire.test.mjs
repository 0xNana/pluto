import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileCondition } from '@nillion/covenants-sdk/browser';
import { parseSponsorInput, sponsorReleaseMessage, sponsorRequestId } from '../packages/client/sponsor-wire.mts';
import { encodeWire, decodeWire } from '../packages/client/wire.mts';

test('FR-211/802 sponsorship boundary accepts only bounded public terms, scopes release and excludes recovery secrets', () => {
  const hex = (size, n) => '0x' + n.repeat(size), author = hex(20, '12'), payer = hex(20, '34');
  const grant = { researcher: author, payer, nonce: 1n, deadline: 1500n, signature: hex(65, '56') };
  const input = { protocolId: 'alpha.example', bundle: { reportId: hex(32, '11'), cipherHash: hex(32, '22'), keyCommit: hex(32, '33'),
    args: { mode: 'PUBLIC_CONDITION', ttl: 0, keys: [1n, 2n, 3n].map(keyId => ({ keyId, nodeId: keyId, mpk: '0x01' })), k: 2,
      t1: 1600n, t2: 5200n, ceilingWei: 6n, hook: hex(20, '78'), hookGasLimit: 250000, retryWindowSecs: 600,
      layers: [1, 2, 3].map(() => new Uint8Array(230)), commit: hex(32, '44'), publicCondition: compileCondition({ window: { t1: 1600n, t2: 5200n } }) },
    authorization: { author, payer, minCeiling: 5n, nonce: 0n, deadline: 1500n, signature: hex(65, '67') }, registration: grant }, binding: { ...grant, nonce: 2n, triggerId: 7n } };
  assert.deepEqual(parseSponsorInput(decodeWire(encodeWire(input))), input);
  for (const bad of [ { ...input, recovery: {} }, { ...input, protocolId: 'alpha.example/other' },
    { ...input, bundle: { ...input.bundle, key: hex(32, '99') } },
    { ...input, bundle: { ...input.bundle, args: { ...input.bundle.args, nonce: hex(32, '99') } } },
    { ...input, bundle: { ...input.bundle, args: { ...input.bundle.args, skipLivenessCheck: true } } },
    { ...input, bundle: { ...input.bundle, args: { ...input.bundle.args, ttl: 1 } } },
    { ...input, bundle: { ...input.bundle, args: { ...input.bundle.args, t1: 1600 } } },
    { ...input, bundle: { ...input.bundle, args: { ...input.bundle.args, keys: [{ ...input.bundle.args.keys[0], plaintext: 'private' }, ...input.bundle.args.keys.slice(1)] } } },
    { ...input, binding: { ...input.binding, deadline: 1n << 64n } },
  ]) assert.throws(() => parseSponsorInput(bad));
  const bounds = { requestHash: hex(32, '77'), ethReserveWei: 100n, feeNil: 25n };
  const message = sponsorReleaseMessage('https://pluto.example', 'alpha.example', bounds);
  assert.match(message, /Chain: 11155111/); assert.match(message, /100/);
  assert.notEqual(message, sponsorReleaseMessage('https://other.example', 'alpha.example', bounds));
  assert.notEqual(message, sponsorReleaseMessage('https://pluto.example', 'beta.example', bounds));
  assert.notEqual(message, sponsorReleaseMessage('https://pluto.example', 'alpha.example', { ...bounds, ethReserveWei: 101n }));
  assert.equal(sponsorRequestId(message), sponsorRequestId(message));
});
