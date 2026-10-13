import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak256 } from 'viem';
import { publishCiphertext } from '../packages/client/storage.mts';

const bytes = new TextEncoder().encode('PLUTO1 ciphertext test fixture');
const providers = ['a', 'b'].map(id => ({ id, uploadUrl: `https://${id}.storage.example/upload`, readUrl: `https://${id}.storage.example/report` }));
test('FR-104 client uploads only ciphertext, refetches both independent copies and verifies hashes', async () => {
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    return new Response(options.method === 'PUT' ? null : bytes);
  };
  const published = await publishCiphertext(bytes, keccak256(bytes), providers, ['https://pluto.example'], fetcher);
  assert.deepEqual(published, providers.map(p => p.readUrl));
  assert.equal(requests.length, 4);
  for (const { options } of requests.filter(r => r.options.method === 'PUT')) assert.deepEqual(options.body, bytes);
  assert.equal(requests.every(r => r.options.credentials === 'omit' && r.options.redirect === 'error'), true);
});
test('FR-104 mismatched, oversized, shared-host and Pluto-server copies block posting', async () => {
  await assert.rejects(publishCiphertext(bytes, keccak256(bytes), providers, ['https://pluto.example'], async () => new Response('wrong')));
  const tooLarge = new Uint8Array(1_048_576 + 35);
  await assert.rejects(publishCiphertext(bytes, keccak256(bytes), providers, ['https://pluto.example'], async (_url, options) =>
    new Response(options.method === 'PUT' ? null : tooLarge)), /exceeds/);
  await assert.rejects(publishCiphertext(bytes, keccak256(bytes), providers, ['https://pluto.example'], async (_url, options) =>
    new Response(options.method === 'PUT' ? null : bytes, { headers: options.method === 'PUT' ? {} : { 'Content-Length': String(tooLarge.length) } })), /retrieval/);
  for (const invalid of [[providers[0], providers[0]], [providers[0], { ...providers[0], id: 'b' }],
    [providers[0], { ...providers[1], uploadUrl: 'https://pluto.example/upload' }]]) {
    await assert.rejects(publishCiphertext(bytes, keccak256(bytes), invalid, ['https://pluto.example'], async () => { throw new Error('must not fetch'); }));
  }
});
