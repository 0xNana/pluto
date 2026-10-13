import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hexToBytes, padHex, toHex } from 'viem';
import { compileContracts } from '../scripts/lib/contracts.mjs';
import { runSettlement } from '../packages/cli/settlement.mjs';

test('FR-505 local SDK passthrough validates deployment and binding, persists ambiguity, and uses registry acceptance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pluto-settlement-'));
  const market = '0x' + '11'.repeat(20), registry = '0x' + '22'.repeat(20), reportId = '0x' + '33'.repeat(32);
  const artifact = (await compileContracts()).DisclosureRegistry, runtime = hexToBytes(artifact.runtimeBytecode);
  for (const reference of Object.values(artifact.immutableReferences).flat()) runtime.set(hexToBytes(padHex(market, { size: 32 })), reference.start);
  let chainId = 11155111, bound = true, disclosed = false, launches = 0;
  const env = { RPC_URL: 'https://fixture.example', EXPECTED_MARKET: market, AUTHOR_KEY: '0x' + '44'.repeat(32) };
  const pub = { getChainId: async () => chainId, getBytecode: async () => toHex(runtime), readContract: async request => {
    if (['market', 'triggerMarket'].includes(request.functionName)) return market;
    if (request.functionName === 'getActiveKeys') return [{ nodeId: 1n, keyId: 1n }];
    if (request.functionName === 'retired') return false;
    if (request.functionName === 'bindings') return [reportId, bound];
    if (request.functionName === 'statusOf') return { researcher: market, disclosed };
    if (request.functionName === 'postingParties') return [market, registry];
    if (request.functionName === 'hookMeta') return [registry];
    return registry;
  } };
  const journal = join(directory, 'attempt.jsonl');
  const args = ['retry-hook', '--id', '0', '--registry', registry, '--report-id', reportId, '--journal', journal];
  const services = { pub, env, compile: async () => ({ DisclosureRegistry: artifact }), invoke: async (command, id) => {
    launches++; assert.equal(command, 'retry'); assert.equal(id, '0');
    assert.equal(JSON.parse((await readFile(journal, 'utf8')).trim()).state, 'unknown');
    return { exitCode: 0, hashes: [] }; // SDK acknowledgement alone is insufficient.
  } };
  try {
    assert.match((await runSettlement(['--help'])).help, /Never run on a Pluto server/);
    for (const invalid of [['reveal'], [...args, '--author-key', 'secret'], [...args, '--id', '-1']]) await assert.rejects(runSettlement(invalid, services));
    chainId = 1; await assert.rejects(runSettlement(args, services), /Sepolia/); chainId = 11155111;
    bound = false; await assert.rejects(runSettlement(args, services), /bound/); bound = true;
    assert.equal(launches, 0);
    assert.equal((await runSettlement(args, services)).state, 'acceptance-not-confirmed');
    await assert.rejects(runSettlement(args, services), { code: 'EEXIST' }); assert.equal(launches, 1);
    services.invoke = async command => { assert.equal(command, 'reconstruct'); disclosed = true; return { exitCode: 0, hashes: ['0x' + '55'.repeat(32)] }; };
    assert.equal((await runSettlement(['reconstruct', ...args.slice(1, -1), join(directory, 'second.jsonl')], services)).state, 'registry-disclosed');
    disclosed = false; services.invoke = async () => { throw new Error('ambiguous child failure'); };
    const failed = join(directory, 'failed.jsonl');
    await assert.rejects(runSettlement(['reconstruct', ...args.slice(1, -1), failed], services), /ambiguous/);
    assert.equal(JSON.parse((await readFile(failed, 'utf8')).trim()).state, 'unknown');
  } finally { await rm(directory, { recursive: true }); }
});
