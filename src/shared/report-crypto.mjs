import { getAddress, hexToBytes, keccak256, toHex } from 'viem';
import { policy } from '../../config/policy.mjs';
import { reportIdFor } from './disclosure.mjs';

export class ReportError extends Error {}
const magic = new TextEncoder().encode('PLUTO1');
const overhead = magic.length + 12 + 16;
export const maxReportBytes = policy.reportBuckets.at(-1) - 4;

function bytes(value, label, size) {
  if (typeof value !== 'string' || !/^0x(?:[a-fA-F0-9]{2})*$/.test(value)
      || value.length > (policy.reportBuckets.at(-1) + overhead) * 2 + 2
      || (size && value.length !== size * 2 + 2)) throw new ReportError(`Invalid ${label} encoding`);
  return hexToBytes(value);
}

export async function decryptReport(ciphertext, key) {
  if (!(ciphertext instanceof Uint8Array) || !(key instanceof Uint8Array) || key.length !== 32
      || !magic.every((value, index) => ciphertext[index] === value)
      || !policy.reportBuckets.includes(ciphertext.length - overhead)) {
    throw new ReportError('Invalid report ciphertext format or key size');
  }
  const secret = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
  let padded;
  try {
    padded = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM',
      iv: ciphertext.subarray(6, 18), additionalData: magic, tagLength: 128 }, secret, ciphertext.subarray(18)));
  } catch {
    throw new ReportError('Report authentication failed');
  }
  const length = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0);
  if (length > padded.length - 4 || padded.subarray(length + 4).some(value => value !== 0)) {
    throw new ReportError('Invalid authenticated report padding');
  }
  return padded.slice(4, length + 4);
}

// WebCrypto and Uint8Array only; the same envelope can be used by a browser client.
export async function prepareReport(report, researcher) {
  if (!(report instanceof Uint8Array) || report.length > maxReportBytes) throw new ReportError('Report exceeds the supported size');
  const padded = new Uint8Array(policy.reportBuckets.find(size => size >= report.length + 4));
  new DataView(padded.buffer).setUint32(0, report.length);
  padded.set(report, 4);
  const key = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const secret = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
    additionalData: magic, tagLength: 128 }, secret, padded));
  const ciphertext = new Uint8Array(magic.length + iv.length + encrypted.length);
  ciphertext.set(magic);
  ciphertext.set(iv, magic.length);
  ciphertext.set(encrypted, magic.length + iv.length);
  const author = getAddress(researcher);
  const cipherHash = keccak256(ciphertext);
  const keyCommit = keccak256(key);
  return { version: 1, researcher: author, key: toHex(key), ciphertext: toHex(ciphertext),
    cipherHash, keyCommit, reportId: reportIdFor(author, cipherHash, keyCommit) };
}

export async function validateRecoveryBundle(bundle) {
  const fields = ['version', 'researcher', 'key', 'ciphertext', 'cipherHash', 'keyCommit', 'reportId'];
  if (!bundle || bundle.version !== 1 || Object.keys(bundle).length !== fields.length
      || Object.keys(bundle).some(name => !fields.includes(name))) throw new ReportError('Invalid recovery bundle schema');
  const key = bytes(bundle.key, 'report key', 32);
  const ciphertext = bytes(bundle.ciphertext, 'ciphertext');
  const researcher = getAddress(bundle.researcher);
  const cipherHash = keccak256(ciphertext);
  const keyCommit = keccak256(key);
  const reportId = reportIdFor(researcher, cipherHash, keyCommit);
  if (cipherHash !== bundle.cipherHash || keyCommit !== bundle.keyCommit || reportId !== bundle.reportId) {
    throw new ReportError('Recovery bundle commitments do not match');
  }
  await decryptReport(ciphertext, key);
  return { ...bundle, researcher };
}
