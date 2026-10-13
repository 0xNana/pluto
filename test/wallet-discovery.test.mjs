import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverWallets } from '../packages/web/wallet-discovery.mts';
const provider = () => ({ request() { throw new Error('Discovery must never request accounts'); }, on() {}, removeListener() {} });
const announcement = (wallet, name, uuid = 'aabbccdd-1234-4567-8123-aabbccddeeff') => new CustomEvent('eip6963:announceProvider', {
  detail: { provider: wallet, info: { name, uuid, icon: 'https://evil.example/icon.svg', rdns: 'untrusted.example' } },
});
test('EIP-6963 discovers late wallets, deduplicates the legacy provider and removes listeners on disposal', () => {
  const host = new EventTarget(); host.ethereum = provider(); let wallets, requested = 0;
  host.addEventListener('eip6963:requestProvider', () => { requested++; host.dispatchEvent(announcement(host.ethereum, 'Example wallet')); });
  const dispose = discoverWallets(host, value => { wallets = value; });
  assert.equal(requested, 1); assert.equal(wallets.length, 1); assert.equal(wallets[0].name, 'Example wallet');
  const second = provider(); host.dispatchEvent(announcement(second, '<img src=x onerror=alert(1)>'));
  assert.equal(wallets.length, 2); assert.equal(wallets[1].name, '<img src=x onerror=alert(1)>');
  assert.equal('icon' in wallets[1], false); assert.equal('rdns' in wallets[1], false);
  dispose(); host.dispatchEvent(announcement(provider(), 'After disposal')); assert.equal(wallets.length, 2);
});
test('wallet discovery bounds announcements and rejects malformed names, providers and UUIDs', () => {
  const host = new EventTarget(); let wallets;
  const dispose = discoverWallets(host, value => { wallets = value; });
  try {
    for (const name of ['', 'x'.repeat(81), 'control\nname']) host.dispatchEvent(announcement(provider(), name));
    host.dispatchEvent(announcement({}, 'Invalid provider'));
    host.dispatchEvent(announcement(provider(), 'Invalid UUID', 'not-a-uuid'));
    assert.equal(wallets.length, 0);
    for (let i = 0; i < 32; i++) host.dispatchEvent(announcement(provider(), `Wallet ${i}`));
    assert.equal(wallets.length, 16); assert.equal(new Set(wallets.map(wallet => wallet.id)).size, 16);
  } finally { dispose(); }
});
