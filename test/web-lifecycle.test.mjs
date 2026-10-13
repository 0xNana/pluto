import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toHex } from 'viem';
import { signNotice } from '../packages/client/notice.mts';
import { prepareNoticeDelivery, sendNoticeDelivery } from '../packages/client/delivery.mts';

test('screen-scoped fetch preserves request controls and rejects disposal before or during a request', async () => {
  const { scopedFetch } = await import('../packages/web/lifecycle.mts');
  const screen = new AbortController(), caller = new AbortController();
  let calls = 0, observed;
  const fetcher = scopedFetch(screen.signal, async (_url, init) => { calls++; observed = init; return Response.json({ fixture: true }); });
  await fetcher('/api/notices', { method: 'POST', credentials: 'same-origin', body: 'encrypted fixture', signal: caller.signal });
  assert.equal(observed.credentials, 'same-origin'); assert.equal(observed.body, 'encrypted fixture');
  caller.abort(); assert.equal(observed.signal.aborted, true);
  screen.abort(); await assert.rejects(fetcher('/api/notices'), { name: 'AbortError' }); assert.equal(calls, 1);
  const pendingScreen = new AbortController(); let finish;
  const pending = scopedFetch(pendingScreen.signal, async () => new Promise(resolve => { finish = resolve; }))('/api/notices');
  pendingScreen.abort(); finish(Response.json({ fixture: true }));
  await assert.rejects(pending, { name: 'AbortError' });
});

test('actual encrypted notice signature verification cannot start HTTP after its React screen is disposed', async () => {
  const { scopedFetch } = await import('../packages/web/lifecycle.mts');
  const account = privateKeyToAccount('0x' + '11'.repeat(32)), key = '0x' + '12'.repeat(32);
  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const publicKey = toHex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  const fingerprint = keccak256(publicKey);
  const notice = await signNotice({ version: 1, chainId: 11155111, registry: '0x' + '22'.repeat(20), reportId: '0x' + '33'.repeat(32), triggerId: '1',
    cipherHash: '0x' + '44'.repeat(32), cipherUris: ['https://a.example/a', 'https://b.example/b'], keyCommit: keccak256(key),
    window: { t1: '1', t2: '2' }, researcher: account.address, verifyUrl: 'https://pluto.example/#verifier' }, account);
  const delivery = await prepareNoticeDelivery({ notice, key, contact: { contactId: 'fixture', keyVersion: 1, publicKey, fingerprint },
    signer: account, confirmedFingerprint: fingerprint, deliveryApproved: true });
  const screen = new AbortController(); let calls = 0;
  const sending = sendNoticeDelivery(delivery, scopedFetch(screen.signal, async () => { calls++; return Response.json({ delivered: true }); }));
  screen.abort(); await assert.rejects(sending, { name: 'AbortError' }); assert.equal(calls, 0);
});
