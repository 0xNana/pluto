import { getAddress, keccak256, type Hex } from 'viem';
import { encryptContactAttachment, verifyAttachment, type ContactKey } from './attachment.mts';
import { exact, hex, object, verifyNotice, type MessageSigner } from './notice.mts';

export async function verifiedContacts(domain: string, fetcher: typeof fetch = fetch): Promise<ContactKey[]> {
  if (domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new Error('Invalid protocol domain');
  const response = await fetcher(`/api/directory/${domain}`, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('Verified contacts unavailable');
  const values: unknown = await response.json();
  if (!Array.isArray(values) || values.length > 100) throw new Error('Invalid contact directory');
  return values.map(value => {
    const entry = object(value); exact(entry, ['contactId', 'keyVersion', 'publicKey', 'fingerprint']);
    if (typeof entry.contactId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(entry.contactId) || typeof entry.keyVersion !== 'number' || !Number.isSafeInteger(entry.keyVersion) || entry.keyVersion < 1) throw new Error('Invalid contact');
    const publicKey = hex(entry.publicKey, 32), fingerprint = hex(entry.fingerprint, 32);
    if (keccak256(publicKey) !== fingerprint) throw new Error('Contact fingerprint mismatch');
    return { contactId: entry.contactId, keyVersion: entry.keyVersion, publicKey, fingerprint };
  });
}

// Browser-only. The returned delivery object contains no unencrypted report
// secrets; recovery and recipient private keys are never network arguments.
export async function prepareNoticeDelivery(options: { notice: unknown; key: Hex; plaintext?: Hex; contact: ContactKey;
  signer: MessageSigner; confirmedFingerprint: Hex; deliveryApproved: boolean }) {
  const notice = await verifyNotice(options.notice);
  if (getAddress(options.signer.address) !== getAddress(notice.researcher) || keccak256(hex(options.key, 32)) !== notice.keyCommit) throw new Error('Local author or key differs from the signed notice');
  const attachment = await encryptContactAttachment({ ...options, reportId: notice.reportId });
  return { contactId: options.contact.contactId, notice, attachment };
}

export async function sendNoticeDelivery(delivery: Awaited<ReturnType<typeof prepareNoticeDelivery>>, fetcher: typeof fetch = fetch) {
  exact(object(delivery), ['contactId', 'notice', 'attachment']);
  const notice = await verifyNotice(delivery.notice), attachment = await verifyAttachment(delivery.attachment, notice.researcher, notice.reportId);
  if (delivery.contactId !== attachment.contactId) throw new Error('Delivery contact mismatch');
  const response = await fetcher('/api/notices', { method: 'POST', credentials: 'same-origin', redirect: 'error',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(delivery), signal: AbortSignal.timeout(30_000) });
  if (!response.ok || object(await response.json()).delivered !== true) throw new Error('Private notice delivery was not accepted');
}
