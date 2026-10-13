import { getAddress, encodeFunctionData, keccak256, toHex, recoverTypedDataAddress, type Abi, type Hex, type PublicClient } from 'viem';
import { triggerMarketAbi, nilAbi, quoteEscrow, quoteProtocolFee, maxLayerLen, validate, deriveLivePin, fetchCandidates, type DuskWallet } from '@nillion/covenants-sdk';
import { postParamsTuple } from '@nillion/covenants-sdk/browser';
import { PortalStore } from '../portal/store.mts';
import { SponsorBudget } from './budget.mts';
import { validateSponsoredBundle, type SponsoredBundle, type RegistryGrant } from './terms.mts';
import { createPlan } from '../planner/planner.mts';
import { quoteTransactionCosts, type CostCall } from '../planner/costs.mts';
import { checkDeployment, type RegistryArtifact } from '../client/deployment.mts';
import { encodeWire } from '../client/wire.mts';
import { registryDomain, registryTypes } from '../../src/shared/registry-authorization.mjs';
import { verifyHookDeployment, verifyRegistryReceipt, verifyRegistryBinding } from '../../src/chain/registry-verification.mjs';
import { resolveSepolia } from '../../src/chain/deployment.mjs';
import { postWithEscrowRetry } from '../../src/chain/posting.mjs';
import { policy } from '../../config/policy.mjs';

interface BindingGrant extends RegistryGrant { triggerId: bigint }
interface SponsorConfig { expectedMarket: Hex; registry: Hex; artifact: RegistryArtifact; maxCeilingWei: bigint; writesEnabled: boolean }
export class SponsorService {
  readonly #authority = Symbol('validated sponsor service');
  readonly #budget: SponsorBudget;
  readonly store: PortalStore; readonly pub: PublicClient; readonly wallet: DuskWallet; readonly config: SponsorConfig;
  constructor(store: PortalStore, pub: PublicClient, wallet: DuskWallet, config: SponsorConfig) {
    if (wallet.chain.id !== 11155111 || !wallet.account || config.maxCeilingWei <= 0n) throw new Error('Dedicated Sepolia relayer configuration required');
    this.store = store; this.pub = pub; this.wallet = wallet; this.config = config; this.#budget = new SponsorBudget(store, this.#authority);
    store.db.exec('CREATE TABLE IF NOT EXISTS sponsored_posts(intent_id TEXT PRIMARY KEY, report_id TEXT NOT NULL, author TEXT NOT NULL, cipher_hash TEXT NOT NULL, key_commit TEXT NOT NULL, t1 TEXT NOT NULL, t2 TEXT NOT NULL, trigger_id TEXT, tx_hash TEXT)');
  }
  configure(session: string, protocolId: string, limits: Parameters<SponsorBudget['configure']>[2], funded?: Parameters<SponsorBudget['configure']>[3]) { this.#budget.configure(session, protocolId, limits, funded); }
  summary(session: string, protocolId: string) { return this.#budget.summary(session, protocolId); }
  intent(session: string, protocolId: string, id: Hex) {
    this.store.authorize(session, protocolId);
    const intent = this.#budget.intent(this.#authority, id); if (intent.protocolId !== protocolId) throw new Error('Not authorized');
    this.store.log(protocolId, this.store.sessionWallet(session), 'funding.read'); return intent;
  }
  async #binding(report: { reportId: Hex; author: Hex; t1: bigint }, grant: BindingGrant, now: bigint, payer: Hex) {
    if (getAddress(grant.payer) !== getAddress(payer) || getAddress(grant.researcher) !== getAddress(report.author) || grant.deadline <= now || grant.deadline >= report.t1) throw new Error('Binding grant payer, author or expiry invalid');
    const message = { reportId: report.reportId, triggerId: grant.triggerId, researcher: grant.researcher, payer: grant.payer, nonce: grant.nonce, deadline: grant.deadline };
    const author = await recoverTypedDataAddress({ domain: registryDomain(11155111, this.config.registry), types: { BindReport: registryTypes.BindReport }, primaryType: 'BindReport', message, signature: grant.signature });
    if (getAddress(author) !== getAddress(report.author)) throw new Error('Binding signature mismatch');
  }
  async prepare(session: string, protocolId: string, bundle: SponsoredBundle, binding: BindingGrant) {
    this.store.authorize(session, protocolId, true);
    return this.quote(protocolId, bundle, binding);
  }
  async quote(protocolId: string, bundle: SponsoredBundle, binding: BindingGrant) {
    const protocol = this.store.db.prepare('SELECT enabled FROM protocols WHERE id=?').get(protocolId) as { enabled: number } | undefined;
    if (!protocol?.enabled) throw new Error('Sponsor disabled');
    const addresses = await checkDeployment(this.pub, this.config.expectedMarket, this.config.registry, this.config.artifact);
    if (this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='funding_context'").get()) {
      const funding = this.store.db.prepare('SELECT payer,market,nil_address FROM funding_context WHERE id=1').get() as { payer: string; market: string; nil_address: string | null } | undefined;
      if (!funding || funding.payer !== getAddress(this.wallet.account.address) || funding.market !== getAddress(addresses.market)
        || funding.nil_address !== getAddress(addresses.nil)) throw new Error('Funding asset context mismatch');
    }
    const plan = await createPlan(this.pub, { expectedMarket: this.config.expectedMarket, registry: this.config.registry, t1: bundle.args.t1 ?? 0n, t2: bundle.args.t2 ?? 0n });
    const payer = this.wallet.account.address, args = bundle.args;
    const verified = await validateSponsoredBundle(bundle, { market: addresses.market, registry: this.config.registry, payer, nowUnix: plan.timestamp,
      maxCeilingWei: this.config.maxCeilingWei, maxHookGas: Number(plan.parameters.maxHookGas), maxRetryWindowSecs: Number(plan.parameters.maxRetryWindowSecs),
      maxM: Number(plan.parameters.maxM), maxPlaintextBytes: plan.parameters.maxPlaintextBytes, maxCiphertextBytes: plan.parameters.maxCiphertextBytes });
    const live = await deriveLivePin(this.pub, addresses), candidates = await fetchCandidates(this.pub, addresses);
    const selected = args.keys.map(key => candidates.find(candidate => candidate.keyId === key.keyId && candidate.nodeId === key.nodeId && candidate.mpk === key.mpk && live.nodeIds.includes(key.nodeId)));
    if (selected.some(key => !key)) throw new Error('Authorized committee is no longer live');
    validate(selected.filter(key => key !== undefined), { m: args.keys.length, k: args.k, nowUnix: plan.timestamp, minStake: plan.parameters.minStake, mode: 'PUBLIC_CONDITION' });
    const nextId = await this.pub.readContract({ address: addresses.market, abi: triggerMarketAbi, functionName: 'nextTriggerId' });
    if (binding.triggerId !== nextId) throw new Error('Refresh predicted binding grant before pricing');
    await this.#binding({ reportId: bundle.reportId, author: bundle.authorization.author, t1: bundle.args.t1! }, binding, plan.timestamp, payer);
    const fee = await quoteProtocolFee(this.pub, addresses, payer);
    const quote = await quoteEscrow(this.pub, addresses.market, { mode: 'PUBLIC_CONDITION', keyIds: args.keys.map(key => key.keyId), k: args.k, maxLayerLen: maxLayerLen(args.layers), ceilingWei: args.ceilingWei,
      hook: this.config.registry, hookGasLimit: args.hookGasLimit, retryWindowSecs: args.retryWindowSecs });
    const calls: CostCall[] = [
      { action: 'register', payer, to: this.config.registry, value: 0n, data: encodeFunctionData({ abi: this.config.artifact.abi, functionName: 'registerBySig', args: [bundle.cipherHash, bundle.keyCommit, args.t1, args.t2, bundle.registration] }) },
      { action: 'approve', payer, to: addresses.nil, value: 0n, data: encodeFunctionData({ abi: nilAbi, functionName: 'approve', args: [addresses.market, fee.feeNil] }) },
      { action: 'post', payer, to: addresses.market, value: quote.escrowWei, data: encodeFunctionData({ abi: triggerMarketAbi, functionName: 'postTriggerSponsored', args: [postParamsTuple(args), bundle.authorization] }) },
      { action: 'bind', payer, to: this.config.registry, value: 0n, data: encodeFunctionData({ abi: this.config.artifact.abi, functionName: 'bindBySig', args: [bundle.reportId, binding.triggerId, binding] }) },
    ];
    const cost = await quoteTransactionCosts(this.pub, calls);
    if (fee.balanceNil < fee.feeNil || await this.pub.getBalance({ address: payer }) < quote.escrowWei + cost.totalGasWei) throw new Error('Relayer must hold protocol funds before submission');
    // Gas caps use the live simulation with explicit headroom. This is product
    // spending policy, not a hardcoded protocol gas parameter.
    const gasCaps = new Map(cost.items.map(item => [item.action, item.gasUnits * BigInt(policy.gasHeadroomBps) / 10000n + 1n]));
    const gasReserve = [...gasCaps.values()].reduce((sum, gas) => sum + gas * cost.maxFeePerGas, 0n)
      + gasCaps.get('post')! * cost.maxFeePerGas // one final-revert post retry
      + BigInt(policy.bindingAttempts - 1) * gasCaps.get('bind')! * cost.maxFeePerGas;
    const id = keccak256(toHex(encodeWire({ reportId: bundle.reportId, author: verified.author, market: addresses.market, nonce: verified.nonce })));
    const requestHash = keccak256(toHex(encodeWire({ bundle, binding })));
    return { id, requestHash, bundle, binding, addresses, calls, gasCaps, maxFeePerGas: cost.maxFeePerGas, feeNil: fee.feeNil, escrowWei: quote.escrowWei,
      ethReserveWei: quote.escrowWei + gasReserve, costs: cost, protocolId };
  }
  async observe(id: Hex) {
    const addresses = await resolveSepolia(this.pub, this.config.expectedMarket);
    await verifyHookDeployment(this.pub, this.config.registry, this.config.artifact, addresses.market);
    const proof = await this.#budget.reconcile(this.#authority, id, this.pub, { payer: this.wallet.account.address, market: addresses.market, nil: addresses.nil,
      registry: this.config.registry, registryAbi: this.config.artifact.abi });
    if (!proof) throw new Error('Finalized funding proof unavailable');
    if (proof.state === 'failed') return { state: 'failed' as const };
    if ('pendingBinding' in proof && proof.pendingBinding) return { state: 'awaiting-binding' as const, triggerId: proof.triggerId, postHash: proof.postHash };
    const saved = this.store.db.prepare('SELECT * FROM sponsored_posts WHERE intent_id=?').get(id) as Record<string, unknown> | undefined;
    if (!saved || proof.state !== 'confirmed' || saved.trigger_id === null) throw new Error('Finalized binding proof unavailable');
    const triggerId = BigInt(String(saved.trigger_id)), head = await this.pub.getBlock({ blockTag: 'finalized' });
    if (typeof head.number !== 'bigint' || head.number < 0n || !head.hash) throw new Error('Finalized head unavailable');
    const expected = { reportId: String(saved.report_id), researcher: String(saved.author), cipherHash: String(saved.cipher_hash), keyCommit: String(saved.key_commit),
      window: { t1: BigInt(String(saved.t1)), t2: BigInt(String(saved.t2)) }, triggerId };
    await verifyRegistryBinding({ readContract: (request: Parameters<PublicClient['readContract']>[0]) => this.pub.readContract({ ...request, blockNumber: head.number! }) }, this.config.registry, this.config.artifact.abi, expected);
    if ((await this.pub.getBlock({ blockNumber: head.number })).hash !== head.hash) throw new Error('Binding finality changed');
    return { state: 'bound' as const, triggerId, postHash: String(saved.tx_hash) as Hex };
  }
  closeUnfundedSubmission(id: Hex) { this.#budget.closeSubmission(this.#authority, id); }
  async submit(session: string, prepared: Awaited<ReturnType<SponsorService['prepare']>>) {
    if (!this.config.writesEnabled) throw new Error('Live sponsored submission is disabled until release approval');
    // Revalidate signatures, routing, current live fee/limits and cost sequence
    // immediately before taking a reservation. Never trust a client-made plan.
    const fresh = await this.prepare(session, prepared.protocolId, prepared.bundle, prepared.binding);
    if (fresh.requestHash !== prepared.requestHash || fresh.ethReserveWei > prepared.ethReserveWei || fresh.feeNil > prepared.feeNil) throw new Error('Spending changed; review fresh costs before signing');
    const { bundle, id, addresses } = fresh;
    const head = await this.pub.getBlock();
    if (head.number === null || !head.hash) throw new Error('Canonical payer balance snapshot unavailable');
    const [ethWei, nilUnits] = await Promise.all([
      this.pub.getBalance({ address: this.wallet.account.address, blockNumber: head.number }),
      this.pub.readContract({ address: addresses.nil, abi: nilAbi, functionName: 'balanceOf', args: [this.wallet.account.address], blockNumber: head.number }),
    ]);
    if ((await this.pub.getBlock({ blockNumber: head.number })).hash !== head.hash) throw new Error('Payer balance snapshot changed; retry cost review');
    this.#budget.reserve(this.#authority, fresh.protocolId, { id, requestHash: fresh.requestHash, author: bundle.authorization.author, nonce: String(bundle.authorization.nonce), ethWei: prepared.ethReserveWei, nilUnits: prepared.feeNil },
      { payer: this.wallet.account.address, market: addresses.market, nil: addresses.nil, ethWei, nilUnits, blockNumber: head.number, blockHash: head.hash });
    const existing = this.#budget.intent(this.#authority, id); if (existing.state !== 'reserved') throw new Error('Submission already attempted; reconcile saved hashes');
    this.store.db.prepare('INSERT OR IGNORE INTO sponsored_posts VALUES(?,?,?,?,?,?,?,NULL,NULL)').run(id, bundle.reportId, bundle.authorization.author, bundle.cipherHash, bundle.keyCommit, String(bundle.args.t1), String(bundle.args.t2));
    this.#budget.begin(this.#authority, id);
    let postAttempts = 0;
    const sender: DuskWallet = { ...this.wallet, writeContract: async request => {
      const kind = request.functionName === 'approve' ? 'approve' : request.functionName === 'postTriggerSponsored' ? 'post' : request.functionName === 'registerBySig' ? 'register' : request.functionName === 'bindBySig' ? 'bind' : undefined;
      if (!kind) throw new Error('Unexpected sponsored transaction');
      const action = kind === 'post' && postAttempts ? 'post:1' : kind;
      const call = fresh.calls.find(call => call.action === kind)!;
      const data = encodeFunctionData({ abi: request.abi as Abi, functionName: String(request.functionName), args: request.args as readonly unknown[] });
      const gas = fresh.gasCaps.get(kind)!;
      if (data !== call.data || getAddress(request.address) !== getAddress(call.to)) throw new Error('Sponsored calldata changed');
      if (kind === 'post' && (postAttempts >= 2 || (request.value ?? 0n) > prepared.escrowWei)) throw new Error('Post retry exceeds reviewed escrow or attempt limit');
      const currentFee = await quoteProtocolFee(this.pub, addresses, this.wallet.account.address);
      if (currentFee.feeNil > prepared.feeNil) throw new Error('Live NIL fee exceeds reviewed reservation');
      this.#budget.startAction(this.#authority, id, action, { to: call.to, data, value: request.value ?? 0n, gasUnits: gas, maxFeePerGas: fresh.maxFeePerGas, nilUnits: kind === 'post' ? prepared.feeNil : 0n });
      if (kind === 'post') postAttempts++;
      const hash = await this.wallet.sendTransaction({ to: request.address, data, value: request.value ?? 0n, gas, maxFeePerGas: fresh.maxFeePerGas,
        maxPriorityFeePerGas: fresh.costs.maxPriorityFeePerGas, account: this.wallet.account, chain: this.wallet.chain });
      this.#budget.recordHash(this.#authority, id, action, hash); return hash;
    } };
    const expected = { reportId: bundle.reportId, researcher: bundle.authorization.author, cipherHash: bundle.cipherHash, keyCommit: bundle.keyCommit, window: { t1: bundle.args.t1!, t2: bundle.args.t2! } };
    const registrationHash = await sender.writeContract({ address: this.config.registry, abi: this.config.artifact.abi, functionName: 'registerBySig', args: [bundle.cipherHash, bundle.keyCommit, bundle.args.t1, bundle.args.t2, bundle.registration] });
    verifyRegistryReceipt(await this.pub.waitForTransactionReceipt({ hash: registrationHash }), this.config.registry, this.config.artifact.abi, 'Registered', expected);
    const posted = await postWithEscrowRetry(this.pub, sender, addresses, { ...bundle.args, feeApprovalAmount: fresh.feeNil, authorization: bundle.authorization }, {
      onReverted: async () => this.#budget.provePostRevert(this.#authority, id, this.pub, { payer: this.wallet.account.address, market: addresses.market, nil: addresses.nil, registry: this.config.registry, registryAbi: this.config.artifact.abi }),
      onRequote: async () => {
        // Finality can take long enough to consume the admission margin.
        // Refuse a late retry; never move the signed immutable window.
        await createPlan(this.pub, { expectedMarket: this.config.expectedMarket, registry: this.config.registry, t1: bundle.args.t1!, t2: bundle.args.t2! });
      },
    });
    this.store.db.prepare('UPDATE sponsored_posts SET trigger_id=?,tx_hash=? WHERE intent_id=?').run(String(posted.triggerId), posted.txHash, id);
    const hook = await this.pub.readContract({ address: addresses.market, abi: triggerMarketAbi, functionName: 'hookMeta', args: [posted.triggerId] });
    const parties = await this.pub.readContract({ address: addresses.market, abi: triggerMarketAbi, functionName: 'postingParties', args: [posted.triggerId] });
    if (getAddress(hook[0]) !== getAddress(this.config.registry) || getAddress(parties[0]) !== getAddress(bundle.authorization.author) || getAddress(parties[1]) !== getAddress(this.wallet.account.address)) throw new Error('Posted hook, author or refund payer mismatch');
    if (posted.triggerId !== fresh.binding.triggerId) return { id, triggerId: posted.triggerId, state: 'awaiting-binding' as const };
    const hash = await sender.writeContract({ address: this.config.registry, abi: this.config.artifact.abi, functionName: 'bindBySig', args: [bundle.reportId, posted.triggerId, fresh.binding] });
    verifyRegistryReceipt(await this.pub.waitForTransactionReceipt({ hash }), this.config.registry, this.config.artifact.abi, 'Bound', { ...expected, triggerId: posted.triggerId });
    await verifyRegistryBinding(this.pub, this.config.registry, this.config.artifact.abi, { ...expected, triggerId: posted.triggerId });
    return { id, triggerId: posted.triggerId, state: 'bound' as const };
  }
  async completeBinding(id: Hex, grant: BindingGrant, reviewedGasWei?: bigint) {
    if (!this.config.writesEnabled) throw new Error('Live sponsored submission is disabled until release approval');
    let saved = this.store.db.prepare('SELECT * FROM sponsored_posts WHERE intent_id=?').get(id) as Record<string, unknown> | undefined;
    if (!saved) throw new Error('Posted intent or trigger unavailable');
    const addresses = await resolveSepolia(this.pub, this.config.expectedMarket);
    await verifyHookDeployment(this.pub, this.config.registry, this.config.artifact, addresses.market);
    const ledgerChain = { payer: this.wallet.account.address, market: addresses.market, nil: addresses.nil, registry: this.config.registry, registryAbi: this.config.artifact.abi };
    if (saved.trigger_id === null) {
      const recovered = await this.#budget.reconcile(this.#authority, id, this.pub, ledgerChain);
      if (!recovered || !('pendingBinding' in recovered) || !recovered.pendingBinding) throw new Error('Successful finalized post unavailable; no resend permitted');
      this.store.db.prepare('UPDATE sponsored_posts SET trigger_id=?,tx_hash=? WHERE intent_id=? AND trigger_id IS NULL').run(String(recovered.triggerId), recovered.postHash, id);
      saved = { ...saved, trigger_id: String(recovered.triggerId), tx_hash: recovered.postHash };
    }
    if (BigInt(String(saved.trigger_id)) !== grant.triggerId) throw new Error('Posted intent or trigger unavailable');
    const [hook, parties] = await Promise.all([
      this.pub.readContract({ address: addresses.market, abi: triggerMarketAbi, functionName: 'hookMeta', args: [grant.triggerId] }),
      this.pub.readContract({ address: addresses.market, abi: triggerMarketAbi, functionName: 'postingParties', args: [grant.triggerId] }),
    ]);
    if (getAddress(hook[0]) !== getAddress(this.config.registry) || getAddress(parties[0]) !== getAddress(String(saved.author)) || getAddress(parties[1]) !== getAddress(this.wallet.account.address)) throw new Error('Posted hook, author or refund payer mismatch');
    const report = { reportId: String(saved.report_id) as Hex, author: String(saved.author) as Hex, t1: BigInt(String(saved.t1)) };
    const now = (await this.pub.getBlock()).timestamp;
    await this.#binding(report, grant, now, this.wallet.account.address);
    const expected = { ...report, researcher: report.author, cipherHash: String(saved.cipher_hash), keyCommit: String(saved.key_commit), window: { t1: report.t1, t2: BigInt(String(saved.t2)) }, triggerId: grant.triggerId };
    const intent = this.#budget.intent(this.#authority, id);
    const attempts = intent.transactions as { action: string; hash: Hex }[];
    const binds = attempts.filter(attempt => attempt.action.startsWith('bind'));
    if (binds.length) {
      await this.#budget.reconcile(this.#authority, id, this.pub, ledgerChain);
      const state = this.#budget.intent(this.#authority, id).state;
      if (state === 'confirmed') {
        await verifyRegistryBinding(this.pub, this.config.registry, this.config.artifact.abi, expected);
        const final = this.store.db.prepare("SELECT hash FROM finalized_attempts WHERE intent_id=? AND action LIKE 'bind%' AND status='success'").get(id) as { hash: Hex } | undefined;
        if (!final) throw new Error('Final binding hash unavailable');
        return { id, triggerId: grant.triggerId, state: 'bound' as const, hash: final.hash };
      }
      if (state !== 'submitted') throw new Error('Binding already accounted or not safely retryable');
    }
    const action = binds.length ? `bind:${binds.length}` : 'bind';
    if (binds.length >= policy.bindingAttempts) throw new Error('Reviewed binding retry reserve exhausted');
    const args = [report.reportId, grant.triggerId, grant] as const;
    await this.pub.simulateContract({ address: this.config.registry, abi: this.config.artifact.abi, functionName: 'bindBySig', args, account: this.wallet.account });
    const gas = (await this.pub.estimateContractGas({ address: this.config.registry, abi: this.config.artifact.abi, functionName: 'bindBySig', args, account: this.wallet.account })) * BigInt(policy.gasHeadroomBps) / 10000n + 1n;
    const fees = await this.pub.estimateFeesPerGas();
    if (typeof gas !== 'bigint' || gas <= 0n || typeof fees.maxFeePerGas !== 'bigint' || fees.maxFeePerGas <= 0n
      || typeof fees.maxPriorityFeePerGas !== 'bigint' || fees.maxPriorityFeePerGas < 0n || fees.maxPriorityFeePerGas > fees.maxFeePerGas
      || (reviewedGasWei !== undefined && (typeof reviewedGasWei !== 'bigint' || reviewedGasWei <= 0n || gas * fees.maxFeePerGas > reviewedGasWei))) throw new Error('Binding exceeds reviewed live costs');
    const data = encodeFunctionData({ abi: this.config.artifact.abi, functionName: 'bindBySig', args });
    this.#budget.startAction(this.#authority, id, action, { to: this.config.registry, data, value: 0n, gasUnits: gas, maxFeePerGas: fees.maxFeePerGas, nilUnits: 0n });
    const hash = await this.wallet.sendTransaction({ to: this.config.registry, data, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, account: this.wallet.account, chain: this.wallet.chain });
    this.#budget.recordHash(this.#authority, id, action, hash);
    verifyRegistryReceipt(await this.pub.waitForTransactionReceipt({ hash }), this.config.registry, this.config.artifact.abi, 'Bound', expected);
    await verifyRegistryBinding(this.pub, this.config.registry, this.config.artifact.abi, expected);
    return { id, triggerId: grant.triggerId, state: 'bound' as const, hash };
  }
}
