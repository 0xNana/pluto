import { decodeFunctionData, getAddress, parseEventLogs, type Hex, type PublicClient } from 'viem';
import { nilAbi } from '@nillion/covenants-sdk';
import { PortalStore } from '../portal/store.mts';
import { resolveSepolia } from '../../src/chain/deployment.mjs';
import { hex } from '../client/notice.mts';
import { uint } from '../client/sponsor-wire.mts';

// Credits are actual inbound customer funds, separate from configurable spending
// limits. The pooled payer balance remains a second admission check in the ledger.
export class SponsorFunding {
  readonly store: PortalStore; readonly pub: PublicClient; readonly payer: Hex; readonly market: Hex;
  constructor(store: PortalStore, pub: PublicClient, payer: Hex, market: Hex) {
    if (store.chainId !== 11155111) throw new Error('Funding requires a Sepolia portal');
    this.store = store; this.pub = pub; this.payer = getAddress(payer); this.market = getAddress(market);
    store.db.exec('CREATE TABLE IF NOT EXISTS funding_deposits(hash TEXT PRIMARY KEY, protocol_id TEXT NOT NULL REFERENCES protocols(id), sender TEXT NOT NULL, payer TEXT NOT NULL, nil_address TEXT NOT NULL, eth TEXT NOT NULL, nil TEXT NOT NULL, block TEXT NOT NULL, block_hash TEXT NOT NULL)');
    store.db.exec('CREATE TABLE IF NOT EXISTS funding_context(id INTEGER PRIMARY KEY CHECK(id=1), payer TEXT NOT NULL, market TEXT NOT NULL, nil_address TEXT)');
    if (!(store.db.prepare('PRAGMA table_info(funding_context)').all() as { name: string }[]).some(column => column.name === 'nil_address')) throw new Error('Funding context requires explicit asset migration');
    store.db.exec('BEGIN IMMEDIATE');
    try {
      const context = store.db.prepare('SELECT payer,market FROM funding_context WHERE id=1').get() as { payer: string; market: string } | undefined;
      if (context && (context.payer !== this.payer || context.market !== this.market)) throw new Error('Funding context mismatch');
      if (!context) {
        if (store.db.prepare('SELECT hash FROM funding_deposits LIMIT 1').get()) throw new Error('Unscoped deposits require explicit migration');
        store.db.prepare('INSERT INTO funding_context VALUES(1,?,?,NULL)').run(this.payer, this.market);
      }
      store.db.exec('COMMIT');
    } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  }
  available(protocolId: string) {
    const deposits = this.store.db.prepare('SELECT eth,nil FROM funding_deposits WHERE protocol_id=?').all(protocolId) as { eth: string; nil: string }[];
    const hasLedger = this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='intents'").get();
    const spent = hasLedger ? this.store.db.prepare('SELECT spent_eth,spent_nil FROM intents WHERE protocol_id=?').all(protocolId) as { spent_eth: string | null; spent_nil: string | null }[] : [];
    const ethWei = deposits.reduce((n, d) => n + BigInt(d.eth), 0n) - spent.reduce((n, d) => n + BigInt(d.spent_eth ?? '0'), 0n);
    const nilUnits = deposits.reduce((n, d) => n + BigInt(d.nil), 0n) - spent.reduce((n, d) => n + BigInt(d.spent_nil ?? '0'), 0n);
    if (ethWei < 0n || nilUnits < 0n) throw new Error('Funding accounting needs reconciliation');
    return { ethWei, nilUnits };
  }
  summary(session: string, protocolId: string) {
    const actor = this.store.authorize(session, protocolId); this.store.log(protocolId, actor.wallet, 'funding.deposits.read');
    return { payer: this.payer, available: this.available(protocolId), deposits: this.store.db.prepare('SELECT hash,eth,nil,block FROM funding_deposits WHERE protocol_id=? ORDER BY block DESC LIMIT 50').all(protocolId) };
  }
  async credit(session: string, protocolId: string, hash: Hex) {
    hex(hash, 32); hash = hash.toLowerCase() as Hex;
    const actor = this.store.authorize(session, protocolId, true), sender = getAddress(actor.wallet);
    if (sender === this.payer) throw new Error('Relayer self-transfers cannot fund a customer');
    const head = await this.pub.getBlock({ blockTag: 'finalized' });
    if (typeof head.number !== 'bigint' || head.number < 0n) throw new Error('Finalized funding head unavailable');
    hex(head.hash, 32);
    const addresses = await resolveSepolia({ getChainId: () => this.pub.getChainId(),
      readContract: (request: Parameters<PublicClient['readContract']>[0]) => this.pub.readContract({ ...request, blockNumber: head.number! }) }, this.market);
    const asset = getAddress(addresses.nil);
    const pinned = this.store.db.prepare('SELECT nil_address FROM funding_context WHERE id=1').get() as { nil_address: string | null };
    if (pinned.nil_address && pinned.nil_address !== asset) throw new Error('Funding asset context mismatch');
    const [tx, receipt] = await Promise.all([this.pub.getTransaction({ hash }), this.pub.getTransactionReceipt({ hash })]);
    if (tx.hash !== hash || receipt.transactionHash !== hash || getAddress(tx.from) !== sender || !tx.to || receipt.status !== 'success'
      || typeof receipt.blockNumber !== 'bigint' || receipt.blockNumber < 0n || receipt.blockNumber > head.number) throw new Error('Finalized inbound funding proof unavailable');
    hex(receipt.blockHash, 32);
    if ((await this.pub.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error('Noncanonical funding receipt');
    let ethWei = 0n, nilUnits = 0n;
    if (getAddress(tx.to) === this.payer && tx.input === '0x' && uint(tx.value) > 0n) ethWei = tx.value;
    else if (getAddress(tx.to) === getAddress(addresses.nil) && tx.value === 0n) {
      const decoded = decodeFunctionData({ abi: nilAbi, data: tx.input });
      if (decoded.functionName !== 'transfer' || !decoded.args || getAddress(String(decoded.args[0])) !== this.payer) throw new Error('Direct NIL funding transfer required');
      for (const log of parseEventLogs({ abi: nilAbi, eventName: 'Transfer', logs: receipt.logs, strict: true })) {
        if (!log.removed && getAddress(log.address) === getAddress(addresses.nil) && getAddress(log.args.from) === sender && getAddress(log.args.to) === this.payer) nilUnits += uint(log.args.value);
      }
      if (nilUnits <= 0n || nilUnits > uint(decoded.args[1])) throw new Error('Verified NIL credit unavailable');
    } else throw new Error('Direct inbound customer deposit required');
    if ((await this.pub.getBlock({ blockNumber: head.number })).hash !== head.hash) throw new Error('Funding finality changed');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.authorize(session, protocolId, true);
      const context = this.store.db.prepare('SELECT nil_address FROM funding_context WHERE id=1').get() as { nil_address: string | null };
      if (context.nil_address && context.nil_address !== asset) throw new Error('Funding asset context mismatch');
      this.store.db.prepare('UPDATE funding_context SET nil_address=? WHERE id=1').run(asset);
      const previous = this.store.db.prepare('SELECT protocol_id,sender,payer,nil_address,eth,nil,block_hash FROM funding_deposits WHERE hash=?').get(hash) as Record<string, unknown> | undefined;
      if (previous) {
        if (previous.protocol_id !== protocolId || previous.sender !== sender || previous.payer !== this.payer || previous.nil_address !== getAddress(addresses.nil)
          || previous.eth !== String(ethWei) || previous.nil !== String(nilUnits) || previous.block_hash !== receipt.blockHash) throw new Error('Deposit already credited or context changed');
      } else {
        this.store.db.prepare('INSERT INTO funding_deposits VALUES(?,?,?,?,?,?,?,?,?)').run(hash, protocolId, sender, this.payer, getAddress(addresses.nil), String(ethWei), String(nilUnits), String(receipt.blockNumber), receipt.blockHash);
        this.store.log(protocolId, sender, 'funding.deposit.credited');
      }
      const result = this.available(protocolId); this.store.db.exec('COMMIT'); return result;
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
}
