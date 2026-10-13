import { getAddress, hexToBytes, keccak256, recoverMessageAddress, toHex, type Hex } from 'viem';
import { canonical, exact, hex, object, type MessageSigner } from './notice.mts';

export interface ContactKey { contactId: string; keyVersion: number; publicKey: Hex; fingerprint: Hex }
interface Header extends ContactKey { version: 1; reportId: Hex; researcher: Hex; ephemeralKey: Hex; iv: Hex }
export interface Attachment extends Header { ciphertext: Hex; signature: Hex }
const domain = 'Pluto Contact Attachment v1\n';
const names = ['version', 'reportId', 'researcher', 'contactId', 'keyVersion', 'publicKey', 'fingerprint', 'ephemeralKey', 'iv', 'ciphertext', 'signature'];
const buffer = (value: Hex) => new Uint8Array(hexToBytes(value));
function checkedContact(value: ContactKey): ContactKey {
  exact(object(value), ['contactId', 'keyVersion', 'publicKey', 'fingerprint']);
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value.contactId) || !Number.isSafeInteger(value.keyVersion) || value.keyVersion < 1
      || keccak256(hex(value.publicKey, 32)) !== hex(value.fingerprint, 32)) throw new Error('Invalid contact key');
  return value;
}
export async function verifyAttachment(value: unknown, researcher: Hex, reportId: Hex): Promise<Attachment> {
  const a = object(value); exact(a, names);
  if (a.version !== 1 || hex(a.reportId, 32) !== reportId || getAddress(hex(a.researcher, 20)) !== getAddress(researcher)) throw new Error('Attachment context mismatch');
  checkedContact({ contactId: String(a.contactId), keyVersion: Number(a.keyVersion), publicKey: hex(a.publicKey, 32), fingerprint: hex(a.fingerprint, 32) });
  if (typeof a.contactId !== 'string' || typeof a.keyVersion !== 'number') throw new Error('Invalid contact metadata');
  hex(a.ephemeralKey, 32); hex(a.iv, 12);
  const ciphertext = hex(a.ciphertext);
  if (ciphertext.length < 34 || ciphertext.length > 2_200_000) throw new Error('Invalid attachment size');
  const signature = hex(a.signature, 65);
  const { signature: _signature, ...unsigned } = a;
  if (getAddress(await recoverMessageAddress({ message: domain + canonical(unsigned), signature })) !== getAddress(researcher)) throw new Error('Attachment signature mismatch');
  return a as unknown as Attachment;
}
// Standard X25519 -> HKDF-SHA256 -> AES-256-GCM, as in W3C WebCrypto §35.1.
// https://www.w3.org/TR/webcrypto/#example-generate-two-key-pairs-derive-a-shared-key-encrypt-some-data
async function derive(privateKey: CryptoKey, publicKey: Hex, header: Header): Promise<CryptoKey> {
  const peer = await crypto.subtle.importKey('raw', buffer(publicKey), 'X25519', false, []);
  const shared = await crypto.subtle.deriveKey({ name: 'X25519', public: peer }, privateKey, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: buffer(header.reportId),
    info: new TextEncoder().encode(domain + canonical(header)) }, shared,
  { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function encryptContactAttachment(options: {
  reportId: Hex; contact: ContactKey; key: Hex; plaintext?: Hex; signer: MessageSigner;
  confirmedFingerprint: Hex; deliveryApproved: boolean;
}): Promise<Attachment> {
  const contact = checkedContact(options.contact);
  if (options.deliveryApproved !== true || options.confirmedFingerprint !== contact.fingerprint) throw new Error('Confirm contact fingerprint and approve delivery');
  const payload = { key: hex(options.key, 32), ...(options.plaintext === undefined ? {} : { plaintext: hex(options.plaintext) }) };
  if (canonical(payload).length > 2_100_000) throw new Error('Attachment exceeds supported size');
  const ephemeral = await crypto.subtle.generateKey('X25519', false, ['deriveKey']) as CryptoKeyPair;
  const header: Header = { ...contact, version: 1, reportId: hex(options.reportId, 32), researcher: getAddress(options.signer.address),
    ephemeralKey: toHex(new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey))), iv: toHex(crypto.getRandomValues(new Uint8Array(12))) };
  const encryptionKey = await derive(ephemeral.privateKey, contact.publicKey, header);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buffer(header.iv), additionalData: new TextEncoder().encode(canonical(header)) }, encryptionKey, new TextEncoder().encode(canonical(payload)));
  const unsigned = { ...header, ciphertext: toHex(new Uint8Array(encrypted)) };
  return { ...unsigned, signature: await options.signer.signMessage({ message: domain + canonical(unsigned) }) };
}
export async function decryptContactAttachment(value: unknown, privateKey: CryptoKey, contact: ContactKey, researcher: Hex): Promise<{ key: Hex; plaintext?: Hex }> {
  checkedContact(contact);
  const a = object(value);
  const attachment = await verifyAttachment(a, researcher, hex(a.reportId, 32));
  for (const name of ['contactId', 'keyVersion', 'publicKey', 'fingerprint'] as const) {
    if (attachment[name] !== contact[name]) throw new Error('Attachment is for a different contact key');
  }
  const { signature: _signature, ciphertext, ...header } = attachment;
  const encryptionKey = await derive(privateKey, header.ephemeralKey, header);
  let decoded: Record<string, unknown>;
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buffer(header.iv), additionalData: new TextEncoder().encode(canonical(header)) }, encryptionKey, buffer(ciphertext));
    decoded = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)));
  } catch { throw new Error('Contact attachment authentication failed'); }
  exact(decoded, ['key', ...(Object.hasOwn(decoded, 'plaintext') ? ['plaintext'] : [])]);
  return { key: hex(decoded.key, 32), ...(decoded.plaintext === undefined ? {} : { plaintext: hex(decoded.plaintext) }) };
}
