import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, constants, lstatSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { getAddress, recoverMessageAddress, type Hex } from 'viem';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('hex');
const row = (value: unknown) => value === undefined ? undefined : value as Record<string, unknown>;
export class PortalStore {
  readonly db: DatabaseSync;
  readonly origin: string;
  readonly chainId: number;
  readonly now: () => number;
  constructor(path: string, origin: string, chainId: number, now = () => Math.floor(Date.now() / 1000)) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin || ![1, 11155111].includes(chainId)) throw new Error('Invalid portal origin or chain');
    this.origin = origin;
    this.chainId = chainId; this.now = now;
    const parent = lstatSync(dirname(path));
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077)) throw new Error('Portal data directory must be private');
    const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); closeSync(fd);
    const file = lstatSync(path);
    if (!file.isFile() || (file.mode & 0o077)) throw new Error('Portal database must be private');
    chmodSync(path, 0o600);
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS portal_context(id INTEGER PRIMARY KEY CHECK(id=1), origin TEXT NOT NULL, chain_id INTEGER NOT NULL)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const context = row(this.db.prepare('SELECT * FROM portal_context WHERE id=1').get());
      if (context && (context.origin !== origin || context.chain_id !== chainId)) throw new Error('Portal database context mismatch');
      if (!context) {
        if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get()) throw new Error('Unscoped portal database requires explicit migration');
        this.db.prepare('INSERT INTO portal_context VALUES(1,?,?)').run(origin, chainId);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS protocols(id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS staff(protocol_id TEXT REFERENCES protocols(id), wallet TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(protocol_id,wallet));
      CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY, wallet TEXT NOT NULL, message TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, wallet TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS access_log(id INTEGER PRIMARY KEY, protocol_id TEXT NOT NULL, wallet TEXT NOT NULL, action TEXT NOT NULL, at INTEGER NOT NULL);
    `);
  }
  close() { this.db.close(); }
  // Internal enrollment boundary: call only after a verified domain-ownership proof.
  enrollVerifiedProtocol(protocolId: string, wallet: Hex) {
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(protocolId)) throw new Error('Invalid protocol domain');
    const address = getAddress(wallet);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO protocols(id) VALUES(?)').run(protocolId);
      this.db.prepare("INSERT INTO staff VALUES(?,?,'admin')").run(protocolId, address);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  challenge(wallet: Hex): { id: string; message: string } {
    const address = getAddress(wallet), id = token(), expires = this.now() + 300;
    this.db.prepare('DELETE FROM challenges WHERE expires<?').run(this.now());
    const count = row(this.db.prepare('SELECT count(*) AS n FROM challenges WHERE wallet=? AND used=0').get(address));
    if (Number(count?.n) >= 5) throw new Error('Too many authentication challenges');
    const message = `Pluto protocol portal\nOrigin: ${this.origin}\nChain: ${this.chainId}\nWallet: ${address}\nNonce: ${id}\nExpires: ${expires}\nThis authenticates portal access only. No transaction or disclosure changes.`;
    this.db.prepare('INSERT INTO challenges(id,wallet,message,expires) VALUES(?,?,?,?)').run(id, address, message, expires);
    return { id, message };
  }
  async authenticate(id: string, signature: Hex): Promise<string> {
    const challenge = row(this.db.prepare('SELECT * FROM challenges WHERE id=? AND used=0 AND expires>=?').get(id, this.now()));
    if (!challenge || getAddress(await recoverMessageAddress({ message: String(challenge.message), signature })) !== challenge.wallet) throw new Error('Authentication failed');
    const result = this.db.prepare('UPDATE challenges SET used=1 WHERE id=? AND used=0 AND expires>=?').run(id, this.now());
    if (!result.changes) throw new Error('Authentication failed');
    const value = token();
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(value), String(challenge.wallet), this.now() + 3600);
    return value;
  }
  authorize(session: string, protocolId: string, admin = false): { protocolId: string; wallet: string; role: string } {
    const actor = row(this.db.prepare(`SELECT s.wallet,m.role FROM sessions s JOIN staff m ON m.wallet=s.wallet
      JOIN protocols p ON p.id=m.protocol_id WHERE s.hash=? AND s.expires>? AND p.enabled=1 AND p.id=?`).get(digest(session), this.now(), protocolId));
    if (!actor || (admin && actor.role !== 'admin')) throw new Error('Not authorized');
    return { protocolId, wallet: String(actor.wallet), role: String(actor.role) };
  }
  log(protocolId: string, wallet: string, action: string) {
    this.db.prepare('INSERT INTO access_log(protocol_id,wallet,action,at) VALUES(?,?,?,?)').run(protocolId, wallet, action, this.now());
  }
  account(session: string, protocolId: string) {
    const actor = this.authorize(session, protocolId); this.log(protocolId, actor.wallet, 'account.read'); return actor;
  }
  setEnabled(session: string, protocolId: string, enabled: boolean) {
    const actor = this.authorize(session, protocolId, true);
    this.db.prepare('UPDATE protocols SET enabled=? WHERE id=?').run(enabled ? 1 : 0, protocolId);
    this.log(protocolId, actor.wallet, enabled ? 'account.enabled' : 'account.disabled');
  }
  logout(session: string) { this.db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(session)); }
  sessionInfo(session: string): { authenticated: false } | { authenticated: true; wallet: Hex; chainId: number; expires: number } {
    const actor = row(this.db.prepare('SELECT wallet,expires FROM sessions WHERE hash=? AND expires>?').get(digest(session), this.now()));
    return actor ? { authenticated: true, wallet: String(actor.wallet) as Hex, chainId: this.chainId, expires: Number(actor.expires) } : { authenticated: false };
  }
  sessionWallet(session: string): Hex {
    const actor = this.sessionInfo(session);
    if (!actor.authenticated) throw new Error('Not authorized');
    return actor.wallet;
  }
}
