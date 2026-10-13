import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import sdkPackage from '@nillion/covenants-sdk/package.json' with { type: 'json' };
import { createWalletClient, getAddress, hexToBytes, http, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createAuthorKey, authorKeySigner, nilAbi, postSealed, postSponsored, quoteEscrow,
  quoteProtocolFee, seal, signPostAuthorization, SPONSORED_POST_TYPES, triggerMarketAbi } from '@nillion/covenants-sdk';
import { postParamsTuple } from '@nillion/covenants-sdk/browser';
import { DeploymentError } from '../src/chain/deployment.mjs';
import { inspectFeasibility } from '../src/chain/feasibility.mjs';
import { compileDisclosureWindow, encodeDisclosurePayload, reportIdFor } from '../src/shared/disclosure.mjs';
import { registryDomain, signRegistryAction } from '../src/shared/registry-authorization.mjs';
import { verifyHookDeployment, verifyRegistryReceipt, verifyRegistryBinding } from '../src/chain/registry-verification.mjs';
import { sponsorshipDecision } from '../src/chain/spike-observation.mjs';
import { assertSponsorshipBudget, boundaryCases, simulateRejections, simulateWindowWidths, sponsoredMutations } from './lib/spike-checks.mjs';
import { compileContracts } from './lib/contracts.mjs';
import { json, probeClient, publicFailure, receiptEvidence, revertedName } from './lib/probe-runtime.mjs';

// Synthetic M0 data only. This known key must never encrypt a real report.
const sampleKey = new Uint8Array(32).fill(7);
const cipherHash = keccak256(new TextEncoder().encode('Pluto M0 synthetic report; not a vulnerability'));
const usage = 'Usage: spike:sepolia -- hello|sponsored [--out FRESH_EVIDENCE.json]';

export async function runSpikeCommand(argv, { client = probeClient, payerKey = process.env.AUTHOR_KEY,
  expectedMarket = process.env.EXPECTED_MARKET, inspect = inspectFeasibility,
  walletFactory = payer => createWalletClient({ account: payer, chain: sepolia,
    transport: http(process.env.RPC_URL, { timeout: 10000, retryCount: 0 }) }),
  print = console.log, diagnostic = console.error } = {}) {
  let mode;
  const evidence = { status: 'incomplete', chainId: sepolia.id, sdkVersion: sdkPackage.version,
    transactions: [], rejectionChecks: [], boundaryChecks: [] };
  let stage = 'configuration';
  let evidencePath;
  let ownsOutput = false;
  async function save() {
    if (ownsOutput) await writeFile(evidencePath, json(evidence) + '\n');
  }

  async function main() {
    let values, positionals;
    try { ({ values, positionals } = parseArgs({ args: argv, strict: true, allowPositionals: true,
      options: { out: { type: 'string' }, help: { type: 'boolean' } } })); } catch { throw new DeploymentError(usage); }
    if (values.help) { print(usage); return; }
    mode = positionals[0];
    if (!['hello', 'sponsored'].includes(mode) || positionals.length !== 1) throw new DeploymentError(usage);
    evidence.mode = mode;
    evidence.fundingDecision = sponsorshipDecision(evidence);
    evidencePath = resolve(values.out ?? `artifacts/m0/${mode}-${randomUUID()}.json`);
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, json(evidence) + '\n', { flag: 'wx', mode: 0o600 });
    ownsOutput = true;
    if (!payerKey) throw new DeploymentError('AUTHOR_KEY must hold the Sepolia payer key in the environment');
    const pub = client();
    stage = 'deployment and live feasibility';
    const plan = await inspect(pub, expectedMarket);
    const payer = privateKeyToAccount(payerKey);
    const baseWallet = walletFactory(payer);
    stage = 'payer funds';
    const funds = await quoteProtocolFee(pub, plan.addresses, payer.address);
    if (funds.balanceNil < funds.feeNil || await pub.getBalance({ address: payer.address }) === 0n) {
      throw new DeploymentError('Payer needs Sepolia ETH and NIL on the token resolved from C0');
    }
    const researcher = mode === 'sponsored' ? authorKeySigner(createAuthorKey()) : payer;
    async function researcherFunds() {
      const [ethWei, nilWei, nonce] = await Promise.all([
        pub.getBalance({ address: researcher.address }),
        pub.readContract({ address: plan.addresses.nil, abi: nilAbi, functionName: 'balanceOf', args: [researcher.address] }),
        pub.getTransactionCount({ address: researcher.address }),
      ]);
      return { ethWei, nilWei, nonce };
    }
    if (mode === 'sponsored') {
      evidence.researcherFundsBefore = await researcherFunds();
      if (evidence.researcherFundsBefore.ethWei !== 0n || evidence.researcherFundsBefore.nilWei !== 0n
          || evidence.researcherFundsBefore.nonce !== 0) throw new DeploymentError('Sponsorship proof requires a fresh zero-ETH, zero-NIL researcher');
    }
    const artifacts = await compileContracts();
    const artifact = mode === 'hello' ? artifacts.HelloRevealHook : artifacts.DisclosureRegistry;
    Object.assign(evidence, { researcher: researcher.address, payer: payer.address,
      payerNilBefore: funds.balanceNil,
      market: plan.addresses.market, config: plan.addresses.config, parameters: plan.parameters,
      compiler: artifact.compiler, payloadBytes: 64 });
    await save();
    // Persist every submitted hash before waiting; approval, register and bind are included.
    const wallet = { ...baseWallet, async writeContract(args) {
      const hash = await baseWallet.writeContract(args);
      evidence.transactions.push({ call: args.functionName, hash });
      await save();
      return hash;
    } };
    async function confirm(hash) {
      const receipt = await pub.waitForTransactionReceipt({ hash });
      const entry = evidence.transactions.find(tx => tx.hash === hash);
      Object.assign(entry, receiptEvidence(receipt));
      await save();
      if (receipt.status !== 'success') throw new DeploymentError('M0 transaction reverted; see the recorded hash');
      if (getAddress(receipt.from) !== getAddress(payer.address)) throw new DeploymentError('M0 receipt sender differs from the protocol payer');
      return receipt;
    }
    async function call(abi, address, functionName, args) {
      const simulation = await pub.simulateContract({ abi, address, functionName, args, account: payer });
      return confirm(await wallet.writeContract(simulation.request));
    }
    async function rejects(label, operation, names) {
      try { await operation(); } catch (error) {
        const name = revertedName(error);
        if (!names.includes(name)) throw error;
        evidence.rejectionChecks.push({ label, error: name });
        await save();
        return;
      }
      throw new DeploymentError(`Authorization unexpectedly accepted: ${label}`);
    }

    stage = 'hook deployment';
    const deployHash = await baseWallet.deployContract({ ...artifact, args: [plan.addresses.market] });
    evidence.transactions.push({ call: 'deploy', hash: deployHash });
    await save();
    const deployed = await confirm(deployHash);
    const hook = deployed.contractAddress;
    if (!hook) throw new DeploymentError('Deployment receipt has no hook address');
    evidence.deploymentVerification = await verifyHookDeployment(pub, hook, artifact, plan.addresses.market);
    const block = await pub.getBlock();
    const window = compileDisclosureWindow({ nowUnix: block.timestamp, t1: block.timestamp + 900n,
      t2: block.timestamp + 4500n });
    const reportId = reportIdFor(researcher.address, cipherHash, keccak256(sampleKey));
    const sealed = seal(encodeDisclosurePayload(sampleKey, reportId), window.mode, window.conditionRecord,
      plan.committee.k, plan.committee.keys.map(key => hexToBytes(key.mpk)));
    const args = { ...window, keys: plan.committee.keys, k: plan.committee.k,
      layers: sealed.layers, commit: sealed.commit, publicCondition: sealed.publicCondition,
      ceilingWei: plan.ceilingWei, hook, hookGasLimit: plan.parameters.defaultHookGas,
      feeApprovalAmount: funds.feeNil, skipLivenessCheck: true };
    const quote = await quoteEscrow(pub, plan.addresses.market, { ...args,
      keyIds: args.keys.map(key => key.keyId), maxLayerLen: plan.layerLength });
    Object.assign(evidence, { hook, reportId, window: { t1: window.t1, t2: window.t2 },
      cipherHash, keyCommit: keccak256(sampleKey), ceilingWei: args.ceilingWei, quote,
      committee: args.keys.map(key => ({ nodeId: key.nodeId, keyId: key.keyId, operator: key.operator })) });
    await save();

    stage = 'NIL approval';
    if (funds.allowanceNil < funds.feeNil) await call(nilAbi, plan.addresses.nil, 'approve', [plan.addresses.market, funds.feeNil]);
    stage = 'window and ciphertext simulations';
    const params = postParamsTuple(args);
    const simulation = { account: payer.address, address: plan.addresses.market, abi: triggerMarketAbi,
      functionName: 'postTrigger', args: [params], value: quote.escrowWei };
    await simulateRejections(pub, simulation, boundaryCases(params, plan.parameters, (await pub.getBlock()).timestamp),
      async check => { evidence.boundaryChecks.push(check); await save(); });
    evidence.windowWidthChecks = [];
    await simulateWindowWidths(pub, simulation,
      async check => { evidence.windowWidthChecks.push(check); await save(); });
    let authorization;
    if (mode === 'sponsored') {
      stage = 'signed registration';
      const domain = registryDomain(sepolia.id, hook);
      const fields = { cipherHash, keyCommit: evidence.keyCommit, t1: window.t1, t2: window.t2 };
      const grant = { payer: payer.address, nonce: 0n, deadline: window.t1 - 1n };
      const auth = await signRegistryAction(researcher, domain, 'RegisterReport', fields, grant);
      const registrationControl = { account: payer.address, address: hook, abi: artifact.abi,
        functionName: 'registerBySig', args: [...Object.values(fields), auth] };
      await simulateRejections(pub, registrationControl, [
        ...Object.keys(fields).map(field => ({ label: `registry ${field}`, errors: ['InvalidAuthorization'],
          args: [...Object.values({ ...fields, [field]: field.startsWith('t') ? fields[field] + 1n : keccak256(fields[field]) }), auth] })),
        ...['researcher', 'payer', 'nonce', 'deadline'].map(field => ({ label: `registry ${field}`, errors: ['InvalidAuthorization'],
          args: [...Object.values(fields), { ...auth, [field]: ['researcher', 'payer'].includes(field)
            ? (field === 'payer' ? hook : payer.address) : auth[field] + 1n }] })),
      ], async check => { evidence.rejectionChecks.push({ scope: 'registry registration', ...check }); await save(); });
      const registered = await call(artifact.abi, hook, 'registerBySig', registrationControl.args);
      evidence.registryEvents = [verifyRegistryReceipt(registered, hook, artifact.abi, 'Registered', evidence)];
      await rejects('reused registration grant', () => pub.simulateContract({ account: payer.address,
        address: hook, abi: artifact.abi, functionName: 'registerBySig', args: [...Object.values(fields), auth] }), ['InvalidAuthorization']);
      stage = 'market authorization';
      authorization = await signPostAuthorization(pub, researcher, plan.addresses, { ...args,
        payer: payer.address, minCeilingWei: args.ceilingWei, skipViabilityCheck: true });
      assertSponsorshipBudget(args, authorization, evidence.ceilingWei);
      evidence.signedMarketFields = SPONSORED_POST_TYPES.SponsoredPost.map(field => field.name);
      evidence.ceilingPolicy = 'SDK signs the minimum; this payer caps the posted ceiling at the recorded quote';
      await simulateRejections(pub, { ...simulation, functionName: 'postTriggerSponsored', args: [params, authorization] },
        sponsoredMutations(params, authorization, { alternateHook: plan.addresses.market }),
        async check => { evidence.rejectionChecks.push({ scope: 'market', ...check }); await save(); });
    }
    stage = 'post';
    // Revalidate margin immediately before sending. The SDK quotes the exact escrow itself.
    compileDisclosureWindow({ nowUnix: (await pub.getBlock()).timestamp, t1: window.t1, t2: window.t2 });
    if (authorization) assertSponsorshipBudget(args, authorization, evidence.ceilingWei);
    const posted = mode === 'hello' ? await postSealed(pub, wallet, plan.addresses, args)
      : await postSponsored(pub, wallet, plan.addresses, { ...args, authorization });
    const postReceipt = await confirm(posted.txHash);
    Object.assign(evidence, { triggerId: posted.triggerId, postBlock: postReceipt.blockNumber,
      escrowWei: posted.escrowWei, feeNil: posted.feeNil });
    await save();
    stage = 'recorded hook and parties';
    const meta = await pub.readContract({ address: plan.addresses.market, abi: triggerMarketAbi,
      functionName: 'hookMeta', args: [posted.triggerId] });
    const parties = await pub.readContract({ address: plan.addresses.market, abi: triggerMarketAbi,
      functionName: 'postingParties', args: [posted.triggerId] });
    if (getAddress(meta[0]) !== getAddress(hook) || getAddress(parties[0]) !== getAddress(researcher.address)
        || getAddress(parties[1]) !== getAddress(payer.address)) throw new DeploymentError('Recorded hook or author/payer mismatch');
    evidence.recordedHookGas = meta[1];
    if (mode === 'sponsored') {
      stage = 'signed binding';
      const auth = await signRegistryAction(researcher, registryDomain(sepolia.id, hook), 'BindReport',
        { reportId, triggerId: posted.triggerId }, { payer: payer.address, nonce: 1n, deadline: window.t1 - 1n });
      const bindControl = { account: payer.address, address: hook, abi: artifact.abi, functionName: 'bindBySig',
        args: [reportId, posted.triggerId, auth] };
      await simulateRejections(pub, bindControl, [
        { label: 'binding report', args: [cipherHash, posted.triggerId, auth], errors: ['InvalidAuthorization'] },
        { label: 'binding trigger', args: [reportId, posted.triggerId + 1n, auth], errors: ['InvalidAuthorization'] },
        { label: 'binding payer', args: [reportId, posted.triggerId, { ...auth, payer: hook }], errors: ['InvalidAuthorization'] },
      ], async check => { evidence.rejectionChecks.push({ scope: 'registry binding', ...check }); await save(); });
      const bound = await call(artifact.abi, hook, 'bindBySig', bindControl.args);
      evidence.registryEvents.push(verifyRegistryReceipt(bound, hook, artifact.abi, 'Bound', evidence));
      evidence.registryBinding = await verifyRegistryBinding(pub, hook, artifact.abi, evidence);
      await rejects('reused binding grant', () => pub.simulateContract(bindControl), ['InvalidAuthorization']);
      await rejects('reused market grant', () => pub.simulateContract({ account: payer.address,
        address: plan.addresses.market, abi: triggerMarketAbi, functionName: 'postTriggerSponsored',
        args: [postParamsTuple(args), authorization], value: posted.escrowWei }), ['AuthConsumed']);
      evidence.researcherFundsAfter = await researcherFunds();
      if (evidence.researcherFundsAfter.ethWei !== 0n || evidence.researcherFundsAfter.nilWei !== 0n
          || evidence.researcherFundsAfter.nonce !== evidence.researcherFundsBefore.nonce) {
        throw new DeploymentError('Researcher funds or transaction count changed during sponsorship proof');
      }
      evidence.sponsorshipVerified = true;
    }
    evidence.payerNilAfter = await pub.readContract({ address: plan.addresses.nil, abi: nilAbi,
      functionName: 'balanceOf', args: [payer.address] });
    evidence.fundingDecision = sponsorshipDecision(evidence);
    evidence.status = 'posted-awaiting-observation';
    await save();
    print(json({ evidenceFile: evidencePath, ...evidence }));
  }

  try { await main(); return 0; } catch (error) {
    evidence.status = 'failed';
    evidence.failedStage = stage;
    evidence.failure = error.code === 'EEXIST' ? { detail: 'Evidence output already exists; choose a fresh --out path', codes: ['EEXIST'] } : publicFailure(error);
    evidence.fundingDecision = sponsorshipDecision(evidence);
    let saved = false;
    try { await save(); saved = ownsOutput; } catch { evidence.evidenceWriteFailed = true; }
    print(json({ evidenceFile: saved ? evidencePath : undefined, ...evidence }));
    diagnostic(`Sepolia spike failed at ${stage}: ${evidence.failure.detail}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runSpikeCommand(process.argv.slice(2));
