import { triggerMarketAbi } from '@nillion/covenants-sdk';
import { getAddress, type Hex, type PublicClient, type WalletClient } from 'viem';
import { hex } from '../client/notice.mts';
import { PortalStore } from '../portal/store.mts';

interface KeeperPolicy { confirmations: bigint; blockSpan: bigint; alertAfterSecs: bigint }
export class Keeper {
  readonly store: PortalStore; readonly pub: PublicClient; readonly market: Hex; readonly firstBlock: bigint; readonly policy: KeeperPolicy;
  constructor(store: PortalStore, pub: PublicClient, market: Hex, firstBlock: bigint, policy: KeeperPolicy) {
    if (firstBlock < 0n || policy.confirmations < 1n || policy.blockSpan < 1n || policy.blockSpan > 1000n || policy.alertAfterSecs < 1n) throw new Error('Invalid keeper policy');
    this.store = store; this.pub = pub; this.market = getAddress(market); this.firstBlock = firstBlock; this.policy = policy;
    store.db.exec(`CREATE TABLE IF NOT EXISTS keeper_cursor(market TEXT PRIMARY KEY, block TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS watched_triggers(market TEXT NOT NULL, trigger_id TEXT NOT NULL, report_id TEXT NOT NULL, PRIMARY KEY(market,trigger_id));
      CREATE TABLE IF NOT EXISTS share_metadata(market TEXT NOT NULL, trigger_id TEXT NOT NULL, node TEXT NOT NULL, block TEXT NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, PRIMARY KEY(market,tx_hash,log_index));
      CREATE TABLE IF NOT EXISTS keeper_alerts(market TEXT NOT NULL, trigger_id TEXT NOT NULL, kind TEXT NOT NULL, source_block TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(market,trigger_id,kind));
      CREATE TABLE IF NOT EXISTS settlements(market TEXT NOT NULL, trigger_id TEXT NOT NULL, state TEXT NOT NULL, hash TEXT, PRIMARY KEY(market,trigger_id));`);
  }
  watch(triggerId: bigint, reportId: Hex) {
    if (triggerId < 0n) throw new Error('Invalid trigger'); hex(reportId, 32);
    this.store.db.prepare('INSERT OR IGNORE INTO watched_triggers VALUES(?,?,?)').run(this.market, String(triggerId), reportId);
  }
  resetCursorForRecovery() {
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.db.prepare('DELETE FROM keeper_cursor WHERE market=?').run(this.market);
      this.store.db.prepare('DELETE FROM share_metadata WHERE market=?').run(this.market);
      this.store.db.prepare('DELETE FROM keeper_alerts WHERE market=? AND delivered=0').run(this.market); this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  async tick() {
    if (await this.pub.getChainId() !== 11155111) throw new Error('Keeper requires Sepolia');
    const head = await this.pub.getBlock();
    if (head.number === null || head.baseFeePerGas === null || head.number < this.policy.confirmations) throw new Error('Confirmed chain head unavailable');
    const toBlock = head.number - this.policy.confirmations;
    let cursor = this.store.db.prepare('SELECT block,hash FROM keeper_cursor WHERE market=?').get(this.market) as Record<string, unknown> | undefined;
    if (cursor && (BigInt(String(cursor.block)) > toBlock || (await this.pub.getBlock({ blockNumber: BigInt(String(cursor.block)) })).hash !== cursor.hash)) {
      this.resetCursorForRecovery(); cursor = undefined;
    }
    const start = cursor ? BigInt(String(cursor.block)) + 1n : this.firstBlock;
    for (let from = start; from <= toBlock; from += this.policy.blockSpan) {
      const end = from + this.policy.blockSpan - 1n < toBlock ? from + this.policy.blockSpan - 1n : toBlock;
      const before = await this.pub.getBlock({ blockNumber: end });
      if (!before.hash) throw new Error('Archive checkpoint unavailable');
      const logs = await this.pub.getContractEvents({ address: this.market, abi: triggerMarketAbi, eventName: 'SharePosted', fromBlock: from, toBlock: end, strict: true });
      const checkpoint = await this.pub.getBlock({ blockNumber: end }); if (!checkpoint.hash) throw new Error('Archive checkpoint unavailable');
      if (before.hash !== checkpoint.hash) throw new Error('Archive changed during scan; retry from persisted cursor');
      for (const log of logs) {
        if (log.blockNumber === null || !log.blockHash || (await this.pub.getBlock({ blockNumber: log.blockNumber })).hash !== log.blockHash) throw new Error('Share log is not canonical');
      }
      if ((await this.pub.getBlock({ blockNumber: end })).hash !== checkpoint.hash) throw new Error('Archive changed during scan; retry from persisted cursor');
      this.store.db.exec('BEGIN IMMEDIATE');
      try {
        for (const log of logs) {
          if (log.removed || log.blockNumber === null || log.blockNumber < from || log.blockNumber > end || getAddress(log.address) !== this.market || !log.transactionHash || log.logIndex === null) throw new Error('Invalid archive share metadata');
          // Store identifiers only. Public share bytes and resolved plaintext
          // are deliberately excluded from the operational database.
          this.store.db.prepare('INSERT OR IGNORE INTO share_metadata VALUES(?,?,?,?,?,?)').run(this.market, String(log.args.triggerId), String(log.args.node), String(log.blockNumber), log.transactionHash, log.logIndex);
        }
        this.store.db.prepare('INSERT INTO keeper_cursor VALUES(?,?,?) ON CONFLICT(market) DO UPDATE SET block=excluded.block,hash=excluded.hash').run(this.market, String(end), checkpoint.hash); this.store.db.exec('COMMIT');
      } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    }
    const watched = this.store.db.prepare('SELECT trigger_id FROM watched_triggers WHERE market=?').all(this.market) as Record<string, unknown>[];
    for (const watch of watched) {
      const id = BigInt(String(watch.trigger_id)), meta = await this.pub.readContract({ address: this.market, abi: triggerMarketAbi, functionName: 'triggerMeta', args: [id] });
      const [,, m, expiry, t1,,, ceiling, resolved, firstShareAt] = meta;
      if (resolved || head.timestamp < t1) continue;
      const kinds: string[] = [];
      if (head.baseFeePerGas > ceiling) kinds.push('basefee-above-ceiling');
      if (!firstShareAt && head.timestamp >= t1 + this.policy.alertAfterSecs) kinds.push('no-shares');
      const count = (this.store.db.prepare('SELECT DISTINCT node FROM share_metadata WHERE market=? AND trigger_id=?').all(this.market, String(id))).length;
      if (firstShareAt && count < m && head.timestamp >= firstShareAt + this.policy.alertAfterSecs) kinds.push('committee-stalled');
      if (head.timestamp > expiry) kinds.push('expired-unsettled');
      for (const kind of kinds) this.store.db.prepare('INSERT OR IGNORE INTO keeper_alerts(market,trigger_id,kind,source_block) VALUES(?,?,?,?)').run(this.market, String(id), kind, String(head.number));
    }
  }
  alerts() { return this.store.db.prepare('SELECT trigger_id AS triggerId,kind,source_block AS sourceBlock FROM keeper_alerts WHERE market=? AND delivered=0').all(this.market) as Record<string, unknown>[]; }
  async settle(triggerId: bigint, wallet: WalletClient, explicitWriteAuthorization: boolean) {
    if (!explicitWriteAuthorization) throw new Error('Settlement needs explicit Sepolia write authorization');
    if (await this.pub.getChainId() !== 11155111 || wallet.chain?.id !== 11155111 || !wallet.account) throw new Error('Settlement signer requires Sepolia');
    const meta = await this.pub.readContract({ address: this.market, abi: triggerMarketAbi, functionName: 'triggerMeta', args: [triggerId] });
    if ((await this.pub.getBlock()).timestamp <= meta[3] || meta[8]) throw new Error('Trigger is not expired unrevealed');
    const existing = this.store.db.prepare('SELECT state FROM settlements WHERE market=? AND trigger_id=?').get(this.market, String(triggerId));
    if (existing) throw new Error('Settlement already attempted; reconcile before retry');
    const simulation = await this.pub.simulateContract({ address: this.market, abi: triggerMarketAbi, functionName: 'settleExpired', args: [triggerId], account: wallet.account });
    this.store.db.prepare('INSERT INTO settlements VALUES(?,?,?,NULL)').run(this.market, String(triggerId), 'unknown');
    const hash = await wallet.writeContract({ ...simulation.request, account: wallet.account, chain: wallet.chain });
    this.store.db.prepare("UPDATE settlements SET state='submitted',hash=? WHERE market=? AND trigger_id=?").run(hash, this.market, String(triggerId));
    const receipt = await this.pub.waitForTransactionReceipt({ hash });
    this.store.db.prepare('UPDATE settlements SET state=? WHERE market=? AND trigger_id=?').run(receipt.status === 'success' ? 'confirmed' : 'reverted', this.market, String(triggerId));
    if (receipt.status !== 'success') throw new Error('Expiry settlement reverted');
    return { hash, block: receipt.blockNumber };
  }
}
