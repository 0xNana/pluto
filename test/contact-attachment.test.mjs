import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { encryptContactAttachment, decryptContactAttachment, verifyAttachment } from '../packages/client/attachment.mts';

const author = privateKeyToAccount('0x' + '12'.repeat(32));
const reportId = '0x' + '56'.repeat(32);
async function recipient() {
  const keys = await crypto.subtle.generateKey('X25519', true, ['deriveKey']);
  const publicKey = toHex(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
  return { keys, contact: { contactId: 'contact-1', keyVersion: 1, publicKey, fingerprint: keccak256(publicKey) } };
}
test('FR-402/T-16 explicit consent and selected fingerprint gate encrypted attachment delivery', async () => {
  const { keys, contact } = await recipient();
  const key = '0x' + 'ab'.repeat(32);
  const options = { reportId, contact, key, signer: author, confirmedFingerprint: contact.fingerprint, deliveryApproved: true };
  await assert.rejects(encryptContactAttachment({ ...options, deliveryApproved: false }));
  await assert.rejects(encryptContactAttachment({ ...options, confirmedFingerprint: reportId }));
  const signed = await encryptContactAttachment(options);
  assert.ok(!JSON.stringify(signed).includes(key.slice(2)));
  assert.equal((await verifyAttachment(signed, author.address, reportId)).contactId, contact.contactId);
  assert.equal((await decryptContactAttachment(signed, keys.privateKey, contact, author.address)).key, key);
  const rotated = await recipient();
  await assert.rejects(decryptContactAttachment(signed, rotated.keys.privateKey, rotated.contact, author.address));
  await assert.rejects(verifyAttachment({ ...signed, keyVersion: 2 }, author.address, reportId));
  await assert.rejects(verifyAttachment({ ...signed, ciphertext: '0x' + '00'.repeat(80) }, author.address, reportId));
  await assert.rejects(verifyAttachment({ ...signed, key }, author.address, reportId));
});
