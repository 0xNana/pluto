import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hexToBytes } from 'viem';
import { decryptReport } from '../src/shared/report-crypto.mjs';
import { openJournal, readJournal } from '../scripts/lib/researcher-files.mjs';
import { runResearcher } from '../scripts/researcher.mjs';

const researcher = '0x1111111111111111111111111111111111111111';

test('offline CLI prepares private recoverable files and public output without credentials or overwrite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pluto-cli-'));
  try {
    const input = join(directory, 'report.txt');
    const recovery = join(directory, 'recovery.json');
    const cipher = join(directory, 'report.bin');
    const plaintext = 'Synthetic CLI report with sensitive local bytes';
    await writeFile(input, plaintext);
    const args = ['prepare', '--report', input, '--researcher', researcher,
      '--out', recovery, '--ciphertext', cipher];
    let stdout = '';
    await runResearcher(args, text => { stdout += text; });
    const bundle = JSON.parse(await readFile(recovery, 'utf8'));
    const output = JSON.parse(stdout);
    assert.equal(output.reportId, bundle.reportId);
    assert.ok(!stdout.includes(bundle.key.slice(2)) && !stdout.includes(plaintext));
    assert.equal((await stat(recovery)).mode & 0o777, 0o600);
    assert.equal((await stat(cipher)).mode & 0o777, 0o600);
    assert.equal(new TextDecoder().decode(await decryptReport(new Uint8Array(await readFile(cipher)), hexToBytes(bundle.key))), plaintext);
    await assert.rejects(runResearcher(args), { code: 'EEXIST' });
    assert.deepEqual(JSON.parse(await readFile(recovery, 'utf8')), bundle);
    await rm(recovery);
    // Reserving the recovery output succeeds, but the existing ciphertext refuses the pair.
    await assert.rejects(runResearcher(args));
    await assert.rejects(stat(recovery), { code: 'ENOENT' });
    const secret = 'secret-flag-value';
    await assert.rejects(runResearcher(['post', '--author-key', secret]), error =>
      !error.message.includes(secret) && error.message.includes('Unsupported command options'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('append-only journal recovers completed snapshots and refuses secret fields or public file modes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pluto-journal-'));
  const path = join(directory, 'state.jsonl');
  const state = { version: 1, chainId: 11155111, registry: researcher, market: researcher, researcher,
    reportId: '0x' + '01'.repeat(32), cipherHash: '0x' + '02'.repeat(32), keyCommit: '0x' + '03'.repeat(32),
    commit: '0x' + '04'.repeat(32), sealNonce: '0x' + '05'.repeat(32), state: 'submitted',
    window: { t1: 1600n, t2: 5200n }, transactions: [{ call: 'postTrigger', hash: '0x' + '06'.repeat(32) }] };
  try {
    const file = await openJournal(path);
    await file.save(state);
    await file.close();
    await writeFile(path, '{"partial":', { flag: 'a' });
    assert.equal((await readJournal(path)).state, 'submitted');
    const resumed = await openJournal(path, { resume: true });
    await resumed.save({ ...state, state: 'posted', triggerId: 0n });
    await resumed.close();
    assert.equal((await readJournal(path)).triggerId, '0');
    await assert.rejects(openJournal(path), { code: 'EEXIST' });
    await writeFile(path, JSON.stringify({ ...state, window: { t1: '1600', t2: '5200' }, key: 'secret' }) + '\n');
    await assert.rejects(readJournal(path), /journal/);
    await writeFile(path, JSON.stringify({ ...state, window: { t1: '1600', t2: '5200' },
      transactions: [{ call: 'postTrigger', hash: '0x' + '06'.repeat(32), key: 'secret' }] }) + '\n');
    await assert.rejects(readJournal(path), /journal/);
    await chmod(path, 0o644);
    await assert.rejects(openJournal(path, { resume: true }), /private/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('journal corruption cannot silently roll recovery back to an older valid snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pluto-corrupt-journal-'));
  const path = join(directory, 'state.jsonl');
  const state = { version: 1, chainId: 11155111, registry: researcher, market: researcher, researcher,
    reportId: '0x' + '01'.repeat(32), cipherHash: '0x' + '02'.repeat(32), keyCommit: '0x' + '03'.repeat(32),
    commit: '0x' + '04'.repeat(32), sealNonce: '0x' + '05'.repeat(32), state: 'submitted',
    window: { t1: '1600', t2: '5200' }, transactions: [{ call: 'postTrigger', hash: '0x' + '06'.repeat(32) }] };
  try {
    for (const body of [JSON.stringify(state) + '\n{broken}\n',
      '{broken}\n' + JSON.stringify(state) + '\n',
      JSON.stringify({ ...state, key: 'private' }) + '\n' + JSON.stringify(state) + '\n']) {
      await writeFile(path, body, { mode: 0o600 });
      await assert.rejects(readJournal(path), /journal/i);
    }
    await writeFile(path, JSON.stringify(state) + '\n{"interrupted":');
    const resumed = await openJournal(path, { resume: true });
    await resumed.save({ ...state, state: 'posted', triggerId: '0' });
    await resumed.close();
    assert.ok(!(await readFile(path, 'utf8')).includes('interrupted'));
    assert.equal((await readJournal(path)).state, 'posted');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
