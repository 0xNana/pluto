import { getAddress, recoverMessageAddress, type Hex } from 'viem';
import { randomUUID } from 'node:crypto';
import { PortalStore } from '../portal/store.mts';
import { SponsorService } from './service.mts';
import { exact, hex, object } from '../client/notice.mts';
import { parseSponsorInput, parseBindingGrant, sponsorReleaseMessage, sponsorRequestId, sponsorProofMessage, uint, type SponsorBounds } from '../client/sponsor-wire.mts';
import { encodeWire, decodeWire } from '../client/wire.mts';

interface Saved { id: Hex; protocol_id: string; author: Hex; intent_id: Hex; request_hash: Hex; input: string; bounds: string; release: Hex; state: 'pending' | 'attempted' | 'withdrawn'; created: number; expires: number }
function bounds(raw: unknown): SponsorBounds {
  const value = object(raw); exact(value, ['requestHash', 'ethReserveWei', 'feeNil']);
  return { requestHash: hex(value.requestHash, 32), ethReserveWei: uint(value.ethReserveWei), feeNil: uint(value.feeNil) };
}
export class SponsorRequests {
  readonly store: PortalStore; readonly service: SponsorService;
  constructor(store: PortalStore, service: SponsorService) {
    if (service.store !== store || store.chainId !== 11155111) throw new Error('Scoped Sepolia funding service required');
    this.store = store; this.service = service;
    store.db.exec(`CREATE TABLE IF NOT EXISTS funding_requests(id TEXT PRIMARY KEY, protocol_id TEXT NOT NULL REFERENCES protocols(id), author TEXT NOT NULL,
      nonce TEXT NOT NULL, intent_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, input TEXT NOT NULL, bounds TEXT NOT NULL, release TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, UNIQUE(author,nonce));
      CREATE TABLE IF NOT EXISTS relay_execution(id INTEGER PRIMARY KEY CHECK(id=1), request_id TEXT NOT NULL, phase TEXT NOT NULL, execution_token TEXT NOT NULL);`);
    for (const [table, field] of [['funding_requests', 'release'], ['relay_execution', 'execution_token']]) {
      if (!(store.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(column => column.name === field)) throw new Error('Legacy funding requests require explicit migration');
    }
  }
  #saved(id: Hex): Saved { const saved = this.store.db.prepare('SELECT * FROM funding_requests WHERE id=?').get(hex(id, 32)) as unknown as Saved | undefined;
    if (!saved) throw new Error('Not authorized'); return saved;
  }
  #header(saved: Saved) { return { id: saved.id, protocolId: saved.protocol_id, author: saved.author, state: saved.state,
    reportId: parseSponsorInput(decodeWire(saved.input)).bundle.reportId, bounds: decodeWire(saved.bounds), expires: saved.expires,
    nextNonce: parseSponsorInput(decodeWire(saved.input)).bundle.authorization.nonce + 1n }; }
  async #release(saved: Saved) {
    const input = parseSponsorInput(decodeWire(saved.input)), caps = bounds(decodeWire(saved.bounds));
    const message = sponsorReleaseMessage(this.store.origin, saved.protocol_id, caps);
    if (sponsorRequestId(message) !== saved.id || caps.requestHash !== saved.request_hash
      || getAddress(await recoverMessageAddress({ message, signature: hex(saved.release, 65) })) !== getAddress(saved.author)
      || getAddress(input.bundle.authorization.author) !== getAddress(saved.author)) throw new Error('Saved researcher release context mismatch');
    return input;
  }
  async quote(raw: unknown) {
    const input = parseSponsorInput(raw), prepared = await this.service.quote(input.protocolId, input.bundle, input.binding);
    return { requestHash: prepared.requestHash, ethReserveWei: prepared.ethReserveWei, feeNil: prepared.feeNil,
      escrowWei: prepared.escrowWei, costs: prepared.costs, payer: this.service.wallet.account.address };
  }
  async create(raw: unknown) {
    const value = object(raw); exact(value, ['input', 'bounds', 'release']);
    const input = parseSponsorInput(value.input), reviewed = bounds(value.bounds), message = sponsorReleaseMessage(this.store.origin, input.protocolId, reviewed);
    const author = getAddress(await recoverMessageAddress({ message, signature: hex(value.release, 65) }));
    if (author !== getAddress(input.bundle.authorization.author)) throw new Error('Invalid researcher release');
    const id = sponsorRequestId(message), serialized = encodeWire(input), caps = encodeWire(reviewed);
    const existing = this.store.db.prepare('SELECT * FROM funding_requests WHERE id=?').get(id) as unknown as Saved | undefined;
    if (existing) { if (existing.author !== author || existing.input !== serialized || existing.bounds !== caps) throw new Error('Conflicting funding release'); return this.#header(existing); }
    const fresh = await this.service.quote(input.protocolId, input.bundle, input.binding);
    if (fresh.requestHash !== reviewed.requestHash || fresh.ethReserveWei > reviewed.ethReserveWei || fresh.feeNil > reviewed.feeNil) throw new Error('Funding exceeds researcher review');
    const expiry = input.bundle.authorization.deadline < input.bundle.registration.deadline ? input.bundle.authorization.deadline : input.bundle.registration.deadline;
    if (expiry > BigInt(Number.MAX_SAFE_INTEGER) || expiry <= BigInt(this.store.now())) throw new Error('Funding release expired');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const protocol = this.store.db.prepare('SELECT enabled FROM protocols WHERE id=?').get(input.protocolId);
      if (!(protocol as { enabled?: number } | undefined)?.enabled) throw new Error('Sponsor disabled');
      const repeated = this.store.db.prepare('SELECT * FROM funding_requests WHERE id=?').get(id) as unknown as Saved | undefined;
      if (!repeated) {
        const count = this.store.db.prepare("SELECT count(*) AS n FROM funding_requests WHERE protocol_id=? AND state='pending'").get(input.protocolId) as { n: number };
        if (count.n >= 1000) throw new Error('Funding queue full');
        this.store.db.prepare("INSERT INTO funding_requests VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?)").run(id, input.protocolId, author, String(input.bundle.authorization.nonce), fresh.id, reviewed.requestHash, serialized, caps, hex(value.release, 65), this.store.now(), Number(expiry));
      } else if (repeated.author !== author || repeated.input !== serialized || repeated.bounds !== caps) throw new Error('Conflicting funding release');
      const result = this.#header(this.#saved(id)); this.store.db.exec('COMMIT'); return result;
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  async #author(id: Hex, raw: unknown, action: 'status' | 'withdraw' | 'binding') {
    const proof = object(raw); exact(proof, ['expires', 'signature']);
    if (typeof proof.expires !== 'number' || !Number.isSafeInteger(proof.expires) || proof.expires <= this.store.now() || proof.expires > this.store.now() + 300) throw new Error('Not authorized');
    const author = getAddress(await recoverMessageAddress({ message: sponsorProofMessage(this.store.origin, id, action, proof.expires), signature: hex(proof.signature, 65) }));
    const saved = this.store.db.prepare('SELECT * FROM funding_requests WHERE id=? AND author=?').get(hex(id, 32), author) as unknown as Saved | undefined;
    if (!saved) throw new Error('Not authorized'); return saved;
  }
  async #observe(saved: Saved) {
    if (saved.state !== 'attempted') return this.#header(saved);
    const lock = this.store.db.prepare('SELECT request_id,phase,execution_token FROM relay_execution WHERE id=1').get() as { request_id: string; phase: string; execution_token: string } | undefined;
    if (lock?.request_id === saved.id && lock.phase === 'sending') return { ...this.#header(saved), state: 'unknown' as const };
    try {
      const result = await this.service.observe(saved.intent_id);
      if (lock?.request_id === saved.id) this.store.db.prepare("DELETE FROM relay_execution WHERE id=1 AND request_id=? AND phase='awaiting-proof' AND execution_token=?").run(saved.id, lock.execution_token);
      return { ...this.#header(saved), ...result };
    } catch { return { ...this.#header(saved), state: 'unknown' as const }; }
  }
  async status(id: Hex, proof: unknown) { return this.#observe(await this.#author(id, proof, 'status')); }
  async withdraw(id: Hex, proof: unknown) {
    const saved = await this.#author(id, proof, 'withdraw');
    this.store.db.prepare("UPDATE funding_requests SET state='withdrawn' WHERE id=? AND state='pending'").run(saved.id);
    const current = this.#saved(id); if (current.state !== 'withdrawn') throw new Error('Funding already attempted; reconcile without resending');
    return this.#header(current);
  }
  list(session: string, protocolId: string, offset = 0) {
    const actor = this.store.authorize(session, protocolId); if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid offset');
    this.store.log(protocolId, actor.wallet, 'sponsorship.requests.read');
    return (this.store.db.prepare('SELECT * FROM funding_requests WHERE protocol_id=? ORDER BY created DESC,id LIMIT 50 OFFSET ?').all(protocolId, offset) as unknown as Saved[]).map(saved => this.#header(saved));
  }
  async customerStatus(session: string, protocolId: string, id: Hex) {
    this.store.authorize(session, protocolId); const saved = this.#saved(id); if (saved.protocol_id !== protocolId) throw new Error('Not authorized');
    return this.#observe(saved);
  }
  async customerQuote(session: string, protocolId: string, id: Hex) {
    this.store.authorize(session, protocolId, true); const saved = this.#saved(id); if (saved.protocol_id !== protocolId) throw new Error('Not authorized');
    if (saved.state !== 'pending') throw new Error('Funding no longer pending');
    const input = await this.#release(saved);
    return { ...await this.quote(input), input, release: saved.release };
  }
  async approve(session: string, protocolId: string, id: Hex, raw: unknown) {
    this.store.authorize(session, protocolId, true); const saved = this.#saved(id); if (saved.protocol_id !== protocolId) throw new Error('Not authorized');
    if (saved.state === 'withdrawn') throw new Error('Funding withdrawn');
    if (saved.state === 'attempted') return this.#observe(saved);
    if (!this.service.config.writesEnabled) throw new Error('Live sponsored submission is disabled until release approval');
    const reviewed = bounds(raw), authorCaps = bounds(decodeWire(saved.bounds)), input = await this.#release(saved);
    const prepared = await this.service.prepare(session, protocolId, input.bundle, input.binding);
    if (reviewed.requestHash !== saved.request_hash || prepared.requestHash !== saved.request_hash || reviewed.ethReserveWei > authorCaps.ethReserveWei || reviewed.feeNil > authorCaps.feeNil
      || prepared.ethReserveWei > reviewed.ethReserveWei || prepared.feeNil > reviewed.feeNil) throw new Error('Funding changed; refresh cost review');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const actor = this.store.authorize(session, protocolId, true);
      if (this.store.db.prepare('SELECT request_id FROM relay_execution WHERE id=1').get()) throw new Error('Relayer busy or unresolved; inspect existing request');
      if (!this.store.db.prepare("UPDATE funding_requests SET state='attempted' WHERE id=? AND state='pending' AND expires>?").run(id, this.store.now()).changes) throw new Error('Funding no longer pending');
      this.store.db.prepare("INSERT INTO relay_execution VALUES(1,?,'sending',?)").run(id, randomUUID());
      this.store.log(protocolId, actor.wallet, 'sponsorship.approved'); this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    try {
      await this.service.submit(session, { ...prepared, ethReserveWei: reviewed.ethReserveWei, feeNil: reviewed.feeNil });
    } catch {
      // No ledger means no sender was reached: submit revalidates and reserves
      // before any wallet call. Otherwise preserve the ambiguous outcome.
      if (!this.store.db.prepare('SELECT id FROM intents WHERE id=?').get(saved.intent_id)) {
        this.store.db.prepare("UPDATE funding_requests SET state='pending' WHERE id=? AND state='attempted'").run(id);
        this.store.db.prepare("DELETE FROM relay_execution WHERE request_id=? AND phase='sending'").run(id);
        return { ...this.#header(this.#saved(id)), state: 'review-required' as const };
      }
      let closed = false;
      try { this.service.closeUnfundedSubmission(saved.intent_id); closed = true; }
      catch { closed = false; } // Funded or unresolved posts retain capacity.
      this.store.db.prepare("UPDATE relay_execution SET phase='awaiting-proof' WHERE request_id=? AND phase='sending'").run(id);
      return { ...this.#header(saved), state: 'unknown' as const, reconciliation: closed ? 'closed-unfunded' : 'retained' };
    }
    this.store.db.prepare("UPDATE relay_execution SET phase='awaiting-proof' WHERE request_id=? AND phase='sending'").run(id);
    return this.#observe(this.#saved(id));
  }
  async bind(id: Hex, proof: unknown, rawGrant: unknown, reviewedGasWei: unknown) {
    const saved = await this.#author(id, proof, 'binding'), grant = parseBindingGrant(rawGrant);
    if (!this.service.config.writesEnabled) throw new Error('Live sponsored submission is disabled until release approval');
    const gasWei = uint(reviewedGasWei); if (gasWei === 0n) throw new Error('Reviewed binding costs required');
    const observed = await this.#observe(saved);
    if (observed.state === 'bound') return observed;
    if (observed.state !== 'awaiting-binding' || getAddress(grant.researcher) !== saved.author) throw new Error('Funded binding proof unavailable');
    this.store.db.prepare("INSERT INTO relay_execution VALUES(1,?,'sending',?)").run(id, randomUUID());
    try { await this.service.completeBinding(saved.intent_id, grant, gasWei); }
    catch { this.store.db.prepare("UPDATE relay_execution SET phase='awaiting-proof' WHERE request_id=?").run(id); return { ...this.#header(saved), state: 'unknown' as const }; }
    this.store.db.prepare("UPDATE relay_execution SET phase='awaiting-proof' WHERE request_id=?").run(id);
    return this.#observe(saved);
  }
}
