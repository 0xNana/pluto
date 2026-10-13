import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareReport } from '../src/shared/report-crypto.mjs';
import { signNotice } from '../packages/client/notice.mts';
import { inspectReport, verifyPublicReport } from '../packages/verifier/verify.mts';
import { privateKeyToAccount } from 'viem/accounts';
import { hexToBytes, padHex } from 'viem';
import { compileContracts } from '../scripts/lib/contracts.mjs';

test('FR-601/602 verifier requires authenticated registry acceptance, binding and commitments before browser decryption', async () => {
  const author = privateKeyToAccount('0x' + '12'.repeat(32)), registry = '0x' + '34'.repeat(20), market = '0x' + '56'.repeat(20);
  const artifact = (await compileContracts()).DisclosureRegistry;
  const code = hexToBytes(artifact.runtimeBytecode);
  for (const ref of Object.values(artifact.immutableReferences).flat()) code.set(hexToBytes(padHex(market, { size: 32 })), ref.start);
  const blockHash = '0x' + 'ab'.repeat(32);
  const content = new TextEncoder().encode('Private fixture report'); const bundle = await prepareReport(content, author.address);
  const notice = await signNotice({ version: 1, chainId: 11155111, registry, reportId: bundle.reportId, triggerId: '0',
    cipherHash: bundle.cipherHash, keyCommit: bundle.keyCommit, cipherUris: ['https://a.example/report', 'https://b.example/report'],
    researcher: author.address, window: { t1: '1600', t2: '5200' }, verifyUrl: 'https://pluto.example/verify' }, author);
  const record = { researcher: author.address, cipherHash: bundle.cipherHash, keyCommit: bundle.keyCommit,
    t1: 1600n, t2: 5200n, registeredAt: 1000n, bindTime: 1100n, lastTriggerId: 0n, disclosed: true };
  let logs = [{ address: registry, removed: false, blockNumber: 20n, blockHash, args: { reportId: bundle.reportId, triggerId: 0n, key: bundle.key } }];
  const pub = { getChainId: async () => 11155111, getBytecode: async () => '0x' + Buffer.from(code).toString('hex'), getBlock: async () => ({ number: 20n, hash: blockHash, timestamp: 1648n }),
    getContractEvents: async () => logs, readContract: async ({ functionName }) => {
      if (functionName === 'market') return market;
      if (functionName === 'statusOf') return record;
      if (functionName === 'bindings') return [bundle.reportId, true];
      if (functionName === 'postingParties') return [author.address, author.address];
      if (functionName === 'hookMeta') return [registry];
      throw new Error('Unexpected read');
    } };
  const args = { pub, notice, market, artifact, registryAbi: artifact.abi, marketAbi: [], fromBlock: 1n };
  assert.equal((await inspectReport(args)).state, 'disclosed');
  const verified = await verifyPublicReport(args, hexToBytes(bundle.ciphertext));
  assert.deepEqual(verified.plaintext, content); assert.equal(verified.delaySecs, 48n);
  logs = []; await assert.rejects(verifyPublicReport(args, hexToBytes(bundle.ciphertext)), /acceptance/);
  record.disclosed = false; record.bindTime = 0n;
  assert.equal((await inspectReport(args)).state, 'registered');
});
