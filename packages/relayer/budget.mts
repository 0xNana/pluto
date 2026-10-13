import { getAddress, keccak256, toHex, type Hex, type PublicClient } from 'viem';
import { finalizedCosts, finalizedEscrow, type LedgerChain } from './receipts.mts';
import { hex } from '../client/notice.mts';
import { PortalStore } from '../portal/store.mts';
import { randomUUID } from 'node:crypto';

interface Limits { ethWei: bigint; nilUnits: bigint; perPostWei: bigint; perPostNil: bigint }
interface Intent { id: Hex; requestHash: Hex; author: Hex; nonce: string; ethWei: bigint; nilUnits: bigint }
export interface FundingSnapshot { payer: Hex; market: Hex; nil: Hex; ethWei: bigint; nilUnits: bigint; blockNumber: bigint; blockHash: Hex }
const row = (value: unknown) => value as Record<string, unknown> | undefined;
const amount = (value: bigint) => { if (typeof value !== 'bigint' || value < 0n || value >= 1n << 256n) throw new Error('Invalid budget amount'); return String(value); };
const contextHash = (chain: LedgerChain) => keccak256(toHex(JSON.stringify({ chainId: 11155111, payer: getAddress(chain.payer), market: getAddress(chain.market), nil: getAddress(chain.nil), registry: getAddress(chain.registry), abi: chain.registryAbi })));
const validAction = (action: string) => ['approve', 'register', 'post', 'post:1', 'bind'].includes(action) || /^bind:[1-9][0-9]?$/.test(action);
export class SponsorBudget {
  readonly store: PortalStore;
  readonly #authority: symbol;
  constructor(store: PortalStore, authority: symbol) {
    if (typeof authority !== 'symbol') throw new Error('Trusted server authority required');
    if (store.chainId !== 11155111) throw new Error('Sponsor ledger requires a Sepolia portal context');
    this.#authority = authority;
    this.store = store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS budgets(protocol_id TEXT PRIMARY KEY REFERENCES protocols(id), eth TEXT NOT NULL, nil TEXT NOT NULL, reserved_eth TEXT NOT NULL DEFAULT '0', reserved_nil TEXT NOT NULL DEFAULT '0', per_post_eth TEXT NOT NULL, per_post_nil TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY, protocol_id TEXT NOT NULL REFERENCES protocols(id), request_hash TEXT NOT NULL, author TEXT NOT NULL, nonce TEXT NOT NULL, eth TEXT NOT NULL, nil TEXT NOT NULL, state TEXT NOT NULL, spent_eth TEXT, spent_nil TEXT, refundable_eth TEXT, UNIQUE(author,nonce));
      CREATE TABLE IF NOT EXISTS submitted_transactions(intent_id TEXT NOT NULL REFERENCES intents(id), action TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, PRIMARY KEY(intent_id,action));`);
    store.db.exec(`CREATE TABLE IF NOT EXISTS transaction_attempts(intent_id TEXT NOT NULL REFERENCES intents(id), action TEXT NOT NULL, destination TEXT NOT NULL, data_hash TEXT NOT NULL, value TEXT NOT NULL, gas_units TEXT NOT NULL, max_fee TEXT NOT NULL, nil_units TEXT NOT NULL, PRIMARY KEY(intent_id,action));
      CREATE TABLE IF NOT EXISTS ledger_context(intent_id TEXT PRIMARY KEY REFERENCES intents(id), fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS closed_submissions(intent_id TEXT PRIMARY KEY REFERENCES intents(id));
      CREATE TABLE IF NOT EXISTS finalized_attempts(intent_id TEXT NOT NULL REFERENCES intents(id), action TEXT NOT NULL, hash TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(intent_id,action));
      CREATE TABLE IF NOT EXISTS escrow_holds(intent_id TEXT PRIMARY KEY REFERENCES intents(id), trigger_id TEXT NOT NULL, post_block TEXT NOT NULL, deposit TEXT NOT NULL, finalized INTEGER NOT NULL DEFAULT 0);`);
    store.db.exec('CREATE TABLE IF NOT EXISTS reconciliation_claims(intent_id TEXT PRIMARY KEY REFERENCES intents(id), token TEXT NOT NULL)');
    store.db.exec('CREATE TABLE IF NOT EXISTS payer_pool(id INTEGER PRIMARY KEY CHECK(id=1), fingerprint TEXT NOT NULL, block TEXT NOT NULL, hash TEXT NOT NULL)');
    const columns = store.db.prepare('PRAGMA table_info(transaction_attempts)').all() as Record<string, unknown>[];
    if (!['gas_units', 'max_fee', 'nil_units'].every(name => columns.some(column => column.name === name))) throw new Error('Legacy sponsor ledger requires an explicit migration before use');
  }
  #trusted(authority: symbol) { if (authority !== this.#authority) throw new Error('Invalid server authority'); }
  configure(session: string, protocolId: string, limits: Limits, funded?: () => { ethWei: bigint; nilUnits: bigint }) {
    Object.values(limits).forEach(amount);
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const actor = this.store.authorize(session, protocolId, true);
      if (funded) { const ceiling = funded(); if (limits.ethWei > ceiling.ethWei || limits.nilUnits > ceiling.nilUnits) throw new Error('Budget exceeds verified customer funds'); }
      const existing = row(this.store.db.prepare('SELECT * FROM budgets WHERE protocol_id=?').get(protocolId));
      if (existing && (limits.ethWei < BigInt(String(existing.reserved_eth)) || limits.nilUnits < BigInt(String(existing.reserved_nil)))) throw new Error('Budget below current reservations');
      this.store.db.prepare(`INSERT INTO budgets(protocol_id,eth,nil,per_post_eth,per_post_nil) VALUES(?,?,?,?,?)
        ON CONFLICT(protocol_id) DO UPDATE SET eth=excluded.eth,nil=excluded.nil,per_post_eth=excluded.per_post_eth,per_post_nil=excluded.per_post_nil`).run(protocolId, ...[limits.ethWei, limits.nilUnits, limits.perPostWei, limits.perPostNil].map(amount));
      this.store.log(protocolId, actor.wallet, 'budget.configured'); this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  summary(session: string, protocolId: string) {
    const actor = this.store.authorize(session, protocolId); this.store.log(protocolId, actor.wallet, 'budget.read');
    return this.store.db.prepare('SELECT * FROM budgets WHERE protocol_id=?').get(protocolId);
  }
  reserve(authority: symbol, protocolId: string, input: Intent, pool: FundingSnapshot) {
    this.#trusted(authority);
    hex(input.id, 32); hex(input.requestHash, 32); const author = getAddress(input.author);
    if (!/^(0|[1-9][0-9]{0,77})$/.test(input.nonce) || BigInt(input.nonce) >= 1n << 256n) throw new Error('Invalid sponsor nonce');
    amount(input.ethWei); amount(input.nilUnits);
    if (!pool) throw new Error('Live payer pool snapshot required');
    amount(pool.ethWei); amount(pool.nilUnits); amount(pool.blockNumber); hex(pool.blockHash, 32);
    const fingerprint = keccak256(toHex(JSON.stringify({ chainId: this.store.chainId, payer: getAddress(pool.payer), market: getAddress(pool.market), nil: getAddress(pool.nil) })));
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = row(this.store.db.prepare('SELECT * FROM intents WHERE id=?').get(input.id));
      if (existing) {
        if (existing.protocol_id !== protocolId || existing.request_hash !== input.requestHash || existing.author !== author || existing.nonce !== input.nonce || existing.eth !== String(input.ethWei) || existing.nil !== String(input.nilUnits)) throw new Error('Reservation terms changed');
        this.store.db.exec('COMMIT'); return this.intent(this.#authority, input.id);
      }
      if (this.store.db.prepare('SELECT id FROM intents WHERE author=? AND nonce=?').get(author, input.nonce)) throw new Error('Sponsor nonce already reserved');
      const protocol = row(this.store.db.prepare('SELECT enabled FROM protocols WHERE id=?').get(protocolId));
      if (!protocol?.enabled) throw new Error('Sponsor disabled');
      const budget = row(this.store.db.prepare('SELECT * FROM budgets WHERE protocol_id=?').get(protocolId));
      if (!budget || input.ethWei > BigInt(String(budget.per_post_eth)) || input.nilUnits > BigInt(String(budget.per_post_nil))
          || input.ethWei + BigInt(String(budget.reserved_eth)) > BigInt(String(budget.eth)) || input.nilUnits + BigInt(String(budget.reserved_nil)) > BigInt(String(budget.nil))) throw new Error('Insufficient sponsor budget');
      const existingPool = row(this.store.db.prepare('SELECT * FROM payer_pool WHERE id=1').get());
      if (existingPool && (existingPool.fingerprint !== fingerprint || BigInt(String(existingPool.block)) > pool.blockNumber || (BigInt(String(existingPool.block)) === pool.blockNumber && existingPool.hash !== pool.blockHash))) throw new Error('Payer pool context or snapshot mismatch');
      if (!existingPool && this.store.db.prepare('SELECT id FROM intents LIMIT 1').get()) throw new Error('Unscoped payer pool requires explicit migration');
      const held = this.store.db.prepare('SELECT reserved_eth,reserved_nil FROM budgets').all() as Record<string, unknown>[];
      const totalEth = held.reduce((sum, budget) => sum + BigInt(String(budget.reserved_eth)), 0n);
      const totalNil = held.reduce((sum, budget) => sum + BigInt(String(budget.reserved_nil)), 0n);
      // Count even posted/unreconciled exposure conservatively. Funds already
      // spent can be counted twice until reconciliation; this reduces capacity
      // but never permits two tenants to promise the same pooled funds.
      if (totalEth + input.ethWei > pool.ethWei || totalNil + input.nilUnits > pool.nilUnits) throw new Error('Insufficient live payer pool funds');
      this.store.db.prepare('INSERT INTO payer_pool VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET block=excluded.block,hash=excluded.hash').run(fingerprint, String(pool.blockNumber), pool.blockHash);
      this.store.db.prepare('INSERT INTO intents(id,protocol_id,request_hash,author,nonce,eth,nil,state) VALUES(?,?,?,?,?,?,?,?)').run(input.id, protocolId, input.requestHash, author, input.nonce, amount(input.ethWei), amount(input.nilUnits), 'reserved');
      this.store.db.prepare('UPDATE budgets SET reserved_eth=?,reserved_nil=? WHERE protocol_id=?').run(String(BigInt(String(budget.reserved_eth)) + input.ethWei), String(BigInt(String(budget.reserved_nil)) + input.nilUnits), protocolId);
      this.store.db.exec('COMMIT'); return this.intent(this.#authority, input.id);
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  intent(authority: symbol, id: Hex) {
    this.#trusted(authority);
    const result = row(this.store.db.prepare('SELECT * FROM intents WHERE id=?').get(id));
    if (!result) throw new Error('Unknown reservation');
    return { ...result, eth: String(result.eth), nil: String(result.nil), author: String(result.author), spent_eth: String(result.spent_eth ?? '0'), protocolId: String(result.protocol_id), state: String(result.state), transactions: this.store.db.prepare('SELECT action,hash FROM submitted_transactions WHERE intent_id=?').all(id) };
  }
  begin(authority: symbol, id: Hex) {
    this.#trusted(authority);
    // Unknown before calling a sender: crash/timeout must never cause an automatic repost.
    if (!this.store.db.prepare(`UPDATE intents SET state='unknown' WHERE id=? AND state='reserved'
      AND EXISTS(SELECT 1 FROM protocols p WHERE p.id=intents.protocol_id AND p.enabled=1)`).run(id).changes) {
      const reservation = this.intent(this.#authority, id);
      const protocol = row(this.store.db.prepare('SELECT enabled FROM protocols WHERE id=?').get(reservation.protocolId));
      if (!protocol?.enabled) throw new Error('Sponsor disabled');
      throw new Error('Submission already attempted');
    }
  }
  startAction(authority: symbol, id: Hex, action: string, call: { to: Hex; data: Hex; value: bigint; gasUnits: bigint; maxFeePerGas: bigint; nilUnits: bigint }) {
    this.#trusted(authority); amount(call.value); amount(call.gasUnits); amount(call.maxFeePerGas);
    amount(call.nilUnits);
    if (call.gasUnits === 0n || call.maxFeePerGas === 0n) throw new Error('Live gas bounds required');
    if (!validAction(action)) throw new Error('Invalid transaction action');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const intent = this.intent(this.#authority, id);
      if (!['unknown', 'submitted'].includes(intent.state)) throw new Error('Submission state mismatch');
      const enabled = row(this.store.db.prepare('SELECT enabled FROM protocols WHERE id=?').get(intent.protocolId));
      // Completing the binding of an already funded trigger remains permitted:
      // account disablement must never suppress that report's disclosure.
      if (!enabled?.enabled && (!action.startsWith('bind') || !this.store.db.prepare("SELECT hash FROM submitted_transactions WHERE intent_id=? AND action LIKE 'post%'").get(id))) throw new Error('Sponsor disabled');
      if (call.nilUnits > BigInt(intent.nil) || (!action.startsWith('post') && call.nilUnits !== 0n)) throw new Error('Transaction exceeds reserved NIL ceiling');
      if (action === 'post:1') {
        const proof = row(this.store.db.prepare("SELECT status FROM finalized_attempts WHERE intent_id=? AND action='post'").get(id));
        if (proof?.status !== 'reverted') throw new Error('Post retry requires a verified final revert');
      }
      if (action.startsWith('bind:')) {
        const previous = Number(action.slice(5)) - 1, priorAction = previous ? `bind:${previous}` : 'bind';
        const proof = row(this.store.db.prepare('SELECT status FROM finalized_attempts WHERE intent_id=? AND action=?').get(id, priorAction));
        if (proof?.status !== 'reverted') throw new Error('Binding retry requires a verified final revert');
      }
      const prior = this.store.db.prepare(`SELECT a.value,a.gas_units,a.max_fee,f.status FROM transaction_attempts a
        LEFT JOIN finalized_attempts f ON f.intent_id=a.intent_id AND f.action=a.action WHERE a.intent_id=?`).all(id) as Record<string, unknown>[];
      // A proved reverted call spent gas but transferred no ETH. Retain its
      // entire gas cap; a retry may reuse only its unspent escrow capacity.
      const exposure = prior.reduce((sum, a) => sum + (a.status === 'reverted' ? 0n : BigInt(String(a.value))) + BigInt(String(a.gas_units)) * BigInt(String(a.max_fee)), 0n);
      if (exposure + call.value + call.gasUnits * call.maxFeePerGas > BigInt(String(intent.eth))) throw new Error('Transaction exceeds reserved spending ceiling');
      this.store.db.prepare('INSERT INTO transaction_attempts VALUES(?,?,?,?,?,?,?,?)').run(id, action, getAddress(call.to), keccak256(call.data), amount(call.value), amount(call.gasUnits), amount(call.maxFeePerGas), amount(call.nilUnits));
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  recordHash(authority: symbol, id: Hex, action: string, hash: Hex) {
    this.#trusted(authority);
    hex(hash, 32);
    if (!validAction(action)) throw new Error('Invalid transaction action');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const intent = this.intent(this.#authority, id); if (!['unknown', 'submitted', 'closing'].includes(intent.state)) throw new Error('Submission state mismatch');
      if (!this.store.db.prepare('SELECT action FROM transaction_attempts WHERE intent_id=? AND action=?').get(id, action)) throw new Error('Transaction attempt must be persisted before broadcast');
      this.store.db.prepare('INSERT INTO submitted_transactions VALUES(?,?,?)').run(id, action, hash);
      this.store.db.prepare("UPDATE intents SET state=CASE WHEN state='closing' THEN state ELSE 'submitted' END WHERE id=?").run(id); this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  async provePostRevert(authority: symbol, id: Hex, pub: PublicClient, chain: LedgerChain) {
    this.#trusted(authority);
    let attempt: Record<string, unknown>, author: Hex;
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const intent = this.intent(this.#authority, id); author = intent.author as Hex;
      if (intent.state !== 'submitted' || this.store.db.prepare("SELECT action FROM transaction_attempts WHERE intent_id=? AND action='post:1'").get(id)) throw new Error('Post retry unavailable or already claimed');
      const saved = row(this.store.db.prepare(`SELECT a.*,t.hash FROM transaction_attempts a JOIN submitted_transactions t
        ON t.intent_id=a.intent_id AND t.action=a.action WHERE a.intent_id=? AND a.action='post'`).get(id));
      if (!saved) throw new Error('Post hash unresolved; reservation retained');
      attempt = saved;
      const context = row(this.store.db.prepare('SELECT fingerprint FROM ledger_context WHERE intent_id=?').get(id));
      if (context && context.fingerprint !== contextHash(chain)) throw new Error('Ledger chain context mismatch');
      if (!context) this.store.db.prepare('INSERT INTO ledger_context VALUES(?,?)').run(id, contextHash(chain));
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    const costs = await finalizedCosts(pub, chain, author, [attempt], true);
    if (costs.outcomes[0]?.status !== 'reverted' || costs.triggerId !== undefined || costs.nilSpentUnits !== 0n) throw new Error('Post retry requires a verified final revert');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const intent = this.intent(this.#authority, id);
      if (intent.state !== 'submitted' || this.store.db.prepare("SELECT action FROM transaction_attempts WHERE intent_id=? AND action='post:1'").get(id)) throw new Error('Post retry unavailable or already claimed');
      this.store.db.prepare('INSERT OR REPLACE INTO finalized_attempts VALUES(?,?,?,?)').run(id, 'post', String(attempt.hash), 'reverted');
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  closeSubmission(authority: symbol, id: Hex) {
    this.#trusted(authority);
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const intent = this.intent(this.#authority, id);
      if (!['reserved', 'unknown', 'submitted', 'closing'].includes(intent.state)) throw new Error('Submission cannot be closed');
      const unresolved = this.store.db.prepare(`SELECT t.hash FROM submitted_transactions t LEFT JOIN finalized_attempts f
        ON f.intent_id=t.intent_id AND f.action=t.action WHERE t.intent_id=? AND t.action LIKE 'post%'
        AND (f.status IS NULL OR f.status!='reverted') LIMIT 1`).get(id);
      if (unresolved) throw new Error('Funded or unresolved post must retain binding capacity');
      this.store.db.prepare('INSERT OR IGNORE INTO closed_submissions VALUES(?)').run(id);
      this.store.db.prepare("UPDATE intents SET state='closing' WHERE id=?").run(id); this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  async reconcile(authority: symbol, id: Hex, pub: PublicClient, chain: LedgerChain) {
    this.#trusted(authority);
    const current = this.intent(this.#authority, id);
    if (['confirmed', 'failed'].includes(current.state)) return current;
    let attempts: Record<string, unknown>[];
    let interrupted = false;
    const token = randomUUID();
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const locked = this.intent(this.#authority, id);
      if (['confirmed', 'failed'].includes(locked.state)) { this.store.db.exec('COMMIT'); return locked; }
      attempts = this.store.db.prepare(`SELECT a.*,t.hash FROM transaction_attempts a LEFT JOIN submitted_transactions t
        ON t.intent_id=a.intent_id AND t.action=a.action WHERE a.intent_id=?`).all(id) as Record<string, unknown>[];
      interrupted = !!this.store.db.prepare('SELECT intent_id FROM closed_submissions WHERE intent_id=?').get(id);
      if (!['submitted', 'closing', 'reconciling'].includes(locked.state) || (!interrupted && !['register', 'post'].every(action => attempts.some(a => String(a.action).split(':')[0] === action))) || attempts.some(a => !a.hash)) throw new Error('Submission incomplete or unresolved');
      const context = row(this.store.db.prepare('SELECT fingerprint FROM ledger_context WHERE intent_id=?').get(id));
      if (context && context.fingerprint !== contextHash(chain)) throw new Error('Ledger chain context mismatch');
      if (!context) this.store.db.prepare('INSERT INTO ledger_context VALUES(?,?)').run(id, contextHash(chain));
      this.store.db.prepare("UPDATE intents SET state='reconciling' WHERE id=? AND state IN ('submitted','closing')").run(id);
      this.store.db.prepare('INSERT INTO reconciliation_claims VALUES(?,?) ON CONFLICT(intent_id) DO UPDATE SET token=excluded.token').run(id, token);
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    const costs = await finalizedCosts(pub, chain, String(current.author) as Hex, attempts, interrupted);
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const intent = row(this.store.db.prepare('SELECT * FROM intents WHERE id=?').get(id));
      if (intent && ['confirmed', 'failed'].includes(String(intent.state))) { this.store.db.exec('COMMIT'); return this.intent(this.#authority, id); }
      if ((row(this.store.db.prepare('SELECT token FROM reconciliation_claims WHERE intent_id=?').get(id)))?.token !== token) throw new Error('Reconciliation superseded; reservation retained');
      if (!intent || intent.state !== 'reconciling' || costs.ethSpentWei + costs.refundableWei > BigInt(String(intent.eth)) || costs.nilSpentUnits > BigInt(String(intent.nil))) throw new Error('Invalid reconciliation; reservation retained');
      for (const outcome of costs.outcomes) this.store.db.prepare('INSERT OR REPLACE INTO finalized_attempts VALUES(?,?,?,?)').run(id, outcome.action, outcome.hash, outcome.status);
      if (costs.triggerId !== undefined && !costs.bindingSucceeded) {
        this.store.db.prepare("UPDATE intents SET state='submitted' WHERE id=?").run(id);
        this.store.db.exec('COMMIT'); return { ...this.intent(this.#authority, id), pendingBinding: true, triggerId: costs.triggerId,
          postHash: costs.outcomes.find(outcome => outcome.action.startsWith('post') && outcome.status === 'success')!.hash };
      }
      const budget = row(this.store.db.prepare('SELECT * FROM budgets WHERE protocol_id=?').get(String(intent.protocol_id)));
      if (!budget) throw new Error('Missing budget');
      // Refundable escrow remains reserved until a verified refund is received.
      this.store.db.prepare('UPDATE budgets SET eth=?,nil=?,reserved_eth=?,reserved_nil=? WHERE protocol_id=?').run(String(BigInt(String(budget.eth)) - costs.ethSpentWei), String(BigInt(String(budget.nil)) - costs.nilSpentUnits), String(BigInt(String(budget.reserved_eth)) - BigInt(String(intent.eth)) + costs.refundableWei), String(BigInt(String(budget.reserved_nil)) - BigInt(String(intent.nil))), String(intent.protocol_id));
      this.store.db.prepare('UPDATE intents SET state=?,spent_eth=?,spent_nil=?,refundable_eth=? WHERE id=?').run(interrupted || (costs.reverted && !costs.bindingSucceeded) ? 'failed' : 'confirmed', amount(costs.ethSpentWei), amount(costs.nilSpentUnits), amount(costs.refundableWei), id);
      if (costs.triggerId !== undefined) this.store.db.prepare('INSERT INTO escrow_holds VALUES(?,?,?,?,0)').run(id, String(costs.triggerId), String(costs.postBlock), amount(costs.refundableWei));
      this.store.db.exec('COMMIT');
      return this.intent(this.#authority, id);
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  async finalizeEscrow(authority: symbol, id: Hex, pub: PublicClient, chain: LedgerChain) {
    this.#trusted(authority);
    const context = row(this.store.db.prepare('SELECT fingerprint FROM ledger_context WHERE intent_id=?').get(id));
    if (!context || context.fingerprint !== contextHash(chain)) throw new Error('Ledger chain context mismatch');
    const hold = row(this.store.db.prepare('SELECT * FROM escrow_holds WHERE intent_id=?').get(id));
    if (!hold) throw new Error('Missing escrow hold');
    if (hold.finalized) return;
    const spent = await finalizedEscrow(pub, chain, BigInt(String(hold.trigger_id)), BigInt(String(hold.post_block)), BigInt(String(hold.deposit)));
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const refreshed = row(this.store.db.prepare('SELECT finalized FROM escrow_holds WHERE intent_id=?').get(id));
      if (!refreshed?.finalized) {
        const intent = this.intent(this.#authority, id), budget = row(this.store.db.prepare('SELECT * FROM budgets WHERE protocol_id=?').get(intent.protocolId));
        if (!budget) throw new Error('Missing budget');
        const deposit = BigInt(String(hold.deposit));
        this.store.db.prepare('UPDATE budgets SET eth=?,reserved_eth=? WHERE protocol_id=?').run(String(BigInt(String(budget.eth)) - spent), String(BigInt(String(budget.reserved_eth)) - deposit), intent.protocolId);
        this.store.db.prepare('UPDATE intents SET spent_eth=?,refundable_eth=\'0\' WHERE id=?').run(String(BigInt(String(intent.spent_eth)) + spent), id);
        this.store.db.prepare('UPDATE escrow_holds SET finalized=1 WHERE intent_id=?').run(id);
      }
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
}
