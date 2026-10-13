import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSpikeCommand } from '../scripts/spike-sepolia.mjs';

test('P-03/P-04 command saves sanitized early RPC failure, mode and pending decision before any wallet call', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pluto-spike-'));
  try {
    for (const mode of ['hello', 'sponsored']) {
      const out = join(directory, `${mode}.json`);
      const output = [];
      const code = await runSpikeCommand([mode, '--out', out], { payerKey: `0x${'05'.repeat(32)}`,
        expectedMarket: '0x1111111111111111111111111111111111111111',
        client: () => ({ getChainId: async () => { throw Object.assign(new Error('https://rpc.invalid/secret-token'), { code: 'EAI_AGAIN' }); } }),
        print: text => output.push(text), diagnostic: text => output.push(text) });
      assert.equal(code, 1);
      const saved = JSON.parse(await readFile(out, 'utf8'));
      assert.equal(saved.mode, mode);
      assert.equal(saved.failedStage, 'deployment and live feasibility');
      assert.deepEqual(saved.transactions, []);
      assert.deepEqual(saved.failure.codes, ['EAI_AGAIN']);
      if (mode === 'sponsored') assert.equal(saved.fundingDecision.decision, 'pending');
      assert.equal((await stat(out)).mode & 0o777, 0o600);
      assert.ok(!output.join('\n').includes('secret-token'));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('spike refuses an existing output and rejects unknown options before creating a client', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pluto-spike-'));
  const out = join(directory, 'keep.json');
  const options = { client: () => { throw new Error('should not run'); }, print: () => {}, diagnostic: () => {} };
  try {
    await writeFile(out, 'keep');
    assert.equal(await runSpikeCommand(['sponsored', '--out', out], options), 1);
    assert.equal(await readFile(out, 'utf8'), 'keep');
    assert.equal(await runSpikeCommand(['hello', '--private-key', 'secret'], options), 1);
    assert.equal(await runSpikeCommand(['--help'], options), 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
