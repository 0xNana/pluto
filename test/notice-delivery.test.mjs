import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PortalStore } from '../packages/portal/store.mts';
import { PortalInbox } from '../packages/portal/inbox.mts';
import { ProtocolEnrollment } from '../packages/portal/enrollment.mts';
import { portalHandler } from '../packages/portal/http.mts';
import { prepareReport } from '../src/shared/report-crypto.mjs';
import { signNotice } from '../packages/client/notice.mts';
import { verifiedContacts, prepareNoticeDelivery, sendNoticeDelivery } from '../packages/client/delivery.mts';
import { decryptContactAttachment } from '../packages/client/attachment.mts';

test('FR-402/T-16 browser delivery encrypts before HTTP, rejects changed keys, and gives the selected recipient a decryptable attachment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pluto-delivery-')); await chmod(dir, 0o700);
  const origin = 'https://pluto.example', store = new PortalStore(join(dir, 'data.sqlite'), origin, 11155111);
  const inbox = new PortalInbox(store, 90 * 86400), handler = portalHandler(store, inbox, new ProtocolEnrollment(store));
  const authorKey = '0x' + '34'.repeat(32);
  const customer = privateKeyToAccount('0x' + '12'.repeat(32)), author = privateKeyToAccount(authorKey);
  const requests = [], fetcher = async (path, init = {}) => { requests.push({ path, init }); return handler(new Request(origin + path, { ...init, headers: { ...init.headers, Origin: origin } })); };
  try {
    store.enrollVerifiedProtocol('alpha.example', customer.address);
    const challenge = store.challenge(customer.address), session = await store.authenticate(challenge.id, await customer.signMessage({ message: challenge.message }));
    const recipient = await crypto.subtle.generateKey('X25519', true, ['deriveKey']), publicKey = toHex(new Uint8Array(await crypto.subtle.exportKey('raw', recipient.publicKey)));
    const selected = inbox.requestContact(session, 'alpha.example', { email: 'security@alpha.example', publicKey });
    assert.equal((await verifiedContacts('alpha.example', fetcher)).length, 0);
    inbox.confirmContact(session, 'alpha.example', selected.id, inbox.pendingDeliveries()[0].code);
    const [contact] = await verifiedContacts('alpha.example', fetcher);
    const plaintext = new TextEncoder().encode('private disclosure attachment fixture'), report = await prepareReport(plaintext, author.address);
    const notice = await signNotice({ version: 1, chainId: 11155111, registry: '0x' + '56'.repeat(20), reportId: report.reportId, triggerId: '7', cipherHash: report.cipherHash,
      keyCommit: report.keyCommit, cipherUris: ['https://a.example/cipher', 'https://b.example/cipher'], window: { t1: '2000000000', t2: '2000086400' }, researcher: author.address, verifyUrl: origin + '/#verifier' }, author);
    const options = { notice, key: report.key, plaintext: toHex(plaintext), contact, signer: author, confirmedFingerprint: contact.fingerprint, deliveryApproved: true };
    for (const changed of [{ deliveryApproved: false }, { confirmedFingerprint: report.keyCommit }, { key: '0x' + 'ff'.repeat(32) }, { signer: customer }]) await assert.rejects(prepareNoticeDelivery({ ...options, ...changed }));
    const delivery = await prepareNoticeDelivery(options);
    const before = requests.length;
    await assert.rejects(sendNoticeDelivery({ ...delivery, key: report.key }, fetcher), /fields/);
    assert.equal(requests.length, before);
    await sendNoticeDelivery(delivery, fetcher);
    assert.equal(inbox.list(session, 'alpha.example').length, 1);
    const decoded = await decryptContactAttachment(delivery.attachment, recipient.privateKey, contact, author.address);
    assert.equal(decoded.key, report.key); assert.equal(decoded.plaintext, toHex(plaintext));
    const body = requests.find(request => request.path === '/api/notices').init.body;
    assert.ok(!body.includes(report.key.slice(2))); assert.ok(!body.includes(toHex(plaintext).slice(2))); assert.ok(!body.includes(authorKey.slice(2)));
    const rotated = '0x' + 'ab'.repeat(32);
    inbox.rotateContact(session, 'alpha.example', contact.contactId, rotated);
    inbox.confirmRotation(session, 'alpha.example', contact.contactId, inbox.pendingDeliveries()[0].code);
    await assert.rejects(sendNoticeDelivery(delivery, fetcher), /not accepted/);
    await assert.rejects(verifiedContacts('alpha/../../.env', fetcher), /domain/);
    await assert.rejects(verifiedContacts('alpha.example', async () => Response.json([{ ...contact, fingerprint: report.keyCommit }])), /fingerprint/);
  } finally { store.close(); await rm(dir, { recursive: true }); }
});
