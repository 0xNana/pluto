import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConditionRecord } from '@nillion/covenants-sdk/browser';
import { compileDisclosureWindow } from '../src/shared/disclosure.mjs';
import { expiryProbeWindow, runExpiryProbe } from '../scripts/live-expiry-sepolia.mjs';

test('controlled expiry uses an SDK public one-second window while product minimum stays enforced', () => {
  const window = expiryProbeWindow(1000n);
  const decoded = parseConditionRecord(window.conditionRecord);
  assert.equal(window.t1, 1900n);
  assert.equal(window.t2, 1901n);
  assert.equal(window.ttl, 0);
  assert.equal(decoded.t1, window.t1);
  assert.equal(decoded.t2, window.t2);
  assert.throws(() => compileDisclosureWindow({ nowUnix: 1000n, ...window }), /minimum width/);
  assert.throws(() => expiryProbeWindow((1n << 64n) - 1n), /uint64/);
  assert.throws(() => expiryProbeWindow(-1n), /uint64/);
});

test('expiry probe stops before wallets or recovery files on wrong chain and keeps failures sanitized', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pluto-expiry-'));
  try {
    const out = join(directory, 'proof.json');
    const output = [];
    const code = await runExpiryProbe(['--out', out, '--dir', join(directory, 'private'),
      '--registry', '0x1111111111111111111111111111111111111111'], {
      client: () => ({ getChainId: async () => 1 }),
      walletFactory: () => { throw new Error('Wallet must not be created'); },
      print: text => output.push(text), diagnostic: text => output.push(text),
    });
    assert.equal(code, 1);
    const saved = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(saved.status, 'failed');
    assert.deepEqual(saved.transactions, []);
    assert.match(saved.failure.detail, /Sepolia/);
    assert.ok(!output.join('\n').includes('Wallet must not'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('expiry probe cannot overwrite a recovery file passed as its evidence output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pluto-expiry-existing-'));
  try {
    const out = join(directory, 'recovery.json');
    await writeFile(out, 'private recovery data');
    const code = await runExpiryProbe(['--out', out, '--dir', directory,
      '--registry', '0x1111111111111111111111111111111111111111'], {
      client: () => { throw new Error('Client must not be created'); }, diagnostic: () => {},
    });
    assert.equal(code, 1);
    assert.equal(await readFile(out, 'utf8'), 'private recovery data');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
