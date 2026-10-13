import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { createWalletClient, decodeFunctionData, getAddress, hexToBytes, http, keccak256, parseEventLogs, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { authorKeySigner, createAuthorKey, postSealed, postSponsored, quoteProtocolFee, seal,
  selectCommitteeByNodeIds, signPostAuthorization, triggerMarketAbi } from '@nillion/covenants-sdk';
import { DeploymentError } from '../src/chain/deployment.mjs';
import { inspectFeasibility } from '../src/chain/feasibility.mjs';
import { verifyHookDeployment, verifyRegistryBinding, verifyRegistryReceipt } from '../src/chain/registry-verification.mjs';
import { compileDisclosureWindow, reportIdFor } from '../src/shared/disclosure.mjs';
import { compileContracts } from './lib/contracts.mjs';
import { rejectionPayload, copyPublicSeal, selectAdversarialScenarios } from './lib/adversarial-probes.mjs';
import { json, probeClient, publicFailure, receiptEvidence, revertedName } from './lib/probe-runtime.mjs';
import { readLimited } from './lib/researcher-files.mjs';

// Uses only the publicly known synthetic M0 key. Never accepts a recovery bundle.
const key = new Uint8Array(32).fill(7);
const syntheticHash = keccak256(new TextEncoder().encode('Pluto M0 synthetic report; not a vulnerability'));

export async function runAdversarialCommand(argv, services = {}) {
  const print = services.print ?? console.log, diagnostic = services.diagnostic ?? console.error;
  const evidence = { status: 'incomplete', chainId: 11155111, cases: [] };
  let out, ownsOutput = false, stage = 'configuration';
  const save = async () => { if (ownsOutput) await writeFile(out, json(evidence) + '\n'); };
  try {
    const { values } = parseArgs({ args: argv, options: { source: { type: 'string' }, out: { type: 'string' },
      only: { type: 'string', multiple: true } } });
    if (!values.source || !values.out) throw new DeploymentError('Use --source ACCEPTED_SYNTHETIC_M0.json --out FRESH.json [--only SCENARIO]');
    const selectedScenarios = selectAdversarialScenarios(values.only);
    evidence.selectedScenarios = selectedScenarios;
    out = values.out; await mkdir(dirname(out), { recursive: true });
    await writeFile(out, json(evidence) + '\n', { flag: 'wx', mode: 0o600 }); ownsOutput = true;
    const pub = (services.client ?? probeClient)(); stage = 'chain guard';
    if (await pub.getChainId() !== 11155111) throw new DeploymentError('Adversarial probes require Sepolia');
    stage = 'synthetic accepted source';
    const source = JSON.parse(new TextDecoder().decode(await readLimited(values.source, 4 * 1024 * 1024)));
    if (source.mode !== 'sponsored' || source.cipherHash !== syntheticHash || source.keyCommit !== keccak256(key)
        || source.observation?.state !== 'revealed-accepted' || !source.observation?.measurementsComplete
        || source.fundingDecision?.decision !== 'go') throw new DeploymentError('Source must be the accepted synthetic M0 sponsorship proof');
    const artifact = (await compileContracts()).DisclosureRegistry;
    const receipt = await pub.getTransactionReceipt({ hash: source.observation.hookAcceptanceHash });
    const reveals = parseEventLogs({ abi: triggerMarketAbi, eventName: 'TriggerResolved', strict: true,
      logs: receipt.logs.filter(log => log.address.toLowerCase() === source.market.toLowerCase()) });
    const revealed = reveals.find(log => log.args.triggerId === BigInt(source.triggerId));
    const originalPlaintext = revealed ? hexToBytes(revealed.args.plaintext) : undefined;
    if (receipt.status !== 'success' || !originalPlaintext || originalPlaintext.length !== 96
        || toHex(originalPlaintext.slice(0, 32)) !== toHex(key)
        || toHex(originalPlaintext.slice(32, 64)) !== source.reportId) throw new DeploymentError('Source receipt does not reveal the expected synthetic payload');
    await verifyRegistryBinding(pub, source.hook, artifact.abi, source);
    const sourcePosts = source.transactions.filter(tx => tx.call === 'postTriggerSponsored');
    if (sourcePosts.length !== 1) throw new DeploymentError('Source must contain a unique sponsored post');
    const sourceTx = await pub.getTransaction({ hash: sourcePosts[0].hash });
    const sourceParams = decodeFunctionData({ abi: triggerMarketAbi, data: sourceTx.input }).args[0];
    if (getAddress(sourceTx.to) !== getAddress(source.market) || sourceParams.commit !== keccak256(originalPlaintext)) {
      throw new DeploymentError('Original ciphertext transaction differs from the accepted plaintext');
    }
    const payer = privateKeyToAccount(process.env.AUTHOR_KEY);
    const wallet = (services.walletFactory ?? (account => createWalletClient({ account, chain: sepolia,
      transport: http(process.env.RPC_URL, { timeout: 10000, retryCount: 0 }) })))(payer);
    Object.assign(evidence, { sourceTriggerId: source.triggerId, sourceReportId: source.reportId,
      sourceRevealHash: receipt.transactionHash, originalCommit: keccak256(originalPlaintext), registry: source.hook,
      payer: payer.address, sourceEvidence: values.source }); await save();
    for (const scenario of selectedScenarios) {
      stage = scenario + ' live feasibility';
      const plan = await (services.inspect ?? inspectFeasibility)(pub, process.env.EXPECTED_MARKET);
      if (getAddress(plan.addresses.market) !== getAddress(source.market)) throw new DeploymentError('Source market is stale');
      evidence.market = plan.addresses.market;
      evidence.deploymentVerification = await verifyHookDeployment(pub, source.hook, artifact, plan.addresses.market);
      const funds = await quoteProtocolFee(pub, plan.addresses, payer.address);
      if (funds.balanceNil < funds.feeNil) throw new DeploymentError('Payer needs the resolved NIL fee');
      const author = scenario === 'copy-foreign' ? authorKeySigner(createAuthorKey()) : payer;
      const cipherHash = scenario === 'copy-foreign' ? source.cipherHash : keccak256(randomBytes(32));
      const reportId = scenario === 'copy-foreign' ? source.reportId : reportIdFor(author.address, cipherHash, keccak256(key));
      const head = await pub.getBlock();
      const window = compileDisclosureWindow({ nowUnix: head.timestamp, t1: head.timestamp + 1200n, t2: head.timestamp + 4800n });
      const committee = scenario === 'copy-foreign' ? selectCommitteeByNodeIds(plan.candidates
        .filter(candidate => plan.pin.nodeIds.some(id => id === candidate.nodeId)),
        source.committee.map(candidate => BigInt(candidate.nodeId)), { k: sourceParams.k,
          minStake: plan.parameters.minStake, nowUnix: head.timestamp, mode: window.mode }) : plan.committee;
      if (scenario === 'copy-foreign' && committee.keys.some((candidate, i) => candidate.keyId !== sourceParams.keyIds[i])) {
        throw new DeploymentError('Original encrypted key slots have rotated; refuse stale copied ciphertext');
      }
      const mpks = committee.keys.map(candidate => hexToBytes(candidate.mpk));
      const sealed = scenario === 'copy-foreign'
        ? copyPublicSeal(sourceParams, window.conditionRecord)
        : seal(rejectionPayload(scenario, key, reportId), window.mode, window.conditionRecord, committee.k, mpks);
      const args = { ...window, keys: committee.keys, k: committee.k, layers: sealed.layers,
        commit: sealed.commit, publicCondition: sealed.publicCondition, ceilingWei: plan.ceilingWei, hook: source.hook,
        hookGasLimit: Number(plan.parameters.defaultHookGas), feeApprovalAmount: funds.feeNil, skipLivenessCheck: true };
      const entry = { scenario, expectedReason: scenario === 'wrong-key' ? 5 : 1, reportId, cipherHash,
        keyCommit: keccak256(key), author: author.address, payer: payer.address, window: { t1: window.t1, t2: window.t2 },
        commit: sealed.commit, hook: source.hook, transactions: [], status: 'prepared', payerNilBefore: funds.balanceNil };
      evidence.cases.push(entry); await save();
      const tracked = { ...wallet, async writeContract(request) {
        const hash = await wallet.writeContract(request); entry.transactions.push({ call: request.functionName, hash }); await save(); return hash;
      } };
      const confirm = async hash => {
        const confirmed = await pub.waitForTransactionReceipt({ hash });
        if (confirmed.status !== 'success' || getAddress(confirmed.from) !== payer.address) throw new DeploymentError('Adversarial transaction failed or has a foreign payer');
        Object.assign(entry.transactions.find(tx => tx.hash === hash), receiptEvidence(confirmed)); await save(); return confirmed;
      };
      const call = async (functionName, args) => {
        const simulated = await pub.simulateContract({ account: payer, address: source.hook, abi: artifact.abi, functionName, args });
        return confirm(await tracked.writeContract(simulated.request));
      };
      if (scenario !== 'copy-foreign') {
        const registered = await call('register', [cipherHash, entry.keyCommit, window.t1, window.t2]);
        entry.registration = verifyRegistryReceipt(registered, source.hook, artifact.abi, 'Registered', { ...entry, researcher: author.address }); await save();
      }
      stage = scenario + ' post';
      compileDisclosureWindow({ nowUnix: (await pub.getBlock()).timestamp, ...entry.window });
      const authorization = scenario === 'copy-foreign'
        ? await signPostAuthorization(pub, author, plan.addresses, { ...args, payer: payer.address, minCeilingWei: args.ceilingWei, skipViabilityCheck: true }) : undefined;
      const posted = authorization ? await postSponsored(pub, tracked, plan.addresses, { ...args, authorization })
        : await postSealed(pub, tracked, plan.addresses, args);
      const postedReceipt = await confirm(posted.txHash);
      Object.assign(entry, { triggerId: posted.triggerId, postBlock: postedReceipt.blockNumber, escrowWei: posted.escrowWei, feeNil: posted.feeNil }); await save();
      if (scenario === 'wrong-key') {
        const bound = await call('bindTrigger', [reportId, posted.triggerId]);
        entry.binding = verifyRegistryReceipt(bound, source.hook, artifact.abi, 'Bound', entry);
      } else if (scenario === 'copy-foreign') {
        let rejected = false;
        try { await pub.simulateContract({ account: author.address, address: source.hook, abi: artifact.abi,
          functionName: 'bindTrigger', args: [source.reportId, posted.triggerId] }); }
        catch (error) { if (revertedName(error) !== 'Unauthorized') throw error; rejected = true; }
        if (!rejected) throw new DeploymentError('Foreign author unexpectedly bound the copied report');
        entry.foreignBindingRejection = 'Unauthorized';
      }
      entry.payerNilAfter = await pub.readContract({ address: plan.addresses.nil, abi: (await import('@nillion/covenants-sdk')).nilAbi,
        functionName: 'balanceOf', args: [payer.address] });
      if (funds.balanceNil - entry.payerNilAfter !== posted.feeNil) throw new DeploymentError('Adversarial NIL debit does not reconcile');
      entry.status = 'posted-awaiting-rejection'; await save();
      diagnostic(json({ scenario, triggerId: entry.triggerId, window: entry.window, status: entry.status }));
    }
    evidence.status = 'posted-awaiting-observation'; await save(); print(json(evidence)); return 0;
  } catch (error) {
    evidence.status = 'failed'; evidence.failedStage = stage; evidence.failure = publicFailure(error);
    try { await save(); } catch { evidence.evidenceWriteFailed = true; }
    diagnostic(json({ status: evidence.status, failedStage: stage, failure: evidence.failure })); return 1;
  }
}

if (import.meta.main) process.exitCode = await runAdversarialCommand(process.argv.slice(2));
