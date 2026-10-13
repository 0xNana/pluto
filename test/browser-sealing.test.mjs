import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initBrowserCryptoSync } from '@nillion/covenants-sdk/browser';
import { mpkFromSecret, selectCommittee } from '@nillion/covenants-sdk';
import { toHex } from 'viem';
import { prepareReport } from '../src/shared/report-crypto.mjs';
import { sealLocalReport } from '../packages/client/sealing.mts';

test('FR-201/202 actual SDK browser WASM seals exactly K||reportId and retains nonce only in local recovery', async () => {
  const wasm = await readFile(join(dirname(fileURLToPath(import.meta.resolve('@nillion/covenants-sdk/browser'))), 'wasm-web/cryptomata_core_bg.wasm'));
  const browser = initBrowserCryptoSync(wasm);
  const secrets = [1, 2, 3].map(n => new Uint8Array(32).fill(n));
  const candidates = secrets.map((sk, index) => ({ keyId: BigInt(index + 1), nodeId: BigInt(index + 1), mpk: toHex(mpkFromSecret(sk)), expiresAt: 10000n, stake: 10n, fired: 0n, markup: 0, operator: '0x' + String(index + 1).repeat(40) }));
  const committee = selectCommittee(candidates, { m: 3, k: 2, mode: 'PUBLIC_CONDITION', minStake: 1n, nowUnix: 1000n, pick: 'top' });
  const report = await prepareReport(new TextEncoder().encode('private report fixture'), '0x' + '12'.repeat(20));
  const plan = { committee, t1: 1600n, t2: 5200n, ceilingWei: 5n, registry: '0x' + '34'.repeat(20), hookGasLimit: 250000, retryWindowSecs: 600, maxPlaintextBytes: 96n, maxCiphertextBytes: 690n };
  const sealed = await sealLocalReport(browser, report, ['https://a.example/cipher', 'https://b.example/cipher'], plan);
  const shares = sealed.args.layers.slice(0, 2).map((layer, index) => browser.openLayer(layer, secrets[Number(committee.keys[index].nodeId) - 1], new Uint8Array(Buffer.from(sealed.args.commit.slice(2), 'hex')), 'PUBLIC_CONDITION').share);
  const plaintext = toHex(browser.reconstruct(shares));
  assert.equal(plaintext, report.key + report.reportId.slice(2) + sealed.recovery.nonce.slice(2));
  assert.equal(sealed.args.ttl, 0); assert.equal(sealed.args.layers[0].length, 230);
  assert.equal(Object.hasOwn(sealed.args, 'key'), false);
  await assert.rejects(sealLocalReport(browser, report, ['https://a.example/cipher'], plan));
  await assert.rejects(sealLocalReport(browser, report, ['https://a.example/cipher', 'https://b.example/cipher'], { ...plan, maxPlaintextBytes: 95n }));
});
