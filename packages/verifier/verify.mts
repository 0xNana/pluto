import { getAddress, hexToBytes, keccak256, zeroAddress, type Abi, type Hex, type PublicClient } from 'viem';
import { hex, object, verifyNotice } from '../client/notice.mts';
import { decryptReport } from '../../src/shared/report-crypto.mjs';
import { verifyHookDeployment } from '../../src/chain/registry-verification.mjs';
import type { RegistryArtifact } from '../client/deployment.mts';

export interface ReportRead { pub: PublicClient; notice: unknown; market: Hex; registryAbi: Abi; marketAbi: Abi; fromBlock: bigint; artifact: RegistryArtifact }
function same(a: unknown, b: Hex) { return typeof a === 'string' && getAddress(a) === getAddress(b); }
function status(value: unknown) {
  if (!value || typeof value !== 'object') throw new Error('Invalid registry status');
  const record = value as Record<string, unknown>;
  for (const name of ['t1', 't2', 'registeredAt', 'bindTime', 'lastTriggerId']) if (typeof record[name] !== 'bigint') throw new Error('Invalid registry status');
  if (typeof record.disclosed !== 'boolean') throw new Error('Invalid registry status');
  return record as Record<string, unknown> & { t1: bigint; t2: bigint; registeredAt: bigint; bindTime: bigint; lastTriggerId: bigint; disclosed: boolean };
}
export async function inspectReport(options: ReportRead) {
  const { pub, registryAbi, marketAbi, market } = options;
  const notice = await verifyNotice(options.notice);
  if (await pub.getChainId() !== notice.chainId) throw new Error('Notice chain mismatch');
  await verifyHookDeployment(pub, notice.registry, options.artifact, market);
  const head = await pub.getBlock(); if (head.number === null || options.fromBlock < 0n || options.fromBlock > head.number) throw new Error('Invalid archive scan bounds');
  const record = status(await pub.readContract({ address: notice.registry, abi: registryAbi, functionName: 'statusOf', args: [notice.reportId] }));
  if (same(record.researcher, zeroAddress)) throw new Error('Report not registered');
  if (!same(record.researcher, notice.researcher) || record.cipherHash !== notice.cipherHash || record.keyCommit !== notice.keyCommit
      || record.t1 !== BigInt(notice.window.t1) || record.t2 !== BigInt(notice.window.t2)) throw new Error('Notice and registry differ');
  if (!same(await pub.readContract({ address: notice.registry, abi: registryAbi, functionName: 'market' }), market)) throw new Error('Registry market mismatch');
  let bound = false;
  if (record.bindTime > 0n) {
    const triggerId = BigInt(notice.triggerId);
    const binding = await pub.readContract({ address: notice.registry, abi: registryAbi, functionName: 'bindings', args: [triggerId] });
    const parties = await pub.readContract({ address: market, abi: marketAbi, functionName: 'postingParties', args: [triggerId] });
    const hook = await pub.readContract({ address: market, abi: marketAbi, functionName: 'hookMeta', args: [triggerId] });
    if (!Array.isArray(binding) || binding[1] !== true || binding[0] !== notice.reportId || !Array.isArray(parties)
        || !same(parties[0], notice.researcher) || !Array.isArray(hook) || !same(hook[0], notice.registry)) throw new Error('Authenticated binding unavailable');
    bound = true;
  }
  const state = !bound ? 'registered' : record.disclosed ? 'disclosed' : head.timestamp > record.t2 ? 'expired' : head.timestamp >= record.t1 ? 'awaiting-shares' : 'bound';
  return { notice, record, state, block: head.number, timestamp: head.timestamp };
}
// This function belongs in the browser only: its RPC response and plaintext
// never pass through the portal, planner, keeper or a reporting endpoint.
export async function verifyPublicReport(options: ReportRead, ciphertext: Uint8Array) {
  const observed = await inspectReport(options), { notice, record } = observed;
  if (observed.state !== 'disclosed' || keccak256(ciphertext) !== notice.cipherHash) throw new Error('Authenticated disclosure or ciphertext unavailable');
  const logs = await options.pub.getContractEvents({ address: notice.registry, abi: options.registryAbi, eventName: 'Disclosed',
    args: { reportId: notice.reportId }, fromBlock: options.fromBlock, toBlock: observed.block, strict: true });
  if (logs.length !== 1) throw new Error('Registry acceptance event unavailable or ambiguous');
  const log = logs[0];
  const raw = object((log as unknown as { args: unknown }).args);
  if (typeof raw.triggerId !== 'bigint') throw new Error('Registry acceptance event malformed');
  const args = { reportId: hex(raw.reportId, 32), triggerId: raw.triggerId, key: hex(raw.key, 32) };
  if (!same(log.address, notice.registry) || log.removed || log.blockNumber === null || log.blockNumber < options.fromBlock || log.blockNumber > observed.block
      || args.reportId !== notice.reportId || keccak256(args.key) !== record.keyCommit) throw new Error('Registry acceptance context mismatch');
  const acceptedBinding = await options.pub.readContract({ address: notice.registry, abi: options.registryAbi, functionName: 'bindings', args: [args.triggerId] });
  if (!Array.isArray(acceptedBinding) || acceptedBinding[1] !== true || acceptedBinding[0] !== notice.reportId) throw new Error('Disclosure trigger is not bound');
  const disclosure = await options.pub.getBlock({ blockNumber: log.blockNumber });
  if (!log.blockHash || disclosure.hash !== log.blockHash) throw new Error('Disclosure event is not canonical');
  return { ...observed, acceptedTriggerId: args.triggerId, disclosureBlock: log.blockNumber, disclosureTimestamp: disclosure.timestamp, delaySecs: disclosure.timestamp - record.t1,
    plaintext: await decryptReport(ciphertext, hexToBytes(args.key)) };
}
