import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hexToBytes, keccak256 } from 'viem';
import { prepareReport } from '../src/shared/report-crypto.mjs';
import { prepareTlockComparison, observeTlockComparison, quicknet } from '../src/chain/tlock-comparison.mjs';

const researcher = '0x1111111111111111111111111111111111111111';
const t1 = quicknet.genesis_time + 3001;
const armor = (round, hash = quicknet.hash) => {
  const framed = Buffer.from(`age-encryption.org/v1\n-> tlock ${round} ${hash}\nYWJj\n--- fake\nopaque`).toString('base64');
  return `-----BEGIN AGE ENCRYPTED FILE-----\n${framed.match(/.{1,64}/g).join('\n')}\n-----END AGE ENCRYPTED FILE-----\n`;
};
async function fixture() {
  const plaintext = new TextEncoder().encode('The identical synthetic report for G1.');
  const bundle = await prepareReport(plaintext, researcher);
  const journal = { version: 1, chainId: 11155111, registry: researcher, market: researcher,
    researcher, reportId: bundle.reportId, cipherHash: bundle.cipherHash, keyCommit: bundle.keyCommit,
    commit: '0x' + '11'.repeat(32), sealNonce: '0x' + '22'.repeat(32), state: 'bound',
    window: { t1: BigInt(t1), t2: BigInt(t1 + 3600) }, transactions: [], triggerId: 0n };
  let payload;
  let time = t1 * 1000 - 600000;
  let available = true;
  // This double tests the adapter, not tlock cryptography; live library acceptance stays open.
  const sdk = { mainnetClient: () => ({ options: { disableBeaconVerification: false },
    chain: () => ({ info: async () => quicknet }) }),
    async timelockEncrypt(round, bytes) { payload = Uint8Array.from(bytes); return armor(round); },
    async timelockDecrypt() { if (!available) throw new Error('credential-bearing fetch failure'); return payload; } };
  const services = { sdk, now: () => time, monotonic: () => 100 };
  return { plaintext, bundle, journal, services, setTime: value => { time = value; },
    setAvailable: value => { available = value; }, setPayload: value => { payload = value; } };
}

test('tlock comparison uses the same K/report ID and rounds release up, never before t1', async () => {
  const f = await fixture();
  const evidence = await prepareTlockComparison(f, f.services);
  assert.equal(evidence.reportId, f.bundle.reportId);
  assert.equal(evidence.cipherHash, f.bundle.cipherHash);
  assert.equal(evidence.triggerId, '0');
  assert.ok(evidence.roundTimeUnix >= t1 && evidence.roundTimeUnix < t1 + 3);
  assert.equal(evidence.round, 1002);
  assert.equal(evidence.status, 'sealed');
  assert.equal(evidence.cost.transactionWei, '0');
  assert.equal(evidence.cost.hosting, 'unmeasured');
  assert.equal(evidence.g1Decision, 'pending');
  assert.ok(!JSON.stringify(evidence).includes(f.bundle.key.slice(2)));
  const pending = await observeTlockComparison({ evidence, ciphertext: hexToBytes(f.bundle.ciphertext) }, f.services);
  assert.equal(pending.evidence.status, 'pending');
  assert.equal(pending.plaintext, undefined);
  f.setTime((evidence.roundTimeUnix + 4) * 1000);
  const observed = await observeTlockComparison({ evidence, ciphertext: hexToBytes(f.bundle.ciphertext) }, f.services);
  assert.deepEqual(observed.plaintext, f.plaintext);
  assert.equal(observed.evidence.observation.releaseDeltaSecs, evidence.roundTimeUnix + 4 - t1);
  assert.equal(observed.evidence.observation.latencyKind, 'upper-bound-at-observation');
  assert.equal(observed.evidence.g1Decision, 'pending');
  assert.ok(!JSON.stringify(observed.evidence).includes(f.bundle.key.slice(2)));
});

test('comparison binds advertised round and chain to the encrypted capsule recipient', async () => {
  const f = await fixture();
  const evidence = await prepareTlockComparison(f, f.services);
  f.setTime((evidence.roundTimeUnix + 1) * 1000);
  for (const capsule of [armor(evidence.round - 1), armor(evidence.round, '00'.repeat(32))]) {
    const changed = { ...evidence, capsule, capsuleHash: keccak256(Buffer.from(capsule)) };
    await assert.rejects(observeTlockComparison({ evidence: changed, ciphertext: hexToBytes(f.bundle.ciphertext) }, f.services), /recipient/);
  }
});

test('tlock preparation rejects changed commitments, past starts and the wrong chain before encryption', async () => {
  const f = await fixture();
  await assert.rejects(prepareTlockComparison({ ...f, journal: { ...f.journal, cipherHash: '0x' + '00'.repeat(32) } }, f.services));
  f.setTime(t1 * 1000);
  await assert.rejects(prepareTlockComparison(f, f.services), /future/);
  f.setTime((t1 - 600) * 1000);
  const wrongSdk = { ...f.services.sdk, mainnetClient: () => ({ options: { disableBeaconVerification: false },
    chain: () => ({ info: async () => ({ ...quicknet, hash: 'wrong' }) }) }) };
  await assert.rejects(prepareTlockComparison(f, { ...f.services, sdk: wrongSdk }), /quicknet/);
});

test('tlock observation rejects forged capsules, malformed payloads and unavailable beacons', async () => {
  const f = await fixture();
  const evidence = await prepareTlockComparison(f, f.services);
  f.setTime((evidence.roundTimeUnix + 1) * 1000);
  const args = { evidence, ciphertext: hexToBytes(f.bundle.ciphertext) };
  await assert.rejects(observeTlockComparison({ ...args, evidence: { ...evidence, capsule: 'changed' } }, f.services));
  await assert.rejects(observeTlockComparison({ ...args, ciphertext: new Uint8Array(50) }, f.services));
  await assert.rejects(observeTlockComparison({ ...args, evidence: { ...evidence, round: 1001 } }, f.services));
  f.setPayload(new Uint8Array(64));
  await assert.rejects(observeTlockComparison(args, f.services), /commitment/);
  f.setPayload(new Uint8Array(63));
  await assert.rejects(observeTlockComparison(args, f.services), /payload/);
  f.setAvailable(false);
  await assert.rejects(observeTlockComparison(args, f.services));
  assert.equal(evidence.status, 'sealed');
  assert.equal(evidence.g1Decision, 'pending');
  assert.equal(keccak256(args.ciphertext), evidence.cipherHash);
});
