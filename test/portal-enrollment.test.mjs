import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { PortalStore } from '../packages/portal/store.mts';
import { ProtocolEnrollment } from '../packages/portal/enrollment.mts';

test('FR-400 ownership proof binds domain, staff wallet, origin and expiry; existing domains cannot be taken over', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pluto-enroll-')); await chmod(directory, 0o700);
  let now = 1000;
  const store = new PortalStore(join(directory, 'portal.sqlite'), 'https://pluto.example', 11155111, () => now);
  const account = privateKeyToAccount('0x' + '12'.repeat(32));
  try {
    const auth = store.challenge(account.address), session = await store.authenticate(auth.id, await account.signMessage({ message: auth.message }));
    let txt = [];
    const enrollment = new ProtocolEnrollment(store, async domain => { assert.match(domain, /^_pluto-verification\.(?:alpha|expired)\.example$/); return txt; });
    const expired = enrollment.request(session, 'expired.example'); txt = [[expired.value]];
    now += 1801;
    await assert.rejects(enrollment.confirm(session, expired.id), /Ownership proof unavailable/);
    assert.throws(() => store.account(session, 'expired.example'), /Not authorized/);
    const proof = enrollment.request(session, 'alpha.example');
    txt = [];
    await assert.rejects(enrollment.confirm(session, proof.id), /Ownership proof unavailable/);
    txt = [[proof.value]];
    await enrollment.confirm(session, proof.id);
    assert.equal(store.account(session, 'alpha.example').role, 'admin');
    await assert.rejects(enrollment.confirm(session, proof.id));
    assert.throws(() => enrollment.request(session, 'alpha.example'), /already enrolled/);
    assert.throws(() => enrollment.request(session, '127.0.0.1'));
  } finally { store.close(); await rm(directory, { recursive: true }); }
});
