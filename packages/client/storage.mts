import { keccak256, type Hex } from 'viem';
import { publicUrl } from './notice.mts';

export interface StorageProvider { id: string; uploadUrl: string; readUrl: string }
const maxCiphertext = 1_048_576 + 34;
// This is a client-only adapter. Operators configure two separate providers;
// different IDs/hosts are necessary, but operational independence needs review.
export async function publishCiphertext(ciphertext: Uint8Array<ArrayBuffer>, cipherHash: Hex,
  providers: readonly StorageProvider[], plutoOrigins: readonly string[], fetcher: typeof fetch = fetch): Promise<string[]> {
  if (ciphertext.length > maxCiphertext || keccak256(ciphertext) !== cipherHash) throw new Error('Ciphertext commitment mismatch');
  if (providers.length < 2 || providers.length > 8 || plutoOrigins.length === 0) throw new Error('Configure independent providers and Pluto origins');
  const ids = new Set<string>(), hosts = new Set<string>();
  for (const provider of providers) {
    const upload = new URL(publicUrl(provider.uploadUrl)), read = new URL(publicUrl(provider.readUrl));
    if (!/^[a-z0-9_-]{1,80}$/.test(provider.id) || ids.has(provider.id) || hosts.has(read.hostname)
        || plutoOrigins.some(origin => new URL(origin).origin === upload.origin || new URL(origin).origin === read.origin)) throw new Error('Storage providers must be independent of Pluto and each other');
    ids.add(provider.id); hosts.add(read.hostname);
  }
  const urls: string[] = [];
  for (const provider of providers) {
    const put = await fetcher(provider.uploadUrl, { method: 'PUT', body: ciphertext, credentials: 'omit', redirect: 'error',
      headers: { 'Content-Type': 'application/octet-stream' }, signal: AbortSignal.timeout(60_000) });
    if (!put.ok) throw new Error('Ciphertext upload failed');
    const response = await fetcher(provider.readUrl, { method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(60_000) });
    if (!response.ok || !response.body || Number(response.headers.get('content-length') ?? 0) > maxCiphertext) throw new Error('Ciphertext retrieval failed');
    const reader = response.body.getReader(), parts: Uint8Array[] = []; let length = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > maxCiphertext) { await reader.cancel(); throw new Error('Ciphertext copy exceeds supported size'); }
      parts.push(chunk.value);
    }
    const copy = new Uint8Array(length); let offset = 0;
    for (const part of parts) { copy.set(part, offset); offset += part.length; }
    if (keccak256(copy) !== cipherHash) throw new Error('Ciphertext copy commitment mismatch');
    urls.push(provider.readUrl);
  }
  return urls;
}
