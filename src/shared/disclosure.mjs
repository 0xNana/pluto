import { encodeAbiParameters, getAddress, hexToBytes, keccak256 } from 'viem';
import { compileCondition } from '@nillion/covenants-sdk/browser';
import { policy } from '../../config/policy.mjs';

function bytes32(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new TypeError(`${label} must be bytes32 hex`);
  }
  return value;
}

function unixSeconds(value, label) {
  if (typeof value !== 'bigint' && !(typeof value === 'number' && Number.isSafeInteger(value))) {
    throw new TypeError(`${label} must be an integer in Unix seconds`);
  }
  const seconds = BigInt(value);
  if (seconds < 0n || seconds > (1n << 64n) - 1n) {
    throw new RangeError(`${label} must fit uint64`);
  }
  return seconds;
}

// Must match SRS FR-301: Solidity abi.encode, rather than abi.encodePacked.
export function reportIdFor(researcher, cipherHash, keyCommit) {
  return keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' }],
    [getAddress(researcher), bytes32(cipherHash, 'cipherHash'), bytes32(keyCommit, 'keyCommit')],
  ));
}

export function retryReportIdFor(parentReportId, t1, t2) {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint64' }, { type: 'uint64' }],
    [bytes32(parentReportId, 'parentReportId'), unixSeconds(t1, 't1'), unixSeconds(t2, 't2')],
  ));
}

export function encodeDisclosurePayload(key, reportId) {
  if (!(key instanceof Uint8Array) || key.length !== 32) {
    throw new TypeError('K must be 32 bytes');
  }
  const payload = new Uint8Array(64);
  payload.set(key);
  payload.set(hexToBytes(bytes32(reportId, 'reportId')), 32);
  return payload;
}

// Caller supplies the latest chain block timestamp, never the local wall clock.
// Revalidate against the latest block before submitting; mining can still be late.
export function compileDisclosureWindow({ nowUnix, t1, t2 }) {
  const now = unixSeconds(nowUnix, 'nowUnix');
  const start = unixSeconds(t1, 't1');
  const end = unixSeconds(t2, 't2');
  if (start < now + BigInt(policy.marginSecs)) {
    throw new RangeError('t1 must leave the configured posting margin');
  }
  if (end - start < BigInt(policy.minimumWindowSecs)) {
    throw new RangeError('window is below the configured minimum width');
  }
  return {
    mode: 'PUBLIC_CONDITION',
    ttl: 0,
    t1: start,
    t2: end,
    conditionRecord: compileCondition({ window: { t1: start, t2: end } }),
  };
}
