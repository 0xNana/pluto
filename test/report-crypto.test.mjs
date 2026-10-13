import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCipheriv } from 'node:crypto';
import { hexToBytes, keccak256 } from 'viem';
import { prepareReport, validateRecoveryBundle, decryptReport } from '../src/shared/report-crypto.mjs';
import { reportIdFor } from '../src/shared/disclosure.mjs';

const researcher = '0x1111111111111111111111111111111111111111';
const report = new TextEncoder().encode('Synthetic vulnerability report, including \u0000 and Unicode: é.');

test('FR-101/103 independent AES-GCM and envelope known answers plus Keccak empty vector', async () => {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(32), 'AES-GCM', false, ['encrypt']);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, key, new Uint8Array(16)));
  assert.equal(Buffer.from(encrypted).toString('hex'), 'cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919');
  const padded = Buffer.alloc(4096); padded.writeUInt32BE(3); padded.write('abc', 4);
  const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32), Buffer.alloc(12));
  cipher.setAAD(Buffer.from('PLUTO1'));
  const envelope = Buffer.concat([Buffer.from('PLUTO1'), Buffer.alloc(12), cipher.update(padded), cipher.final(), cipher.getAuthTag()]);
  assert.equal(keccak256(envelope), '0x9e981e79c0930feb841e1810758a9aa5b59bf57c8cecce01e5cd81266b457631');
  assert.deepEqual(await decryptReport(envelope, new Uint8Array(32)), new TextEncoder().encode('abc'));
  assert.equal(keccak256(new Uint8Array()), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
});

test('local report preparation produces randomized AEAD ciphertext and Solidity commitments', async () => {
  const a = await prepareReport(report, researcher);
  const b = await prepareReport(report, researcher);
  assert.notEqual(a.key, b.key);
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.equal(a.keyCommit, keccak256(a.key));
  assert.equal(a.cipherHash, keccak256(a.ciphertext));
  assert.equal(a.reportId, reportIdFor(researcher, a.cipherHash, a.keyCommit));
  assert.equal(hexToBytes(a.ciphertext).length, 6 + 12 + 4096 + 16);
  assert.equal(a.plaintext, undefined);
  assert.deepEqual(await decryptReport(hexToBytes(a.ciphertext), hexToBytes(a.key)), report);
  assert.deepEqual(await validateRecoveryBundle(JSON.parse(JSON.stringify(a))), a);
});

test('padding uses fixed buckets and refuses oversized reports before encryption', async () => {
  const lengths = [];
  for (const size of [0, 1, 4092, 4093]) {
    const bundle = await prepareReport(new Uint8Array(size), researcher);
    lengths.push(hexToBytes(bundle.ciphertext).length);
    assert.equal((await decryptReport(hexToBytes(bundle.ciphertext), hexToBytes(bundle.key))).length, size);
  }
  assert.deepEqual(lengths, [4130, 4130, 4130, 16418]);
  await assert.rejects(prepareReport(new Uint8Array(1048573), researcher), /size/);
});

test('recovery validation rejects changed hashes, keys, authors, IDs and secret extra fields', async () => {
  const bundle = await prepareReport(report, researcher);
  for (const changes of [{ version: 2 }, { cipherHash: bundle.keyCommit }, { keyCommit: bundle.cipherHash },
    { reportId: bundle.keyCommit }, { researcher: '0x2222222222222222222222222222222222222222' },
    { key: '0x12' }, { ciphertext: '0x123' }, { plaintext: 'must not be accepted' }]) {
    await assert.rejects(validateRecoveryBundle({ ...bundle, ...changes }));
  }
  const changed = hexToBytes(bundle.ciphertext);
  changed[changed.length - 1] ^= 1;
  await assert.rejects(decryptReport(changed, hexToBytes(bundle.key)));
  await assert.rejects(decryptReport(hexToBytes(bundle.ciphertext), new Uint8Array(32)));
  changed[0] ^= 1;
  await assert.rejects(decryptReport(changed, hexToBytes(bundle.key)));
});
