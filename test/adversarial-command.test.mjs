import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAdversarialCommand } from '../scripts/live-adversarial-sepolia.mjs';

test('adversarial posting rejects wrong chain before reading source secrets or creating wallets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pluto-adversarial-'));
  try {
    const out = join(dir, 'proof.json');
    const code = await runAdversarialCommand(['--source', join(dir, 'does-not-exist'), '--out', out], {
      client: () => ({ getChainId: async () => 1 }), diagnostic: () => {},
      walletFactory: () => { throw new Error('Must not create a wallet'); },
    });
    assert.equal(code, 1);
    const evidence = JSON.parse(await readFile(out, 'utf8'));
    assert.match(evidence.failure.detail, /Sepolia/);
    assert.deepEqual(evidence.cases, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('adversarial tool refuses unknown options and existing evidence without changing either', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pluto-adversarial-existing-'));
  try {
    const out = join(dir, 'keep.json');
    await writeFile(out, 'keep');
    const options = { diagnostic: () => {}, client: () => { throw new Error('Must not create client'); } };
    assert.equal(await runAdversarialCommand(['--source', 'unused', '--out', out], options), 1);
    assert.equal(await readFile(out, 'utf8'), 'keep');
    assert.equal(await runAdversarialCommand(['--private-key', 'secret'], options), 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invalid scenario selectors fail before a client or wallet is created', async () => {
  let touched = false;
  const options = { diagnostic: () => {}, client: () => { touched = true; throw new Error('Unexpected client'); } };
  for (const selection of [['unknown'], ['unbound', 'unbound']]) {
    const argv = ['--source', 'unused', '--out', 'unused', ...selection.flatMap(name => ['--only', name])];
    assert.equal(await runAdversarialCommand(argv, options), 1);
  }
  assert.equal(touched, false);
});
