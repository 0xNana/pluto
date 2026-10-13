import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { signNotice, verifyNotice, publicNotice } from '../packages/client/notice.mts';

const author = privateKeyToAccount('0x' + '12'.repeat(32));
const notice = { version: 1, chainId: 11155111,
  registry: '0x' + '34'.repeat(20), reportId: '0x' + '56'.repeat(32),
  triggerId: '0', cipherHash: '0x' + '78'.repeat(32),
  cipherUris: ['https://storage-a.example/report', 'https://storage-b.example/report'],
  keyCommit: '0x' + '90'.repeat(32), window: { t1: '1000', t2: '4600' },
  researcher: author.address, verifyUrl: 'https://pluto.example/verify#report' };

test('FR-401 notice signatures survive key ordering and private attachment removal', async () => {
  const signed = await signNotice(notice, author);
  assert.equal((await verifyNotice(signed)).triggerId, '0');
  const reordered = Object.fromEntries(Object.entries(signed).reverse());
  assert.equal((await verifyNotice(reordered)).reportId, notice.reportId);
  assert.deepEqual(publicNotice({ ...signed, recipientEncryptedKey: { opaque: true } }), signed);
});

test('FR-401 strict signed notice rejects altered terms, extra secret fields and unsafe URLs', async () => {
  const signed = await signNotice(notice, author);
  for (const change of [{ triggerId: '1' }, { key: 'forbidden' }, { window: { t1: '1000', t2: '4601' } },
    { cipherUris: ['https://user:password@storage.example/report'] },
    { verifyUrl: 'javascript:alert(1)' }, { researcher: notice.registry }]) {
    await assert.rejects(verifyNotice({ ...signed, ...change }));
  }
  await assert.rejects(signNotice({ ...notice, triggerId: '-1' }, author));
});
