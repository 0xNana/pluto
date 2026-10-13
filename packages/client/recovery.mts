import { getAddress, hexToBytes, keccak256, recoverMessageAddress, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { compileCondition, layerLenForPayload, type PostSealedArgs } from '@nillion/covenants-sdk/browser';
import { validateRecoveryBundle, prepareReport } from '../../src/shared/report-crypto.mjs';
import { hex, object, publicUrl } from './notice.mts';
import { decodeWire, encodeWire } from './wire.mts';
import { parseSponsorInput, sponsorReleaseMessage, sponsorRequestId, uint } from './sponsor-wire.mts';

type Report = Awaited<ReturnType<typeof prepareReport>>;
export type RecoveryAction = 'register' | 'approve' | 'postTrigger' | 'bind' | 'sponsorRequest' | 'sponsorWithdraw';
type Action = RecoveryAction;
interface RecoveryEvent { sequence: number; action: Action; state: 'unknown' | 'submitted'; hash?: Hex }
export interface BrowserRecovery {
  format: 'pluto-browser-recovery'; version: 2; chainId: 11155111;
  authorKey: Hex; report: Report;
  sealing: null | { registry: Hex; market: Hex; cipherUris: string[]; nonce: Hex; args: string };
  history: RecoveryEvent[];
  funding?: { origin: string; id: Hex; body: string };
}
export const maxRecoveryFileBytes = 2_400_000;
const exact = (value: Record<string, unknown>, names: string[]) => {
  if (Object.keys(value).length !== names.length || Object.keys(value).some(key => !names.includes(key))) throw new Error('Invalid private recovery schema');
};
export async function newBrowserRecovery(report: unknown, authorKey: Hex): Promise<BrowserRecovery> {
  return validateBrowserRecovery({ format: 'pluto-browser-recovery', version: 2, chainId: 11155111, authorKey, report, sealing: null, history: [] });
}
export function recoveryContext(value: BrowserRecovery) {
  return keccak256(toHex(JSON.stringify({ reportId: value.report.reportId, sealing: value.sealing })));
}
export function savedSealArgs(value: BrowserRecovery): PostSealedArgs {
  if (!value.sealing) throw new Error('Sealed recovery unavailable');
  return decodeWire(value.sealing.args) as PostSealedArgs;
}
export function fundingRequestId(value: BrowserRecovery): Hex | undefined {
  const last = value.history.filter(event => event.action === 'sponsorRequest' || event.action === 'sponsorWithdraw').at(-1);
  return last?.action === 'sponsorRequest' ? last.hash : undefined;
}
export function canStartPosting(value: BrowserRecovery) {
  return !fundingRequestId(value) && value.history.every(event => ['sponsorRequest', 'sponsorWithdraw'].includes(event.action))
    && value.history.at(-1)?.state !== 'unknown';
}
// Append the attempted transition before a wallet call and its hash immediately
// afterwards. Keeping both entries preserves unknown outcomes across restarts.
export function appendRecoveryEvent(value: BrowserRecovery, action: Action, hash?: Hex): BrowserRecovery {
  if (!value.sealing || !['register', 'approve', 'postTrigger', 'bind', 'sponsorRequest', 'sponsorWithdraw'].includes(action) || value.history.length >= 100) throw new Error('Invalid recovery transition');
  const previous = value.history.at(-1);
  if (hash !== undefined) {
    hash = hex(hash, 32).toLowerCase() as Hex;
    if (!previous || previous.state !== 'unknown' || previous.action !== action || (action !== 'sponsorWithdraw' && value.history.some(event => event.hash === hash))
      || (action === 'sponsorWithdraw' && value.history.filter(event => event.action === 'sponsorRequest' && event.state === 'submitted').at(-1)?.hash !== hash)) throw new Error('Hash requires its matching attempt');
  } else {
    if (previous?.state === 'unknown') throw new Error('Unresolved attempt must be reconciled first');
    const submitted = value.history.filter(event => event.state === 'submitted');
    const posts = submitted.filter(event => event.action === 'postTrigger');
    if ((action === 'sponsorRequest' && !canStartPosting(value)) || (action === 'sponsorWithdraw' && !fundingRequestId(value))
      || ((!['sponsorRequest', 'sponsorWithdraw'].includes(action)) && fundingRequestId(value))
      || (!previous && !['register', 'sponsorRequest'].includes(action)) || (action === 'register' && !canStartPosting(value))
      || (action === 'approve' && (posts.length > 0 || !submitted.some(event => event.action === 'register')))
      || (action === 'postTrigger' && (!submitted.some(event => event.action === 'register') || posts.length >= 2 || submitted.some(event => event.action === 'bind')))
      || (action === 'bind' && posts.length === 0)) throw new Error('Invalid recovery action order');
  }
  const event: RecoveryEvent = { sequence: value.history.length, action, state: hash === undefined ? 'unknown' : 'submitted', ...(hash === undefined ? {} : { hash }) };
  return { ...value, history: [...value.history, event] };
}
export async function validateBrowserRecovery(raw: unknown): Promise<BrowserRecovery> {
  const value = object(raw); exact(value, ['format', 'version', 'chainId', 'authorKey', 'report', 'sealing', 'history', ...('funding' in value ? ['funding'] : [])]);
  if (value.format !== 'pluto-browser-recovery' || value.version !== 2 || value.chainId !== 11155111) throw new Error('Invalid private recovery schema');
  const authorKey = hex(value.authorKey, 32), report = await validateRecoveryBundle(value.report);
  if (getAddress(privateKeyToAccount(authorKey).address) !== getAddress(report.researcher)) throw new Error('Recovery author mismatch');
  let sealing: BrowserRecovery['sealing'] = null;
  if (value.sealing !== null) {
    const seal = object(value.sealing); exact(seal, ['registry', 'market', 'cipherUris', 'nonce', 'args']);
    if (typeof seal.args !== 'string' || seal.args.length > 100_000 || !Array.isArray(seal.cipherUris) || seal.cipherUris.length < 2 || seal.cipherUris.length > 8) throw new Error('Invalid sealed recovery');
    const registry = getAddress(hex(seal.registry, 20)), market = getAddress(hex(seal.market, 20)), nonce = hex(seal.nonce, 32);
    const cipherUris = seal.cipherUris.map(uri => publicUrl(uri, true));
    if (new Set(cipherUris.map(uri => new URL(uri).hostname.toLowerCase())).size !== cipherUris.length) throw new Error('Independent recovery locations required');
    const args = object(decodeWire(seal.args));
    const allowed = ['mode', 'ttl', 'keys', 'k', 't1', 't2', 'ceilingWei', 'hook', 'hookGasLimit', 'retryWindowSecs', 'layers', 'commit', 'publicCondition'];
    exact(args, allowed);
    if (args.mode !== 'PUBLIC_CONDITION' || args.ttl !== 0 || getAddress(hex(args.hook, 20)) !== registry
      || typeof args.t1 !== 'bigint' || typeof args.t2 !== 'bigint' || args.t1 <= 0n || args.t2 <= args.t1 || args.t2 >= 1n << 64n
      || typeof args.ceilingWei !== 'bigint' || args.ceilingWei <= 0n || !Number.isInteger(args.k) || Number(args.k) <= 0
      || !Array.isArray(args.keys) || args.keys.length <= Number(args.k)
      || !Array.isArray(args.layers) || args.layers.length !== args.keys.length
      || args.layers.some(layer => !(layer instanceof Uint8Array) || layer.length !== Number(layerLenForPayload(64, 'PUBLIC_CONDITION')))
      || !Number.isInteger(args.hookGasLimit) || Number(args.hookGasLimit) <= 0 || Number(args.hookGasLimit) > 0xffffffff
      || !Number.isInteger(args.retryWindowSecs) || Number(args.retryWindowSecs) <= 0 || Number(args.retryWindowSecs) > 0xffffffff) throw new Error('Invalid recovery posting terms');
    const keyIds = new Set<string>(), nodeIds = new Set<string>();
    for (const rawKey of args.keys) {
      const key = object(rawKey);
      if (typeof key.keyId !== 'bigint' || key.keyId < 0n || typeof key.nodeId !== 'bigint' || key.nodeId < 0n
        || typeof key.mpk !== 'string' || !/^0x(?:[a-fA-F0-9]{2})+$/.test(key.mpk) || key.mpk.length > 1026
        || keyIds.has(String(key.keyId)) || nodeIds.has(String(key.nodeId))) throw new Error('Invalid recovery committee');
      keyIds.add(String(key.keyId)); nodeIds.add(String(key.nodeId));
    }
    const condition = compileCondition({ window: { t1: args.t1, t2: args.t2 } });
    const payload = new Uint8Array([...hexToBytes(report.key), ...hexToBytes(report.reportId), ...hexToBytes(nonce)]);
    if (!(args.publicCondition instanceof Uint8Array) || toHex(args.publicCondition) !== toHex(condition) || args.commit !== keccak256(payload)) throw new Error('Recovery seal commitment mismatch');
    sealing = { registry, market, cipherUris, nonce, args: seal.args };
  }
  if (!Array.isArray(value.history) || value.history.length > 100 || (!sealing && value.history.length)) throw new Error('Invalid recovery history');
  let result: BrowserRecovery = { format: 'pluto-browser-recovery', version: 2, chainId: 11155111, authorKey, report, sealing, history: [] };
  for (const rawEvent of value.history) {
    const event = object(rawEvent); exact(event, event.state === 'submitted' ? ['sequence', 'action', 'state', 'hash'] : ['sequence', 'action', 'state']);
    if (event.sequence !== result.history.length || !['unknown', 'submitted'].includes(String(event.state))) throw new Error('Invalid recovery history');
    result = appendRecoveryEvent(result, String(event.action) as Action, event.state === 'submitted' ? hex(event.hash, 32) : undefined);
  }
  if ('funding' in value) {
    const funding = object(value.funding); exact(funding, ['origin', 'id', 'body']);
    if (!sealing || typeof funding.origin !== 'string' || typeof funding.body !== 'string' || funding.body.length > 200_000) throw new Error('Invalid private funding recovery');
    const body = object(decodeWire(funding.body)); exact(body, ['input', 'bounds', 'release']);
    const input = parseSponsorInput(body.input), caps = object(body.bounds); exact(caps, ['requestHash', 'ethReserveWei', 'feeNil']);
    const bounds = { requestHash: hex(caps.requestHash, 32), ethReserveWei: uint(caps.ethReserveWei), feeNil: uint(caps.feeNil) };
    const message = sponsorReleaseMessage(funding.origin, input.protocolId, bounds), id = sponsorRequestId(message);
    const args = savedSealArgs(result);
    const normalized = parseSponsorInput({ ...input, bundle: { ...input.bundle, args: { ...args, keys: args.keys.map(({ keyId, nodeId, mpk }) => ({ keyId, nodeId, mpk })) } } });
    if (id !== hex(funding.id, 32) || bounds.requestHash !== keccak256(toHex(encodeWire({ bundle: input.bundle, binding: input.binding })))
      || input.bundle.reportId !== report.reportId || input.bundle.cipherHash !== report.cipherHash || input.bundle.keyCommit !== report.keyCommit
      || encodeWire(input.bundle.args) !== encodeWire(normalized.bundle.args)
      || getAddress(await recoverMessageAddress({ message, signature: hex(body.release, 65) })) !== getAddress(report.researcher)
      || result.history.filter(event => event.action === 'sponsorRequest' && event.hash).at(-1)?.hash !== id) throw new Error('Private funding recovery context mismatch');
    result = { ...result, funding: { origin: funding.origin, id, body: funding.body } };
  }
  return result;
}
export function exportBrowserRecovery(value: BrowserRecovery) { return JSON.stringify(value); }
export async function importBrowserRecovery(contents: string) {
  if (contents.length > maxRecoveryFileBytes) throw new Error('Private recovery file too large');
  return validateBrowserRecovery(JSON.parse(contents));
}
export function mergeBrowserRecovery(incoming: BrowserRecovery, stored?: BrowserRecovery): BrowserRecovery {
  if (!stored) return incoming;
  if (stored.report.reportId !== incoming.report.reportId || stored.authorKey !== incoming.authorKey) throw new Error('Recovery identity conflict');
  if (recoveryContext(stored) !== recoveryContext(incoming)) {
    if (stored.history.length || incoming.history.length) throw new Error('Recovery context conflict');
    return incoming;
  }
  const longer = stored.history.length > incoming.history.length ? stored : incoming;
  const shorter = longer === stored ? incoming : stored;
  if (shorter.history.some((event, i) => JSON.stringify(event) !== JSON.stringify(longer.history[i]))) throw new Error('Recovery history conflict');
  const lastRequest = longer.history.filter(event => event.action === 'sponsorRequest' && event.hash).at(-1)?.hash;
  const funding = longer.funding ?? (shorter.funding?.id === lastRequest ? shorter.funding : undefined);
  if (longer.funding && shorter.funding?.id === longer.funding.id && encodeWire(shorter.funding) !== encodeWire(longer.funding)) throw new Error('Recovery funding conflict');
  return { ...longer, ...(funding ? { funding } : {}) };
}
export function claimRecoveryEvent(value: BrowserRecovery, stored: BrowserRecovery | undefined, action: Action, hash?: Hex) {
  if (!stored || recoveryContext(stored) !== recoveryContext(value)) throw new Error('Recovery context changed');
  if (stored.authorKey !== value.authorKey || JSON.stringify(stored.history) !== JSON.stringify(value.history)) throw new Error('Recovery history changed; load and inspect the saved record before retrying');
  return appendRecoveryEvent(stored, action, hash);
}

// A new store preserves the old v1 last-action records rather than treating
// their missing history as permission to retry. Only this browser can read it.
export class BrowserRecoveryStore {
  async #open() {
    const request = indexedDB.open('pluto-local-recovery', 2); let blocked = false;
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('recoveries')) request.result.createObjectStore('recoveries', { keyPath: 'reportId' }); };
    return new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); }; request.onerror = () => reject(new Error('Local recovery storage unavailable'));
      request.onblocked = () => { blocked = true; reject(new Error('Close other Pluto tabs before upgrading recovery storage')); };
    });
  }
  async #transaction(id: Hex, update?: (stored: BrowserRecovery | undefined) => BrowserRecovery) {
    const db = await this.#open();
    try {
      return await new Promise<BrowserRecovery | undefined>((resolve, reject) => {
        const tx = db.transaction('recoveries', update ? 'readwrite' : 'readonly', { durability: 'strict' });
        const store = tx.objectStore('recoveries'), request = store.get(id); let result: BrowserRecovery | undefined;
        tx.oncomplete = () => resolve(result); tx.onerror = tx.onabort = () => reject(new Error('Local recovery transaction failed'));
        request.onsuccess = () => {
          try { result = request.result?.value as BrowserRecovery | undefined; if (update) { result = update(result); store.put({ reportId: id, value: result }); } }
          catch { tx.abort(); }
        };
      });
    } finally { db.close(); }
  }
  async save(value: BrowserRecovery) {
    const validated = await validateBrowserRecovery(value);
    return this.#transaction(validated.report.reportId, stored => {
      return mergeBrowserRecovery(validated, stored);
    });
  }
  async load(id: Hex) { const value = await this.#transaction(id); return value ? validateBrowserRecovery(value) : undefined; }
  async append(value: BrowserRecovery, action: Action, hash?: Hex) {
    const result = await this.#transaction(value.report.reportId, stored => {
      return claimRecoveryEvent(value, stored, action, hash);
    });
    if (!result) throw new Error('Local recovery unavailable'); return result;
  }
  // A funding request ID is a deterministic identity, never a transaction hash.
  // Save it atomically before HTTP so another tab cannot choose another payer.
  async claimFunding(value: BrowserRecovery, id: Hex, action: 'sponsorRequest' | 'sponsorWithdraw', release?: { origin: string; body: string }) {
    if (action === 'sponsorRequest' && !release) throw new Error('Exact signed release must be saved before upload');
    const candidate = appendRecoveryEvent(appendRecoveryEvent(value, action), action, id);
    const validated = await validateBrowserRecovery({ ...candidate, ...(release ? { funding: { ...release, id } } : {}) });
    const result = await this.#transaction(value.report.reportId, stored => {
      const attempted = claimRecoveryEvent(value, stored, action);
      return { ...appendRecoveryEvent(attempted, action, id), ...(validated.funding ? { funding: validated.funding } : {}) };
    });
    if (!result) throw new Error('Local recovery unavailable'); return result;
  }
}
