import { getAddress, recoverMessageAddress, type Hex } from 'viem';

export interface Notice {
  version: 1; chainId: number; registry: Hex; reportId: Hex; triggerId: string;
  cipherHash: Hex; cipherUris: string[]; keyCommit: Hex;
  window: { t1: string; t2: string }; researcher: Hex; verifyUrl: string;
}
export interface SignedNotice extends Notice { signature: Hex }
export interface MessageSigner {
  address: Hex; signMessage(args: { message: string }): Promise<Hex>;
}
const fields = ['version', 'chainId', 'registry', 'reportId', 'triggerId', 'cipherHash',
  'cipherUris', 'keyCommit', 'window', 'researcher', 'verifyUrl'];
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid object');
  return value as Record<string, unknown>;
}
export function exact(value: Record<string, unknown>, names: readonly string[]) {
  if (Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) {
    throw new Error('Unexpected or missing fields');
  }
}
export function hex(value: unknown, size?: number): Hex {
  if (typeof value !== 'string' || !/^0x(?:[a-fA-F0-9]{2})+$/.test(value)
      || (size !== undefined && value.length !== 2 + size * 2)) throw new Error('Invalid hex');
  return value as Hex;
}
function decimal(value: unknown, bits: number): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value)
      || BigInt(value) >= 1n << BigInt(bits)) throw new Error('Invalid unsigned decimal');
  return value;
}
export function publicUrl(value: unknown, storage = false): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid URL');
  const url = new URL(value);
  if (!(storage ? ['https:', 'ipfs:', 'ar:'] : ['https:']).includes(url.protocol)
      || !url.hostname || url.username || url.password) throw new Error('Unsafe URL');
  return value;
}
// The accepted schema contains only ASCII field names, integers and strings.
// Sorting object keys gives a deterministic JSON representation in both runtimes.
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const record = object(value);
  return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
}
export function validateNotice(value: unknown): Notice {
  const n = object(value); exact(n, fields);
  if (n.version !== 1 || ![1, 11155111].includes(Number(n.chainId)) || typeof n.chainId !== 'number') throw new Error('Unsupported notice version or chain');
  const window = object(n.window); exact(window, ['t1', 't2']);
  const t1 = decimal(window.t1, 64), t2 = decimal(window.t2, 64);
  if (BigInt(t2) <= BigInt(t1)) throw new Error('Invalid notice window');
  if (!Array.isArray(n.cipherUris) || n.cipherUris.length < 2 || n.cipherUris.length > 8) throw new Error('Two ciphertext locations required');
  const cipherUris = n.cipherUris.map(uri => publicUrl(uri, true));
  if (new Set(cipherUris).size !== cipherUris.length) throw new Error('Duplicate ciphertext location');
  return { version: 1, chainId: n.chainId, registry: getAddress(hex(n.registry, 20)),
    reportId: hex(n.reportId, 32), triggerId: decimal(n.triggerId, 256),
    cipherHash: hex(n.cipherHash, 32), cipherUris, keyCommit: hex(n.keyCommit, 32),
    window: { t1, t2 }, researcher: getAddress(hex(n.researcher, 20)), verifyUrl: publicUrl(n.verifyUrl) };
}
export function publicNotice(value: unknown): SignedNotice {
  const input = object(value);
  const allowed = [...fields, 'signature', ...(Object.hasOwn(input, 'recipientEncryptedKey') ? ['recipientEncryptedKey'] : [])];
  exact(input, allowed);
  const unsigned = Object.fromEntries(fields.map(name => [name, input[name]]));
  return { ...validateNotice(unsigned), signature: hex(input.signature, 65) };
}
export async function signNotice(value: unknown, signer: MessageSigner): Promise<SignedNotice> {
  const notice = validateNotice(value);
  if (getAddress(signer.address) !== notice.researcher) throw new Error('Notice signer is not its researcher');
  const signature = await signer.signMessage({ message: 'Pluto Disclosure Notice v1\n' + canonical(notice) });
  return { ...notice, signature };
}
export async function verifyNotice(value: unknown): Promise<SignedNotice> {
  const notice = publicNotice(value);
  const { signature, ...unsigned } = notice;
  const author = await recoverMessageAddress({ message: 'Pluto Disclosure Notice v1\n' + canonical(unsigned), signature });
  if (getAddress(author) !== notice.researcher) throw new Error('Notice signature mismatch');
  return notice;
}
