import { readFile } from 'node:fs/promises';
import { bytesToHex, createPublicClient, getAddress, hexToBytes, http, keccak256, parseEventLogs } from 'viem';
import { sepolia } from 'viem/chains';
import { triggerMarketAbi } from '@nillion/covenants-sdk';
import { compileContracts } from './lib/contracts.mjs';
import { publicEventMetadata } from '../src/shared/public-output.mjs';

// Read-only diagnostics. This command neither repairs a hook nor grants acceptance.
const print = value => console.log(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
let stage = 'configuration';
try {
  if (![3, 4].includes(process.argv.length) || !process.env.RPC_URL) throw new Error('configuration');
  const records = (await readFile(process.argv[2], 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const entry = records.at(-1);
  if (entry?.chainId !== 11155111 || entry.state !== 'bound' || !entry.commit || !entry.parentReportId) throw new Error('journal');
  const market = getAddress(entry.market);
  const registry = getAddress(entry.registry);
  const registryAbi = (await compileContracts()).DisclosureRegistry.abi;
  const id = BigInt(entry.triggerId);
  const pub = createPublicClient({ chain: sepolia, transport: http(process.env.RPC_URL, { timeout: 20000, retryCount: 0 }) });
  stage = 'chain check';
  if (await pub.getChainId() !== 11155111) throw new Error('chain');
  const latest = await pub.getBlockNumber();
  const fromBlock = BigInt(entry.postBlock);
  if (fromBlock > latest) throw new Error('block range');
  stage = 'bounded market event scan';
  const watched = [];
  if (process.argv[3]) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(process.argv[3])) throw new Error('receipt hash');
    const receipt = await pub.getTransactionReceipt({ hash: process.argv[3] });
    if (receipt.blockNumber < fromBlock || receipt.blockNumber > latest) throw new Error('receipt block');
    watched.push(...parseEventLogs({ abi: triggerMarketAbi, logs: receipt.logs, strict: true }).filter(log =>
      !log.removed && getAddress(log.address) === market && log.args.triggerId === id));
  } else {
    for (let from = fromBlock; from <= latest; from += 100n) {
      const to = from + 99n > latest ? latest : from + 99n;
      const logs = await pub.getLogs({ address: market, fromBlock: from, toBlock: to });
      watched.push(...parseEventLogs({ abi: triggerMarketAbi, logs, strict: true }).filter(log =>
        !log.removed && log.args.triggerId === id));
    }
  }
  print({ triggerId: id, fromBlock, toBlock: latest,
    events: watched.filter(log => ['TriggerResolved', 'HookInvoked', 'RefundIssued', 'RefundOwed', 'RefundClaimed'].includes(log.eventName))
      .map(publicEventMetadata) });
  const reveals = watched.filter(log => log.eventName === 'TriggerResolved');
  print({ revealCount: reveals.length });
  for (const reveal of reveals) {
    stage = 'reveal receipt';
    const payload = hexToBytes(reveal.args.plaintext);
    const receipt = await pub.getTransactionReceipt({ hash: reveal.transactionHash });
    const receiptEvents = parseEventLogs({ abi: triggerMarketAbi, logs: receipt.logs, strict: true }).filter(log =>
      getAddress(log.address) === market && log.args.triggerId === id);
    print({ transactionHash: reveal.transactionHash, receiptStatus: receipt.status,
      plaintextBytes: payload.length, observedCommit: keccak256(payload), expectedCommit: entry.commit,
      commitmentMatchesJournal: keccak256(payload).toLowerCase() === entry.commit.toLowerCase(),
      payloadReportId: payload.length >= 64 ? bytesToHex(payload.subarray(32, 64)) : undefined,
      journalReportId: entry.reportId, parentReportId: entry.parentReportId,
      callbackEvents: receiptEvents.filter(log => log.eventName === 'HookInvoked').map(publicEventMetadata),
      registryEvents: parseEventLogs({ abi: registryAbi, strict: true,
        logs: receipt.logs.filter(log => getAddress(log.address) === registry) }).map(publicEventMetadata) });
    stage = 'callback trace';
    try {
      const trace = await pub.request({ method: 'debug_traceTransaction',
        params: [reveal.transactionHash, { tracer: 'callTracer' }] });
      const calls = [];
      const walk = node => {
        if (typeof node?.to === 'string' && node.to.toLowerCase() === registry.toLowerCase()) {
          calls.push({ type: node.type, from: node.from, gas: node.gas, gasUsed: node.gasUsed,
            functionSelector: node.input?.slice(0, 10),
            inputBytes: typeof node.input === 'string' ? (node.input.length - 2) / 2 : undefined,
            error: node.error ? 'Callback failed; raw trace error withheld' : undefined,
            outputFirst4Bytes: node.output?.slice(0, 10) });
        }
        for (const child of node?.calls ?? []) walk(child);
      };
      walk(trace);
      print({ transactionHash: reveal.transactionHash, registryCalls: calls });
    } catch (error) {
      print({ transactionHash: reveal.transactionHash, traceStatus: 'unavailable',
        code: typeof error?.code === 'number' ? error.code : undefined });
    }
  }
} catch (error) {
  print({ status: 'failed', stage, detail: 'Diagnostic failed; endpoint and exception details withheld',
    code: typeof error?.code === 'number' ? error.code : undefined });
  process.exitCode = 1;
}
