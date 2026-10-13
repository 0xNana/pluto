import { createHash, randomBytes } from 'node:crypto';
import { keccak256, type Hex } from 'viem';
import { hex, publicNotice, verifyNotice, type SignedNotice } from '../client/notice.mts';
import { verifyAttachment } from '../client/attachment.mts';
import { PortalStore } from './store.mts';

const digest = (code: string) => createHash('sha256').update(code).digest('hex');
const record = (row: unknown) => row as Record<string, unknown> | undefined;
export class PortalInbox {
  readonly store: PortalStore;
  readonly retention: number;
  constructor(store: PortalStore, retention: number) {
    if (!Number.isSafeInteger(retention) || retention < 86400 || retention > 365 * 86400) throw new Error('Invalid private metadata retention');
    this.store = store; this.retention = retention;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts(id TEXT PRIMARY KEY, protocol_id TEXT REFERENCES protocols(id), email TEXT NOT NULL, key_version INTEGER NOT NULL, public_key TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS contact_challenges(id TEXT PRIMARY KEY REFERENCES contacts(id), hash TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, email TEXT NOT NULL, code TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notices(protocol_id TEXT NOT NULL REFERENCES protocols(id), report_id TEXT NOT NULL, contact_id TEXT NOT NULL, notice TEXT NOT NULL, attachment TEXT, expires INTEGER NOT NULL, PRIMARY KEY(protocol_id,report_id));
      CREATE TABLE IF NOT EXISTS public_notices(report_id TEXT PRIMARY KEY, notice TEXT NOT NULL, publish_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS contact_rotations(id TEXT PRIMARY KEY REFERENCES contacts(id), key_version INTEGER NOT NULL, public_key TEXT NOT NULL, hash TEXT NOT NULL, expires INTEGER NOT NULL);
    `);
  }
  requestContact(session: string, protocolId: string, input: { email: string; publicKey: Hex }) {
    const actor = this.store.authorize(session, protocolId, true);
    if (!/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-zA-Z0-9.-]{1,190}$/.test(input.email)) throw new Error('Invalid contact email');
    const key = hex(input.publicKey, 32), id = randomBytes(16).toString('hex'), code = randomBytes(32).toString('hex');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.db.prepare('INSERT INTO contacts(id,protocol_id,email,key_version,public_key) VALUES(?,?,?,1,?)').run(id, protocolId, input.email, key);
      this.store.db.prepare('INSERT INTO contact_challenges VALUES(?,?,?)').run(id, digest(code), this.store.now() + 1800);
      this.store.db.prepare('INSERT INTO deliveries VALUES(?,?,?,?,?)').run(id, id, input.email, code, this.store.now() + 1800);
      this.store.log(protocolId, actor.wallet, 'contact.requested'); this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    return { id, fingerprint: keccak256(key) };
  }
  pendingDeliveries() { return this.store.db.prepare('SELECT * FROM deliveries WHERE expires>?').all(this.store.now()) as Record<string, unknown>[]; }
  confirmContact(session: string, protocolId: string, id: string, code: string) {
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
    const actor = this.store.authorize(session, protocolId, true);
    const result = this.store.db.prepare(`UPDATE contacts SET verified=1 WHERE id=? AND protocol_id=? AND verified=0
      AND EXISTS(SELECT 1 FROM contact_challenges c WHERE c.id=contacts.id AND c.hash=? AND c.expires>=?)`).run(id, protocolId, digest(code), this.store.now());
    if (!result.changes) throw new Error('Contact confirmation failed');
    this.store.db.prepare('DELETE FROM contact_challenges WHERE id=?').run(id);
    this.store.db.prepare('DELETE FROM deliveries WHERE contact_id=?').run(id);
    this.store.log(protocolId, actor.wallet, 'contact.verified');
    this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  rotateContact(session: string, protocolId: string, id: string, publicKey: Hex) {
    const actor = this.store.authorize(session, protocolId, true), key = hex(publicKey, 32);
    const contact = record(this.store.db.prepare('SELECT email,key_version FROM contacts WHERE id=? AND protocol_id=? AND verified=1').get(id, protocolId));
    if (!contact) throw new Error('Contact unavailable');
    const version = Number(contact.key_version) + 1, code = randomBytes(32).toString('hex');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.db.prepare('INSERT INTO contact_rotations VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET key_version=excluded.key_version,public_key=excluded.public_key,hash=excluded.hash,expires=excluded.expires').run(id, version, key, digest(code), this.store.now() + 1800);
      this.store.db.prepare('INSERT INTO deliveries VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET code=excluded.code,expires=excluded.expires').run(id, id, String(contact.email), code, this.store.now() + 1800);
      this.store.log(protocolId, actor.wallet, 'contact.rotation.requested'); this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    return { contactId: id, keyVersion: version, fingerprint: keccak256(key) };
  }
  confirmRotation(session: string, protocolId: string, id: string, code: string) {
    const actor = this.store.authorize(session, protocolId, true);
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const rotation = record(this.store.db.prepare(`SELECT r.* FROM contact_rotations r JOIN contacts c ON c.id=r.id
        WHERE r.id=? AND c.protocol_id=? AND r.hash=? AND r.expires>=?`).get(id, protocolId, digest(code), this.store.now()));
      if (!rotation) throw new Error('Contact rotation confirmation failed');
      this.store.db.prepare('UPDATE contacts SET key_version=?,public_key=? WHERE id=? AND protocol_id=?').run(Number(rotation.key_version), String(rotation.public_key), id, protocolId);
      this.store.db.prepare('DELETE FROM contact_rotations WHERE id=?').run(id); this.store.db.prepare('DELETE FROM deliveries WHERE contact_id=?').run(id);
      this.store.log(protocolId, actor.wallet, 'contact.rotation.verified'); this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  directory(protocolId: string) {
    return (this.store.db.prepare(`SELECT c.id,c.key_version,c.public_key FROM contacts c JOIN protocols p ON p.id=c.protocol_id
      WHERE p.id=? AND p.enabled=1 AND c.verified=1`).all(protocolId) as Record<string, unknown>[]).map(c => ({
      contactId: String(c.id), keyVersion: Number(c.key_version), publicKey: String(c.public_key) as Hex, fingerprint: keccak256(String(c.public_key) as Hex) }));
  }
  contacts(session: string, protocolId: string) {
    const actor = this.store.authorize(session, protocolId); this.store.log(protocolId, actor.wallet, 'contacts.read');
    return this.store.db.prepare('SELECT id,email,key_version,public_key,verified FROM contacts WHERE protocol_id=?').all(protocolId);
  }
  async deliverNotice(contactId: string, input: unknown, encryptedAttachment?: unknown) {
    const notice = await verifyNotice(input);
    const attachment = encryptedAttachment === undefined ? undefined : await verifyAttachment(encryptedAttachment, notice.researcher, notice.reportId);
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      // Verification awaits browser-signature recovery. Re-read contact and
      // account state under the same write transaction as delivery.
      const contact = record(this.store.db.prepare(`SELECT c.* FROM contacts c JOIN protocols p ON p.id=c.protocol_id
        WHERE c.id=? AND c.verified=1 AND p.enabled=1`).get(contactId));
      if (!contact || notice.chainId !== this.store.chainId) throw new Error('Verified contact unavailable');
      if (attachment && (attachment.contactId !== contactId || attachment.keyVersion !== contact.key_version || attachment.publicKey !== contact.public_key)) throw new Error('Selected contact key changed; confirm again');
      const prior = record(this.store.db.prepare('SELECT notice,attachment FROM notices WHERE protocol_id=? AND report_id=?').get(String(contact.protocol_id), notice.reportId));
      if (prior) {
        if (prior.notice !== JSON.stringify(notice) || prior.attachment !== (attachment ? JSON.stringify(attachment) : null)) throw new Error('Conflicting notice delivery');
        this.store.db.exec('COMMIT'); return;
      }
      this.store.db.prepare('INSERT INTO notices VALUES(?,?,?,?,?,?)').run(String(contact.protocol_id), notice.reportId, contactId, JSON.stringify(notice), attachment ? JSON.stringify(attachment) : null, this.store.now() + this.retention);
      const existing = record(this.store.db.prepare('SELECT notice FROM public_notices WHERE report_id=?').get(notice.reportId));
      if (existing && existing.notice !== JSON.stringify(publicNotice(notice))) throw new Error('Conflicting notice for report');
      this.store.db.prepare('INSERT OR IGNORE INTO public_notices VALUES(?,?,?)').run(notice.reportId, JSON.stringify(publicNotice(notice)), Number(notice.window.t1));
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  list(session: string, protocolId: string, offset = 0) {
    const actor = this.store.authorize(session, protocolId); this.store.log(protocolId, actor.wallet, 'notices.read');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid offset');
    return (this.store.db.prepare('SELECT report_id,notice,attachment FROM notices WHERE protocol_id=? AND expires>? ORDER BY report_id LIMIT 50 OFFSET ?').all(protocolId, this.store.now(), offset) as Record<string, unknown>[]).map(n => ({ reportId: n.report_id, notice: JSON.parse(String(n.notice)), attachment: n.attachment ? JSON.parse(String(n.attachment)) : undefined }));
  }
  publicCopy(reportId: Hex): SignedNotice | undefined {
    const found = record(this.store.db.prepare('SELECT notice FROM public_notices WHERE report_id=? AND publish_at<=?').get(reportId, this.store.now()));
    return found ? JSON.parse(String(found.notice)) as SignedNotice : undefined;
  }
  removeNotice(session: string, protocolId: string, reportId: Hex) {
    const actor = this.store.authorize(session, protocolId, true);
    this.store.db.prepare('DELETE FROM notices WHERE protocol_id=? AND report_id=?').run(protocolId, reportId);
    this.store.log(protocolId, actor.wallet, 'notice.deleted');
  }
  export(session: string, protocolId: string) {
    const actor = this.store.authorize(session, protocolId, true); this.store.log(protocolId, actor.wallet, 'metadata.export');
    return { contacts: this.contacts(session, protocolId), notices: this.store.db.prepare('SELECT notice,attachment FROM notices WHERE protocol_id=?').all(protocolId),
      accessLog: this.store.db.prepare('SELECT wallet,action,at FROM access_log WHERE protocol_id=?').all(protocolId) };
  }
  purgeExpired() {
    for (const table of ['notices', 'deliveries', 'contact_challenges', 'contact_rotations', 'ownership_challenges', 'sessions', 'challenges']) {
      if (this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) this.store.db.prepare(`DELETE FROM ${table} WHERE expires<?`).run(this.store.now());
    }
    this.store.db.prepare('DELETE FROM access_log WHERE at<?').run(this.store.now() - this.retention);
  }
}
