import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runTlockCommand } from '../scripts/compare-tlock.mjs';

test('comparison CLI saves dependency failure without keys or endpoint details and refuses overwrite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pluto-tlock-cli-'));
  try {
    const out = join(directory, 'evidence.json');
    const args = ['seal', '--bundle', 'unused', '--journal', 'unused', '--out', out];
    let output = '';
    const services = { print: message => { output += message; }, loadSdk: async () => {
      throw new Error('secret-key-and-https://credential@private-rpc');
    } };
    assert.equal(await runTlockCommand(args, services), 1);
    const evidence = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(evidence.status, 'failed');
    assert.equal(evidence.g1Decision, 'pending');
    assert.ok(!JSON.stringify(evidence).includes('credential') && !output.includes('secret-key'));
    assert.equal((await stat(out)).mode & 0o777, 0o600);
    assert.equal(await runTlockCommand(args, services), 1);
    assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), evidence);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('comparison CLI validates flags without echoing supplied secret values', async () => {
  let output = '';
  assert.equal(await runTlockCommand(['seal', '--key', 'sensitive-value'], { print: value => { output += value; } }), 1);
  assert.ok(!output.includes('sensitive-value'));
  assert.equal(await runTlockCommand(['--help'], { print: value => { output += value; } }), 0);
  assert.ok(output.includes('--bundle'));
});
