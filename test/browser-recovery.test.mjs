import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { privateKeyToAccount } from 'viem/accounts';
import { hexToBytes, toHex } from 'viem';
import { initBrowserCryptoSync } from '@nillion/covenants-sdk/browser';
import { mpkFromSecret, selectCommittee } from '@nillion/covenants-sdk';
import { prepareReport } from '../src/shared/report-crypto.mjs';
import { sealLocalReport } from '../packages/client/sealing.mts';
import { newBrowserRecovery, validateBrowserRecovery, exportBrowserRecovery, importBrowserRecovery, recoveryContext, appendRecoveryEvent, mergeBrowserRecovery, claimRecoveryEvent } from '../packages/client/recovery.mts';
import { decodeWire, encodeWire } from '../packages/client/wire.mts';

test('FR-105 private browser recovery authenticates author/report/seal and roundtrips full SDK data without changing commitments', async () => {
  const key = '0x' + '12'.repeat(32), author = privateKeyToAccount(key);
  const report = await prepareReport(new TextEncoder().encode('private recovery fixture'), author.address);
  const prepared = await newBrowserRecovery(report, key);
  assert.equal((await importBrowserRecovery(exportBrowserRecovery(prepared))).report.reportId, report.reportId);
  const wasm = await readFile(new URL('../node_modules/@nillion/covenants-sdk/dist/wasm-web/cryptomata_core_bg.wasm', import.meta.url));
  const browser = initBrowserCryptoSync(wasm);
  const candidates = [1, 2, 3].map(n => ({ keyId: BigInt(n), nodeId: BigInt(n), mpk: toHex(mpkFromSecret(new Uint8Array(32).fill(n))), expiresAt: 10000n, stake: 10n, fired: 0n, markup: 0, operator: toHex(BigInt(n), { size: 20 }) }));
  const registry = '0x' + '34'.repeat(20), market = '0x' + '56'.repeat(20);
  const sealed = await sealLocalReport(browser, report, ['https://a.example/report', 'https://b.example/report'], {
    committee: selectCommittee(candidates, { m: 3, k: 2, mode: 'PUBLIC_CONDITION', minStake: 1n, nowUnix: 1000n }),
    registry, t1: 1600n, t2: 5200n, ceilingWei: 5n, hookGasLimit: 250000, retryWindowSecs: 600, maxPlaintextBytes: 96n, maxCiphertextBytes: 690n,
  });
  const recovery = await validateBrowserRecovery({ ...prepared, sealing: { registry, market, cipherUris: sealed.recovery.cipherUris, nonce: sealed.recovery.nonce, args: encodeWire(sealed.args) } });
  const imported = await importBrowserRecovery(exportBrowserRecovery(recovery));
  assert.equal(imported.authorKey, key); assert.equal(recoveryContext(imported), recoveryContext(recovery));
  const args = decodeWire(imported.sealing.args);
  assert.equal(args.t1, 1600n); assert.ok(args.layers[0] instanceof Uint8Array);
  const shares = args.layers.slice(0, 2).map((layer, i) => browser.openLayer(layer, new Uint8Array(32).fill(Number(args.keys[i].nodeId)), hexToBytes(args.commit), 'PUBLIC_CONDITION').share);
  assert.equal(toHex(browser.reconstruct(shares)), report.key + report.reportId.slice(2) + imported.sealing.nonce.slice(2));
  for (const bad of [
    { ...recovery, authorKey: '0x' + '13'.repeat(32) },
    { ...recovery, report: { ...report, key: '0x' + '00'.repeat(32) } },
    { ...recovery, chainId: 1 }, { ...recovery, injected: true },
    { ...recovery, sealing: { ...recovery.sealing, nonce: '0x' + '00'.repeat(32) } },
    { ...recovery, sealing: { ...recovery.sealing, registry: market } },
    { ...recovery, sealing: { ...recovery.sealing, args: encodeWire({ ...args, ttl: 1 }) } },
    { ...recovery, sealing: { ...recovery.sealing, args: encodeWire({ ...args, t1: 1601n }) } },
    { ...recovery, sealing: { ...recovery.sealing, args: encodeWire({ ...args, layers: [] }) } },
    { ...recovery, sealing: { ...recovery.sealing, cipherUris: ['https://a.example/1', 'https://a.example/2'] } },
  ]) await assert.rejects(validateBrowserRecovery(bad));
  await assert.rejects(importBrowserRecovery(' '.repeat(2_400_001)), /too large/);
  // CLI and earlier browser formats are deliberately not interpreted as this
  // version: they lack the exact sealed terms and complete event history.
  await assert.rejects(importBrowserRecovery(JSON.stringify({ ...sealed.recovery, authorKey: key })), /schema/);
  let journal = appendRecoveryEvent(recovery, 'register');
  assert.throws(() => appendRecoveryEvent(journal, 'register'), /unresolved/i);
  assert.throws(() => appendRecoveryEvent(journal, 'bind', toHex(1n, { size: 32 })), /matching attempt/);
  journal = appendRecoveryEvent(journal, 'register', toHex(1n, { size: 32 }));
  journal = appendRecoveryEvent(journal, 'postTrigger');
  journal = appendRecoveryEvent(journal, 'postTrigger', toHex(2n, { size: 32 }));
  const staleTab = journal;
  journal = appendRecoveryEvent(journal, 'bind');
  journal = appendRecoveryEvent(journal, 'bind', toHex(3n, { size: 32 }));
  // The receipt may still be pending. A second tab must not claim another
  // attempt after inspecting its obsolete post-only history.
  assert.throws(() => claimRecoveryEvent(staleTab, journal, 'bind'), /history changed/);
  const claimed = claimRecoveryEvent(journal, journal, 'bind');
  assert.throws(() => claimRecoveryEvent(journal, claimed, 'bind', toHex(4n, { size: 32 })), /history changed/);
  assert.equal(claimRecoveryEvent(claimed, claimed, 'bind', toHex(4n, { size: 32 })).history.length, 8);
  assert.equal(journal.history.length, 6); assert.equal(recovery.history.length, 0);
  assert.deepEqual((await importBrowserRecovery(exportBrowserRecovery(journal))).history, journal.history);
  assert.equal(mergeBrowserRecovery(recovery, journal).history.length, 6);
  assert.equal(mergeBrowserRecovery(journal, recovery).history.length, 6);
  assert.throws(() => mergeBrowserRecovery({ ...journal, history: [{ ...journal.history[0], action: 'bind' }, ...journal.history.slice(1)] }, journal), /conflict/);
  assert.throws(() => mergeBrowserRecovery(prepared, journal), /context/);
  await assert.rejects(validateBrowserRecovery({ ...journal, history: journal.history.slice(1) }));
  await assert.rejects(validateBrowserRecovery({ ...journal, history: [...journal.history, { ...journal.history[1], sequence: 6 }] }));
  assert.throws(() => appendRecoveryEvent(journal, 'postTrigger'), /order/);
  const fundingId = toHex(99n, { size: 32 });
  let funded = appendRecoveryEvent(recovery, 'sponsorRequest');
  funded = appendRecoveryEvent(funded, 'sponsorRequest', fundingId);
  assert.throws(() => appendRecoveryEvent(funded, 'register'), /order/);
  assert.throws(() => appendRecoveryEvent(funded, 'sponsorRequest'), /order/);
  assert.throws(() => claimRecoveryEvent(recovery, funded, 'register'), /history changed/);
  funded = appendRecoveryEvent(funded, 'sponsorWithdraw');
  assert.throws(() => appendRecoveryEvent(funded, 'sponsorWithdraw', toHex(98n, { size: 32 })), /matching/);
  funded = appendRecoveryEvent(funded, 'sponsorWithdraw', fundingId);
  assert.deepEqual((await importBrowserRecovery(exportBrowserRecovery(funded))).history, funded.history);
  assert.equal(appendRecoveryEvent(funded, 'register').history.at(-1).state, 'unknown');
  assert.throws(() => mergeBrowserRecovery(prepared, funded), /context/);
});
