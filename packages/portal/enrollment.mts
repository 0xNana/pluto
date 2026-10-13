import { resolveTxt } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import { PortalStore, digest } from './store.mts';

export class ProtocolEnrollment {
  readonly store: PortalStore;
  readonly resolver: typeof resolveTxt;
  constructor(store: PortalStore, resolver: typeof resolveTxt = resolveTxt) {
    this.store = store; this.resolver = resolver;
    store.db.exec('CREATE TABLE IF NOT EXISTS ownership_challenges(id TEXT PRIMARY KEY, wallet TEXT NOT NULL, domain TEXT NOT NULL, value TEXT NOT NULL, expires INTEGER NOT NULL)');
  }
  request(session: string, domain: string) {
    const wallet = this.store.sessionWallet(session);
    if (domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new Error('Invalid protocol domain');
    if (this.store.db.prepare('SELECT id FROM protocols WHERE id=?').get(domain)) throw new Error('Protocol already enrolled');
    this.store.db.prepare('DELETE FROM ownership_challenges WHERE expires<?').run(this.store.now());
    if ((this.store.db.prepare('SELECT id FROM ownership_challenges WHERE wallet=?').all(wallet)).length >= 5) throw new Error('Too many ownership challenges');
    const id = randomBytes(32).toString('hex'), value = 'pluto-v1:' + digest(`${this.store.origin}\n${domain}\n${wallet}\n${id}`);
    this.store.db.prepare('INSERT INTO ownership_challenges VALUES(?,?,?,?,?)').run(id, wallet, domain, value, this.store.now() + 1800);
    return { id, name: '_pluto-verification.' + domain, value, expires: this.store.now() + 1800 };
  }
  async confirm(session: string, id: string) {
    const wallet = this.store.sessionWallet(session);
    const proof = this.store.db.prepare('SELECT * FROM ownership_challenges WHERE id=? AND wallet=? AND expires>=?').get(id, wallet, this.store.now()) as Record<string, unknown> | undefined;
    if (!proof) throw new Error('Ownership proof unavailable');
    let records: string[][];
    try { records = await this.resolver('_pluto-verification.' + String(proof.domain)); }
    catch { throw new Error('Ownership proof lookup failed'); }
    if (!records.some(parts => parts.join('') === proof.value)) throw new Error('Ownership proof unavailable');
    // Recheck authorization and expiration after network I/O; enrollment's
    // unique domain constraint resolves concurrent claims without replacement.
    this.store.sessionWallet(session);
    if (Number(proof.expires) < this.store.now()) throw new Error('Ownership proof expired');
    this.store.enrollVerifiedProtocol(String(proof.domain), wallet);
    this.store.db.prepare('DELETE FROM ownership_challenges WHERE id=?').run(id);
    this.store.log(String(proof.domain), wallet, 'protocol.enrolled');
    return { protocolId: String(proof.domain) };
  }
}
