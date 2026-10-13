import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { createWalletClient, decodeFunctionData, getAddress, hexToBytes, http, keccak256, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { resolveAddresses, triggerMarketAbi } from '@nillion/covenants-sdk';
import { DeploymentError, SEPOLIA_CONFIG } from '../src/chain/deployment.mjs';
import { classifyObservation, verifySpikeReveal } from '../src/chain/probe-evidence.mjs';
import { verifyHookDeployment, verifyRegistryBinding, verifyRegistryReceipt } from '../src/chain/registry-verification.mjs';
import { measureHookTrace, reconcileRefunds, sponsorshipDecision } from '../src/chain/spike-observation.mjs';
import { compileContracts } from './lib/contracts.mjs';
import { json, probeClient, publicFailure, receiptEvidence } from './lib/probe-runtime.mjs';
import { readJournal, readLimited } from './lib/researcher-files.mjs';

const usage = 'Usage: observe:sepolia -- EVIDENCE.json [--settle-expired] [--trace-hook]\n  or --journal REPORT.jsonl --out FRESH_EVIDENCE.json [--trace-hook] [--settle-expired]';
export async function runObserveCommand(argv, { client = probeClient, expectedMarket = process.env.EXPECTED_MARKET,
  payerKey = process.env.AUTHOR_KEY,
  walletFactory = account => createWalletClient({ account, chain: sepolia,
    transport: http(process.env.RPC_URL, { timeout: 10000, retryCount: 0 }) }),
  print = console.log, diagnostic = console.error } = {}) {
  let filename, evidence;
  let validInput = false;
  let stage = 'configuration';
  try {
    let values, positionals;
    try { ({ values, positionals } = parseArgs({ args: argv, strict: true, allowPositionals: true,
      options: { 'settle-expired': { type: 'boolean' }, 'trace-hook': { type: 'boolean' }, help: { type: 'boolean' },
        journal: { type: 'string' }, out: { type: 'string' } } }));
    } catch { throw new DeploymentError(usage); }
    if (values.help) { print(usage); return 0; }
    filename = positionals[0];
    const settle = values['settle-expired'];
    if (values.journal) {
      if (positionals.length || !values.out) throw new DeploymentError(usage);
      const journal = await readJournal(values.journal);
      if (journal.state !== 'bound' || journal.triggerId === undefined || journal.postBlock === undefined
          || journal.escrowWei === undefined || journal.feeNil === undefined) {
        throw new DeploymentError('Core observation requires a bound researcher journal with escrow and fee evidence');
      }
      evidence = { chainId: journal.chainId, mode: 'researcher', market: journal.market, hook: journal.registry,
        researcher: journal.researcher, payer: journal.researcher, reportId: journal.reportId,
        cipherHash: journal.cipherHash, keyCommit: journal.keyCommit, commit: journal.commit,
        triggerId: journal.triggerId, postBlock: journal.postBlock, escrowWei: journal.escrowWei,
        feeNil: journal.feeNil, window: journal.window, transactions: journal.transactions,
        ...(journal.parentReportId ? { parentReportId: journal.parentReportId, rootReportId: journal.rootReportId } : {}) };
      filename = values.out;
      await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
      await writeFile(filename, json(evidence) + '\n', { flag: 'wx', mode: 0o600 });
    } else {
      if (!filename || positionals.length !== 1 || values.out) throw new DeploymentError(usage);
      evidence = JSON.parse(new TextDecoder().decode(await readLimited(filename, 4 * 1024 * 1024)));
    }
    if (evidence.chainId !== sepolia.id || !['hello', 'sponsored', 'researcher'].includes(evidence.mode)
        || !/^\d+$/.test(evidence.triggerId ?? '') || !/^\d+$/.test(evidence.postBlock ?? '')
        || !Array.isArray(evidence.transactions) || !evidence.window) {
      throw new DeploymentError('M0 evidence must contain a Sepolia mode, posted trigger and source block');
    }
    validInput = true;
    stage = 'deployment and posted transaction';
    const pub = client();
    if (await pub.getChainId() !== sepolia.id) throw new DeploymentError('Observer requires Sepolia');
    const addresses = await resolveAddresses(pub, SEPOLIA_CONFIG);
    if (getAddress(addresses.market) !== getAddress(expectedMarket)
        || getAddress(addresses.market) !== getAddress(evidence.market)) throw new DeploymentError('Market deployment changed; refuse stale evidence');
    const id = BigInt(evidence.triggerId);
    const parties = await pub.readContract({ address: addresses.market, abi: triggerMarketAbi,
      functionName: 'postingParties', args: [id] });
    const hookMeta = await pub.readContract({ address: addresses.market, abi: triggerMarketAbi,
      functionName: 'hookMeta', args: [id] });
    if (getAddress(parties[0]) !== getAddress(evidence.researcher) || getAddress(parties[1]) !== getAddress(evidence.payer)
        || getAddress(hookMeta[0]) !== getAddress(evidence.hook)) throw new DeploymentError('Evidence does not match chain author, payer or hook');
    const head = await pub.getBlock();
    let meta = await pub.readContract({ address: addresses.market, abi: triggerMarketAbi,
      functionName: 'triggerMeta', args: [id] });
    if (meta[0] !== 1 || meta[4] !== BigInt(evidence.window.t1) || meta[5] !== BigInt(evidence.window.t2)
        || meta[3] !== meta[5] || (evidence.mode === 'researcher' && meta[6] !== evidence.commit)) {
      throw new DeploymentError('Evidence window or commitment differs from the posted public trigger');
    }
    const artifacts = await compileContracts();
    const artifact = evidence.mode === 'hello' ? artifacts.HelloRevealHook : artifacts.DisclosureRegistry;
    const abi = artifact.abi;
    const deploymentVerification = await verifyHookDeployment(pub, evidence.hook, artifact, addresses.market);
    const posts = evidence.transactions.filter(tx => ['postTrigger', 'postTriggerSponsored'].includes(tx.call));
    if (posts.length !== 1) throw new DeploymentError('Evidence must contain exactly one post transaction');
    const postTransaction = await pub.getTransaction({ hash: posts[0].hash });
    const postedReceipt = await pub.getTransactionReceipt({ hash: posts[0].hash });
    const postedCall = decodeFunctionData({ abi: triggerMarketAbi, data: postTransaction.input });
    const postedEvents = parseEventLogs({ abi: triggerMarketAbi, eventName: 'TriggerPosted', strict: true,
      logs: postedReceipt.logs.filter(log => log.address.toLowerCase() === addresses.market.toLowerCase()) });
    if (getAddress(postTransaction.to) !== getAddress(addresses.market) || getAddress(postTransaction.from) !== getAddress(evidence.payer)
        || postedReceipt.status !== 'success' || postedReceipt.blockNumber !== BigInt(evidence.postBlock)
        || postTransaction.value !== BigInt(evidence.escrowWei) || postedCall.args[0].commit !== meta[6]
        || postedEvents.length !== 1 || postedEvents[0].args.triggerId !== id
        || postedCall.functionName !== (evidence.mode === 'sponsored' ? 'postTriggerSponsored' : 'postTrigger')) {
      throw new DeploymentError('Post receipt, calldata or escrow differs from the watched trigger');
    }
    if (settle && !meta[8] && head.timestamp > meta[3]) {
      stage = 'expiry settlement';
      if (!payerKey) throw new DeploymentError('AUTHOR_KEY is needed to pay expiry settlement gas');
      const account = privateKeyToAccount(payerKey);
      if (getAddress(account.address) !== getAddress(evidence.payer)) throw new DeploymentError('Use the recorded M0 payer for settlement');
      const wallet = walletFactory(account);
      const simulated = await pub.simulateContract({ account, address: addresses.market,
        abi: triggerMarketAbi, functionName: 'settleExpired', args: [id] });
      const hash = await wallet.writeContract(simulated.request);
      evidence.transactions.push({ call: 'settleExpired', hash });
      await writeFile(filename, json(evidence) + '\n');
      const receipt = await pub.waitForTransactionReceipt({ hash });
      Object.assign(evidence.transactions.at(-1), receiptEvidence(receipt));
      await writeFile(filename, json(evidence) + '\n');
      if (receipt.status !== 'success') throw new DeploymentError('Expiry settlement reverted; see evidence hash');
      meta = await pub.readContract({ address: addresses.market, abi: triggerMarketAbi,
        functionName: 'triggerMeta', args: [id] });
    }
    const latest = await pub.getBlock();
    if (evidence.mode !== 'hello') {
      await verifyRegistryBinding(pub, evidence.hook, abi, evidence);
      const calls = evidence.mode === 'sponsored' ? [['registerBySig', 'Registered'], ['bindBySig', 'Bound']]
        : [[evidence.parentReportId ? 'registerRetry' : 'register', 'Registered'], ['bindTrigger', 'Bound']];
      for (const [call, event] of calls) {
        const entries = evidence.transactions.filter(tx => tx.call === call);
        if (entries.length !== 1) throw new DeploymentError('Report evidence is missing a unique registration or binding receipt');
        const receipt = await pub.getTransactionReceipt({ hash: entries[0].hash });
        verifyRegistryReceipt(receipt, evidence.hook, abi, event, evidence);
      }
    }
    // Re-read receipts, rather than trusting the saved payer/success/cost fields.
    for (const tx of evidence.transactions) {
      const receipt = await pub.getTransactionReceipt({ hash: tx.hash });
      if (receipt.transactionHash !== tx.hash || receipt.status !== 'success' || getAddress(receipt.from) !== getAddress(evidence.payer)) {
        throw new DeploymentError('Probe transaction was not successfully paid by the recorded payer');
      }
      Object.assign(tx, receiptEvidence(receipt));
    }
    stage = 'events and measurements';
    const fromBlock = BigInt(evidence.postBlock);
    const [marketLogs, hookLogs] = await Promise.all([
      pub.getContractEvents({ address: addresses.market, abi: triggerMarketAbi, args: { triggerId: id },
        fromBlock, toBlock: latest.number, strict: true }),
      pub.getContractEvents({ address: evidence.hook, abi, args: { triggerId: id },
        fromBlock, toBlock: latest.number, strict: true }),
    ]);
    // Enforce provider filters and reject reorged/out-of-range evidence locally.
    const watched = (logs, address) => logs.filter(log => log.args.triggerId === id).map(log => {
      if (log.removed || log.address.toLowerCase() !== address.toLowerCase()
          || log.blockNumber < fromBlock || log.blockNumber > latest.number) {
        throw new DeploymentError('Watched event is removed, foreign or outside the requested block range');
      }
      return log;
    }).sort((a, b) => a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1
      : (a.logIndex ?? 0) - (b.logIndex ?? 0));
    const events = watched(marketLogs, addresses.market);
    const acceptances = watched(hookLogs, evidence.hook).filter(log =>
      log.eventName === (evidence.mode === 'hello' ? 'HelloRevealed' : 'Disclosed'));
    const reveals = events.filter(log => log.eventName === 'TriggerResolved');
    if (acceptances.length > 1 || reveals.length > 1) throw new DeploymentError('Watched trigger has duplicate reveal or acceptance events');
    const accepted = acceptances[0];
    const revealEvent = reveals[0];
    const shares = events.filter(log => log.eventName === 'SharePosted');
    // Verify the logs already fetched in bounded pages; an additional open-ended scan
    // through verifyReveal would exceed providers with small log-range limits.
    const plaintext = revealEvent ? hexToBytes(revealEvent.args.plaintext) : undefined;
    const verifiedReveal = Boolean(plaintext && keccak256(plaintext) === meta[6]);
    if (revealEvent && (!verifiedReveal || !accepted)) throw new DeploymentError('Market reveal is missing a verified commitment or hook acceptance event');
    if (plaintext) verifySpikeReveal(evidence, plaintext.subarray(0, plaintext.length - 32), accepted);
    let settlementConfirmed = false;
    for (const entry of evidence.transactions.filter(tx => tx.call === 'settleExpired')) {
      const transaction = await pub.getTransaction({ hash: entry.hash });
      const receipt = await pub.getTransactionReceipt({ hash: entry.hash });
      if (!transaction.to || getAddress(transaction.to) !== getAddress(addresses.market)) continue;
      const decoded = decodeFunctionData({ abi: triggerMarketAbi, data: transaction.input });
      if (decoded.functionName === 'settleExpired' && decoded.args[0] === id && receipt.status === 'success') {
        settlementConfirmed = true;
      }
    }
    const refunds = events.filter(log => ['RefundIssued', 'RefundOwed', 'RefundClaimed'].includes(log.eventName));
    const firstShareBlock = shares.length ? await pub.getBlock({ blockNumber: shares[0].blockNumber }) : undefined;
    const revealedBlock = revealEvent ? await pub.getBlock({ blockNumber: revealEvent.blockNumber }) : undefined;
  const acceptedBlock = accepted ? await pub.getBlock({ blockNumber: accepted.blockNumber }) : undefined;
    const revealReceipt = revealEvent ? await pub.getTransactionReceipt({ hash: revealEvent.transactionHash }) : undefined;
    const decodedReceipt = revealReceipt ? parseEventLogs({ abi: triggerMarketAbi, logs: revealReceipt.logs, strict: true }) : [];
    const observation = { sourceBlock: latest.number, sourceTimestamp: latest.timestamp, deploymentVerification,
      state: classifyObservation({ nowUnix: latest.timestamp, expiry: meta[3], resolved: meta[8],
        verifiedReveal, escrowWei: meta[10], settlementConfirmed }),
      earliestShareBlock: firstShareBlock?.number, earliestShareUnix: firstShareBlock?.timestamp,
    earliestShareDeltaSecs: firstShareBlock ? firstShareBlock.timestamp - BigInt(evidence.window.t1) : undefined,
    firstShareExpiryMarginSecs: firstShareBlock ? meta[3] - firstShareBlock.timestamp : undefined,
      revealBlock: revealedBlock?.number, revealUnix: revealedBlock?.timestamp,
      revealDeltaSecs: revealedBlock ? revealedBlock.timestamp - BigInt(evidence.window.t1) : undefined,
      shareToRevealSecs: revealedBlock && firstShareBlock ? revealedBlock.timestamp - firstShareBlock.timestamp : undefined,
      revealTransaction: revealReceipt ? receiptEvidence(revealReceipt) : undefined,
      hookAcceptanceHash: accepted?.transactionHash,
    hookAcceptanceUnix: acceptedBlock?.timestamp,
    acceptanceDeltaSecs: acceptedBlock ? acceptedBlock.timestamp - BigInt(evidence.window.t1) : undefined,
    livenessTargetSecs: 600,
    withinLivenessTarget: acceptedBlock ? acceptedBlock.timestamp >= meta[4] && acceptedBlock.timestamp - meta[4] <= 600n : undefined,
      escrowRemainingWei: meta[10], refundOwedWei: meta[11], refundRecipient: parties[1],
      refunds: refunds.map(log => ({ event: log.eventName, amount: log.args.amount, hash: log.transactionHash })),
      decodedRevealEvents: decodedReceipt.map(log => log.eventName), hookAccepted: Boolean(accepted),
      protocolFeeNil: evidence.feeNil,
      payerGasCostWei: evidence.transactions.reduce((sum, tx) => sum + BigInt(tx.gasCostWei ?? 0), 0n),
      refundReconciliation: reconcileRefunds({ deposited: BigInt(evidence.escrowWei), remaining: meta[10], owed: meta[11], events }),
      hookTrace: { status: revealEvent ? 'not-requested' : 'pending-reveal' } };
    if (values['trace-hook'] && revealEvent) {
      let trace;
      try { trace = await pub.request({ method: 'debug_traceTransaction',
        params: [accepted.transactionHash, { tracer: 'callTracer' }] });
      } catch (error) { observation.hookTrace = { status: 'unavailable', failure: publicFailure(error) }; }
    if (trace) observation.hookTrace = { ...measureHookTrace(trace, { market: addresses.market, hook: evidence.hook,
      abi, triggerId: id, commit: meta[6], gasLimit: BigInt(hookMeta[1]) }),
      transactionHash: accepted.transactionHash,
      invocation: accepted.transactionHash === revealEvent.transactionHash ? 'initial' : 'retry' };
    }
    observation.measurementsComplete = observation.state === 'revealed-accepted' && observation.hookTrace.status === 'measured'
    && observation.hookTrace.invocation === 'initial' && observation.hookTrace.withinDeclaredBudget
      && observation.hookTrace.forwardingCapped
    && Boolean(firstShareBlock) && firstShareBlock.timestamp >= meta[4] && revealedBlock.timestamp >= meta[4]
      && observation.refundReconciliation.owedWei === 0n && observation.escrowRemainingWei === 0n;
    evidence.observation = observation;
    delete evidence.observationFailure;
    evidence.fundingDecision = sponsorshipDecision(evidence, observation);
    await writeFile(filename, json(evidence) + '\n');
    print(json({ ...observation, fundingDecision: evidence.fundingDecision }));
    return observation.state === 'pending' || observation.state === 'expired-unsettled'
      || (values['trace-hook'] && observation.hookTrace.status !== 'measured') ? 2 : 0;

  } catch (error) {
    const failure = { status: 'failed', failedStage: stage, ...publicFailure(error) };
    if (validInput) {
      evidence.observationFailure = failure;
      if (evidence.mode === 'sponsored') evidence.fundingDecision = {
        requirement: 'FR-211', decision: 'pending', reason: 'Latest observer verification failed; see observationFailure' };
      try { await writeFile(filename, json(evidence) + '\n'); } catch { failure.evidenceWriteFailed = true; }
    }
    diagnostic(json(failure));
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runObserveCommand(process.argv.slice(2));
