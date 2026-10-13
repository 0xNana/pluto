import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runProbeCommand } from '../scripts/probe-sepolia.mjs';

test('P-02 command records partial SDK evidence on RPC failure and redacts endpoint credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pluto-probe-'));
  const path = join(directory, 'probe.json');
  const output = [];
  const diagnostics = [];
  try {
    const code = await runProbeCommand(['--out', path], {
      expectedMarket: '0x1111111111111111111111111111111111111111',
      client: () => ({ getChainId: async () => {
        throw Object.assign(new Error('RPC https://user:secret@rpc.example calldata'), { code: 'EAI_AGAIN' });
      } }),
      print: line => output.push(line), diagnostic: line => diagnostics.push(line),
    });
    assert.equal(code, 1);
    const evidence = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(evidence.status, 'failed');
    assert.equal(evidence.checks.sdk, 'passed');
    assert.equal(evidence.failedStage, 'deployment, live parameters and committee');
    assert.deepEqual(evidence.failure.codes, ['EAI_AGAIN']);
    assert.doesNotMatch(JSON.stringify([evidence, output, diagnostics]), /secret|user:|rpc\.example/);
    assert.equal(JSON.parse(output[0]).evidenceFile, path);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('P-02 command rejects secret flags and malformed transaction hashes before making RPC calls', async () => {
  for (const args of [['--author-key', 'do-not-print-secret'], ['--event-tx', 'do-not-print-secret']]) {
    const lines = [];
    const code = await runProbeCommand(args, { client: () => { throw new Error('unexpected RPC'); },
      print: line => lines.push(line), diagnostic: line => lines.push(line) });
    assert.equal(code, 1);
    assert.doesNotMatch(lines.join('\n'), /do-not-print-secret|unexpected RPC/);
  }
});

test('P-02 evidence output refuses existing files before RPC access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pluto-probe-existing-'));
  const path = join(directory, 'existing.json');
  try {
    await writeFile(path, 'preserve previous evidence');
    const output = [];
    const code = await runProbeCommand(['--out', path], { client: () => { throw new Error('unexpected RPC'); },
      print: line => output.push(line), diagnostic: line => output.push(line) });
    assert.equal(code, 1);
    assert.equal(await readFile(path, 'utf8'), 'preserve previous evidence');
    assert.match(output.join('\n'), /already exists/);
    assert.doesNotMatch(output.join('\n'), /unexpected RPC/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
