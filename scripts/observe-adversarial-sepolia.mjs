import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { ContractFunctionRevertedError, RpcRequestError, decodeFunctionData, encodeErrorResult, getAddress, hexToBytes, keccak256, parseEventLogs, toHex } from 'viem';
import { nilAbi, triggerMarketAbi } from '@nillion/covenants-sdk';
import { DeploymentError, resolveSepolia } from '../src/chain/deployment.mjs';
import { verifyHookDeployment, verifyRegistryBinding, verifyRegistryReceipt } from '../src/chain/registry-verification.mjs';
import { measureHookTrace, reconcileRefunds } from '../src/chain/spike-observation.mjs';
import { reportIdFor } from '../src/shared/disclosure.mjs';
import { compileContracts } from './lib/contracts.mjs';
import { rejectionPayload, adversarialScenarios as scenarios } from './lib/adversarial-probes.mjs';
import { verifyRejectionReceipt } from './lib/rejection-receipt.mjs';
import { json, probeClient, publicFailure, receiptEvidence } from './lib/probe-runtime.mjs';
import { readLimited } from './lib/researcher-files.mjs';

const key = new Uint8Array(32).fill(7);
const same = (a, b) => getAddress(a) === getAddress(b);
const requireThat = (condition, message) => { if (!condition) throw new DeploymentError(message); };
const load = async path => JSON.parse(new TextDecoder().decode(await readLimited(path, 4 * 1024 * 1024)));

// Code 15 is not decoded as a revert by installed viem. Require exact ABI bytes
// from a structured RPC error for this read-only simulation; never trust its text.
function unauthorizedRevert(error, abi) {
  const expected = encodeErrorResult({ abi, errorName: 'Unauthorized' }).toLowerCase();
  const seen = new Set();
  for (let cause = error; cause && seen.size < 8 && !seen.has(cause); cause = cause.cause) {
    seen.add(cause);
    if (cause instanceof ContractFunctionRevertedError) {
      return cause.data?.errorName === 'Unauthorized' && typeof cause.raw === 'string'
        && cause.raw.toLowerCase() === expected;
    }
    if (!(cause instanceof RpcRequestError) || cause.code !== 15) continue;
    const data = typeof cause.data === 'object' && cause.data !== null ? cause.data.data : cause.data;
    if (typeof data === 'string' && data.toLowerCase() === expected) return true;
  }
  return false;
}

async function observationRead(operation, run) {
  try { return await run(); }
  catch (cause) { throw new DeploymentError(`Read-only observation failed at ${operation}`, { cause }); }
}

export async function observeAdversarialCase(pub, context, entry) {
  const { addresses, artifact, latest, source, sourceParams, sourcePlaintext } = context;
  const abi = artifact.abi, id = BigInt(entry.triggerId);
  const reason = entry.scenario === 'wrong-key' ? 5 : 1;
  requireThat(scenarios.includes(entry.scenario) && entry.expectedReason === reason
    && same(entry.hook, context.registry ?? entry.hook) && entry.keyCommit === keccak256(key), 'Invalid synthetic rejection scenario');
  const read = (functionName, args) => observationRead(`registry ${functionName}`,
    () => pub.readContract({ address: entry.hook, abi, functionName, args }));
  const [parties, hookMeta, meta, record, binding] = await Promise.all([
    observationRead('market postingParties', () => pub.readContract({ address: addresses.market, abi: triggerMarketAbi, functionName: 'postingParties', args: [id] })),
    observationRead('market hookMeta', () => pub.readContract({ address: addresses.market, abi: triggerMarketAbi, functionName: 'hookMeta', args: [id] })),
    observationRead('market triggerMeta', () => pub.readContract({ address: addresses.market, abi: triggerMarketAbi, functionName: 'triggerMeta', args: [id] })),
    read('statusOf', [entry.reportId]), read('bindings', [id])
  ]);
  requireThat(same(parties[0], entry.author) && same(parties[1], entry.payer) && same(hookMeta[0], entry.hook)
    && meta[0] === 1 && meta[4] === BigInt(entry.window.t1) && meta[5] === BigInt(entry.window.t2)
    && meta[3] === meta[5] && meta[6] === entry.commit, 'Adversarial parties, hook, window or commitment differs from chain');
  const copied = entry.scenario === 'copy-foreign';
  if (copied) {
    requireThat(source && entry.reportId === source.reportId && entry.cipherHash === source.cipherHash
      && entry.keyCommit === source.keyCommit && !same(entry.author, source.researcher)
      && record.disclosed && record.lastTriggerId === BigInt(source.triggerId) && !binding[1],
    'Copied trigger changed the original disclosure or binding');
    await observationRead('original registry binding', () => verifyRegistryBinding(pub, entry.hook, abi, source));
    let unauthorized = false;
    await observationRead('foreign bind simulation', async () => {
      try { await pub.simulateContract({ account: entry.author, address: entry.hook, abi,
        functionName: 'bindTrigger', args: [entry.reportId, id] }); }
      catch (error) { if (!unauthorizedRevert(error, abi)) throw error; unauthorized = true; }
    });
    requireThat(unauthorized, 'Foreign author binding must reject as Unauthorized');
  } else {
    requireThat(entry.reportId === reportIdFor(entry.author, entry.cipherHash, entry.keyCommit)
      && same(record.researcher, entry.author) && record.cipherHash === entry.cipherHash && record.keyCommit === entry.keyCommit
      && record.t1 === meta[4] && record.t2 === meta[5] && record.rootReportId === entry.reportId
      && !record.disclosed && !await read('lineageDisclosed', [record.rootReportId]), 'Rejected report was altered or disclosed');
    if (entry.scenario === 'wrong-key') await observationRead('wrong-key registry binding',
      () => verifyRegistryBinding(pub, entry.hook, abi, { ...entry, researcher: entry.author }));
    else requireThat(!binding[1] && record.lastTriggerId === 0n, 'Unbound scenario unexpectedly has a binding');
    const registrations = entry.transactions.filter(tx => tx.call === 'register');
    requireThat(registrations.length === 1, 'Rejection proof needs a unique registration');
    verifyRegistryReceipt(await observationRead('registration receipt',
      () => pub.getTransactionReceipt({ hash: registrations[0].hash })), entry.hook, abi,
      'Registered', { ...entry, researcher: entry.author });
  }
  const transactions = [];
  for (const tx of entry.transactions) {
    const receipt = await observationRead('tracked transaction receipt', () => pub.getTransactionReceipt({ hash: tx.hash }));
    requireThat(receipt.transactionHash === tx.hash && receipt.status === 'success' && same(receipt.from, entry.payer),
      'Adversarial transaction has a foreign payer or failed receipt');
    transactions.push({ call: tx.call, ...receiptEvidence(receipt) });
  }
  const postName = copied ? 'postTriggerSponsored' : 'postTrigger';
  const posts = entry.transactions.filter(tx => tx.call === postName);
  requireThat(posts.length === 1, 'Rejection proof needs a unique matching post');
  const [post, postReceipt] = await Promise.all([
    observationRead('posted transaction', () => pub.getTransaction({ hash: posts[0].hash })),
    observationRead('post receipt', () => pub.getTransactionReceipt({ hash: posts[0].hash }))
  ]);
  const decoded = decodeFunctionData({ abi: triggerMarketAbi, data: post.input });
  const params = decoded.args[0];
  const posted = parseEventLogs({ abi: triggerMarketAbi, eventName: 'TriggerPosted', strict: true,
    logs: postReceipt.logs.filter(log => same(log.address, addresses.market)) });
  requireThat(same(post.to, addresses.market) && same(post.from, entry.payer) && post.value === BigInt(entry.escrowWei)
    && decoded.functionName === postName && params.commit === meta[6] && posted.length === 1 && posted[0].args.triggerId === id
    && postReceipt.blockNumber === BigInt(entry.postBlock), 'Adversarial post receipt, calldata or escrow differs from evidence');
  if (copied) requireThat(sourceParams && params.commit === sourceParams.commit && params.k === sourceParams.k
    && params.keyIds.length === sourceParams.keyIds.length && params.keyIds.every((value, i) => value === sourceParams.keyIds[i])
    && params.layers.length === sourceParams.layers.length && params.layers.every((value, i) => value === sourceParams.layers[i]),
  'Copied post does not contain the original encrypted layers and key slots');
  const transfers = parseEventLogs({ abi: nilAbi, eventName: 'Transfer', strict: true,
    logs: postReceipt.logs.filter(log => same(log.address, addresses.nil)) });
  const nilDebit = transfers.reduce((sum, log) => sum + (same(log.args.from, entry.payer) ? log.args.value : 0n)
    - (same(log.args.to, entry.payer) ? log.args.value : 0n), 0n);
  requireThat(nilDebit === BigInt(entry.feeNil), 'Actual NIL transfer debit differs from the fee evidence');
  const fromBlock = BigInt(entry.postBlock);
  const [marketLogs, hookLogs] = await Promise.all([
    observationRead('market event scan', () => pub.getContractEvents({ address: addresses.market, abi: triggerMarketAbi, args: { triggerId: id }, fromBlock, toBlock: latest.number, strict: true })),
    observationRead('registry event scan', () => pub.getContractEvents({ address: entry.hook, abi, args: { triggerId: id }, fromBlock, toBlock: latest.number, strict: true }))
  ]);
  const watched = (logs, address) => logs.filter(log => log.args.triggerId === id).map(log => {
    requireThat(!log.removed && same(log.address, address) && log.blockNumber >= fromBlock && log.blockNumber <= latest.number,
      'Rejection event is removed, foreign or outside the requested block range');
    return log;
  }).sort((a, b) => a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : (a.logIndex ?? 0) - (b.logIndex ?? 0));
  const events = watched(marketLogs, addresses.market), registryEvents = watched(hookLogs, entry.hook);
  requireThat(!registryEvents.some(log => log.eventName === 'Disclosed'), 'Rejected trigger unexpectedly disclosed a report');
  const reveals = events.filter(log => log.eventName === 'TriggerResolved');
  requireThat(reveals.length <= 1, 'Rejected trigger has duplicate reveal events');
  const base = { scenario: entry.scenario, triggerId: id, reportId: entry.reportId, transactions, nilDebit,
    sourceBlock: latest.number, sourceTimestamp: latest.timestamp, measurementsComplete: false, unauthorizedDisclosure: false };
  if (!reveals.length) return { ...base, status: latest.timestamp > meta[3] ? 'expired-without-rejection' : 'pending' };
  const reveal = reveals[0];
  const receipt = await observationRead('reveal receipt', () => pub.getTransactionReceipt({ hash: reveal.transactionHash }));
  const proof = verifyRejectionReceipt(receipt, { ...entry, market: addresses.market }, abi);
  const plaintext = hexToBytes(proof.plaintext);
  requireThat(plaintext.length === 96 && (copied ? toHex(plaintext) === toHex(sourcePlaintext)
    : toHex(plaintext.subarray(0, 64)) === toHex(rejectionPayload(entry.scenario, key, entry.reportId))),
  'Rejected reveal differs from the expected synthetic payload');
  const revealedBlock = await observationRead('reveal block', () => pub.getBlock({ blockNumber: reveal.blockNumber }));
  const share = events.find(log => log.eventName === 'SharePosted');
  const firstShareBlock = share ? await observationRead('first share block', () => pub.getBlock({ blockNumber: share.blockNumber })) : undefined;
  requireThat(revealedBlock.timestamp >= meta[4], 'Rejection reveal arrived before the configured start');
  const refundReconciliation = reconcileRefunds({ deposited: BigInt(entry.escrowWei), remaining: meta[10], owed: meta[11], events });
  let hookTrace;
  try {
    const trace = await pub.request({ method: 'debug_traceTransaction', params: [reveal.transactionHash, { tracer: 'callTracer' }] });
    hookTrace = measureHookTrace(trace, { market: addresses.market, hook: entry.hook, abi, triggerId: id,
      commit: meta[6], gasLimit: BigInt(hookMeta[1]) });
  } catch (error) {
    if (error instanceof DeploymentError) throw error;
    hookTrace = { status: 'unavailable', failure: publicFailure(error) };
  }
  const measurementsComplete = hookTrace.status === 'measured' && hookTrace.withinDeclaredBudget && hookTrace.forwardingCapped
    && meta[10] === 0n && meta[11] === 0n && Boolean(firstShareBlock) && firstShareBlock.timestamp >= meta[4];
  return { ...base, status: measurementsComplete ? 'rejected-verified' : 'rejected-incomplete',
    expectedRejectionVerified: true, reason: proof.reason, hookAcknowledged: proof.hookAcknowledged,
    originalBindingPreserved: copied ? true : undefined, foreignBindingRejection: copied ? 'Unauthorized' : undefined,
    reportRemainsUndisclosed: copied ? undefined : true, revealTransaction: receiptEvidence(receipt),
    revealUnix: revealedBlock.timestamp, revealDeltaSecs: revealedBlock.timestamp - meta[4],
    earliestShareUnix: firstShareBlock?.timestamp, earliestShareDeltaSecs: firstShareBlock ? firstShareBlock.timestamp - meta[4] : undefined,
    hookTrace, refundReconciliation, measurementsComplete };
}

export async function runAdversarialObserveCommand(argv, services = {}) {
  const print = services.print ?? console.log, diagnostic = services.diagnostic ?? console.error;
  const result = { observerVersion: 2, startedAt: new Date().toISOString(),
    chainId: 11155111, status: 'incomplete', cases: [], measurementsComplete: false, g1Decision: 'pending' };
  let out, ownsOutput = false, stage = 'configuration';
  const save = async () => { if (ownsOutput) await writeFile(out, json(result) + '\n'); };
  try {
    const { values } = parseArgs({ args: argv, options: { source: { type: 'string', multiple: true }, out: { type: 'string' } } });
    requireThat(values.source?.length && values.out, 'Use --source POSTS.json [--source MORE_POSTS.json] --out FRESH.json');
    out = values.out; await mkdir(dirname(out), { recursive: true, mode: 0o700 });
    await writeFile(out, json(result) + '\n', { flag: 'wx', mode: 0o600 }); ownsOutput = true;
    const pub = (services.client ?? probeClient)(); stage = 'chain guard';
    requireThat(await pub.getChainId() === 11155111, 'Adversarial observer requires Sepolia');
    stage = 'source evidence';
    const posts = await Promise.all(values.source.map(load));
    const first = posts[0];
    requireThat(posts.every(value => value.chainId === 11155111 && value.registry === first.registry && value.market === first.market
      && value.sourceEvidence === first.sourceEvidence && value.sourceTriggerId === first.sourceTriggerId && Array.isArray(value.cases)),
    'Adversarial source files must describe the same deployment and original disclosure');
    const cases = posts.flatMap(value => value.cases);
    requireThat(cases.length > 0 && cases.length <= 3 && new Set(cases.map(entry => entry.scenario)).size === cases.length
      && cases.every(entry => scenarios.includes(entry.scenario) && entry.status === 'posted-awaiting-rejection'
        && entry.triggerId !== undefined && entry.postBlock !== undefined && same(entry.hook, first.registry)
        && same(entry.payer, first.payer) && Array.isArray(entry.transactions)), 'Sources need unique posted synthetic cases with tracked receipts');
    stage = 'deployment and accepted original';
    const addresses = await resolveSepolia(pub, services.expectedMarket ?? process.env.EXPECTED_MARKET);
    requireThat(same(addresses.market, first.market), 'Adversarial source market is stale');
    const artifact = (await compileContracts()).DisclosureRegistry;
    const deploymentVerification = await verifyHookDeployment(pub, first.registry, artifact, addresses.market);
    const source = await load(first.sourceEvidence);
    requireThat(source.chainId === 11155111 && source.mode === 'sponsored' && source.triggerId === first.sourceTriggerId
      && source.reportId === first.sourceReportId && same(source.hook, first.registry) && same(source.market, addresses.market)
      && source.keyCommit === keccak256(key)
      && source.cipherHash === keccak256(new TextEncoder().encode('Pluto M0 synthetic report; not a vulnerability'))
      && source.fundingDecision?.decision === 'go' && source.observation?.measurementsComplete,
    'Original must be the accepted synthetic sponsorship proof');
    await verifyRegistryBinding(pub, source.hook, artifact.abi, source);
    const sourceReceipt = await pub.getTransactionReceipt({ hash: first.sourceRevealHash });
    const sourceReveals = parseEventLogs({ abi: triggerMarketAbi, eventName: 'TriggerResolved', strict: true,
      logs: sourceReceipt.logs.filter(log => same(log.address, addresses.market)) }).filter(log => log.args.triggerId === BigInt(source.triggerId));
    requireThat(sourceReceipt.status === 'success' && first.sourceRevealHash === source.observation.hookAcceptanceHash
      && sourceReveals.length === 1, 'Original accepted reveal receipt is missing');
    const sourcePlaintext = hexToBytes(sourceReveals[0].args.plaintext);
    const disclosures = parseEventLogs({ abi: artifact.abi, eventName: 'Disclosed', strict: true,
      logs: sourceReceipt.logs.filter(log => same(log.address, source.hook)) });
    requireThat(sourcePlaintext.length === 96 && toHex(sourcePlaintext.subarray(0, 32)) === toHex(key)
      && toHex(sourcePlaintext.subarray(32, 64)) === source.reportId && keccak256(sourcePlaintext) === first.originalCommit
      && disclosures.length === 1 && disclosures[0].args.reportId === source.reportId
      && disclosures[0].args.triggerId === BigInt(source.triggerId) && disclosures[0].args.key === toHex(key),
    'Original receipt does not prove the expected accepted synthetic report');
    const originalPosts = source.transactions.filter(tx => tx.call === 'postTriggerSponsored');
    requireThat(originalPosts.length === 1, 'Original proof needs one sponsored post');
    const originalPost = await pub.getTransaction({ hash: originalPosts[0].hash });
    const originalCall = decodeFunctionData({ abi: triggerMarketAbi, data: originalPost.input });
    requireThat(same(originalPost.to, addresses.market) && originalCall.functionName === 'postTriggerSponsored'
      && originalCall.args[0].commit === first.originalCommit, 'Original post differs from its accepted reveal');
    const latest = await pub.getBlock();
    Object.assign(result, { sources: values.source, market: addresses.market, registry: first.registry, sourceTriggerId: first.sourceTriggerId,
      deploymentVerification, suiteComplete: cases.length === scenarios.length });
    for (const entry of cases) {
      stage = entry.scenario + ' observation';
      result.cases.push(await observeAdversarialCase(pub, { addresses, artifact, latest, source,
        sourceParams: originalCall.args[0], sourcePlaintext, registry: first.registry }, entry));
      await save();
    }
    result.measurementsComplete = result.suiteComplete && result.cases.every(entry => entry.measurementsComplete);
    result.status = result.measurementsComplete ? 'passed' : 'incomplete'; await save(); print(json(result));
    return result.measurementsComplete ? 0 : 2;
  } catch (error) {
    Object.assign(result, { status: 'failed', failedStage: stage, failure: publicFailure(error), measurementsComplete: false });
    try { await save(); } catch { result.evidenceWriteFailed = true; }
    diagnostic(json(result)); return 1;
  }
}

if (import.meta.main) process.exitCode = await runAdversarialObserveCommand(process.argv.slice(2));
