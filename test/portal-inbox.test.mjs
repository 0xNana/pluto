import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256 } from 'viem';
import { PortalStore } from '../packages/portal/store.mts';
import { PortalInbox } from '../packages/portal/inbox.mts';
import { signNotice } from '../packages/client/notice.mts';

const accounts = ['12', '34'].map(x => privateKeyToAccount('0x' + x.repeat(32)));
test('T-15/16 scoped contacts, inbox, export and deletion never expose private metadata publicly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pluto-inbox-')); await chmod(directory, 0o700);
  const store = new PortalStore(join(directory, 'portal.sqlite'), 'https://pluto.example', 11155111);
  const inbox = new PortalInbox(store, 90 * 86400);
  try {
    const sessions = [];
    for (const [index, account] of accounts.entries()) {
      store.enrollVerifiedProtocol(`${index ? 'beta' : 'alpha'}.example`, account.address);
      const c = store.challenge(account.address); sessions.push(await store.authenticate(c.id, await account.signMessage({ message: c.message })));
    }
    const contact = inbox.requestContact(sessions[0], 'alpha.example', { email: 'security@alpha.example', publicKey: '0x' + 'ab'.repeat(32) });
    assert.deepEqual(inbox.directory('alpha.example'), []);
    const delivery = inbox.pendingDeliveries()[0];
    inbox.confirmContact(sessions[0], 'alpha.example', contact.id, delivery.code);
    const verified = inbox.directory('alpha.example')[0];
    assert.equal(verified.fingerprint, keccak256(verified.publicKey)); assert.equal(verified.email, undefined);
    const notice = await signNotice({ version: 1, chainId: 11155111, registry: '0x' + '78'.repeat(20), reportId: '0x' + '56'.repeat(32), triggerId: '0',
      cipherHash: '0x' + '90'.repeat(32), keyCommit: '0x' + 'ab'.repeat(32), cipherUris: ['https://a.example/cipher', 'https://b.example/cipher'],
      researcher: accounts[0].address, window: { t1: '2000000000', t2: '2000086400' }, verifyUrl: 'https://pluto.example/verify#report' }, accounts[0]);
    await inbox.deliverNotice(verified.contactId, notice);
    await inbox.deliverNotice(verified.contactId, notice);
    assert.equal(inbox.list(sessions[0], 'alpha.example').length, 1);
    for (const action of [() => inbox.list(sessions[1], 'alpha.example'), () => inbox.contacts(sessions[1], 'alpha.example'),
      () => inbox.export(sessions[1], 'alpha.example'), () => inbox.removeNotice(sessions[1], 'alpha.example', notice.reportId)]) assert.throws(action, /Not authorized/);
    assert.equal(inbox.publicCopy(notice.reportId), undefined);
    assert.ok(inbox.export(sessions[0], 'alpha.example').accessLog.length > 0);
    inbox.removeNotice(sessions[0], 'alpha.example', notice.reportId);
    assert.equal(inbox.list(sessions[0], 'alpha.example').length, 0);
    const rotation = inbox.rotateContact(sessions[0], 'alpha.example', verified.contactId, '0x' + 'cd'.repeat(32));
    assert.equal(inbox.directory('alpha.example')[0].keyVersion, 1);
    const nextDelivery = inbox.pendingDeliveries()[0];
    inbox.confirmRotation(sessions[0], 'alpha.example', verified.contactId, nextDelivery.code);
    assert.equal(rotation.keyVersion, 2);
    assert.equal(inbox.directory('alpha.example')[0].keyVersion, 2);
    assert.throws(() => inbox.rotateContact(sessions[1], 'alpha.example', verified.contactId, verified.publicKey), /Not authorized/);
    const pending = inbox.deliverNotice(verified.contactId, notice);
    store.setEnabled(sessions[0], 'alpha.example', false);
    await assert.rejects(pending, /unavailable/);
  } finally { store.close(); await rm(directory, { recursive: true }); }
});
