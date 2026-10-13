import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { PortalStore } from '../packages/portal/store.mts';

const alice = privateKeyToAccount('0x' + '12'.repeat(32));
const bob = privateKeyToAccount('0x' + '34'.repeat(32));
test('NFR-10/T-15 wallet sessions persist, prevent cross-tenant reads and reject nonce replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pluto-portal-')); await chmod(directory, 0o700);
  let store;
  try {
    store = new PortalStore(join(directory, 'portal.sqlite'), 'https://pluto.example', 11155111);
    store.enrollVerifiedProtocol('alpha.example', alice.address);
    store.enrollVerifiedProtocol('beta.example', bob.address);
    const challenge = store.challenge(alice.address);
    await assert.rejects(store.authenticate(challenge.id, await bob.signMessage({ message: challenge.message })));
    const token = await store.authenticate(challenge.id, await alice.signMessage({ message: challenge.message }));
    await assert.rejects(store.authenticate(challenge.id, await alice.signMessage({ message: challenge.message })));
    assert.equal(store.account(token, 'alpha.example').protocolId, 'alpha.example');
    assert.throws(() => store.account(token, 'beta.example'), /Not authorized/);
    store.close(); store = new PortalStore(join(directory, 'portal.sqlite'), 'https://pluto.example', 11155111);
    assert.throws(() => new PortalStore(join(directory, 'portal.sqlite'), 'https://other.example', 11155111), /context mismatch/);
    assert.throws(() => new PortalStore(join(directory, 'portal.sqlite'), 'https://pluto.example', 1), /context mismatch/);
    assert.equal(store.account(token, 'alpha.example').protocolId, 'alpha.example');
    store.setEnabled(token, 'alpha.example', false);
    assert.throws(() => store.account(token, 'alpha.example'), /Not authorized/);
    store.close(); store = undefined;
  } finally { store?.close(); await rm(directory, { recursive: true }); }
});
