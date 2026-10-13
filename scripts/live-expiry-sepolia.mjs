import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createWalletClient, getAddress, hexToBytes, http, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { compileCondition } from '@nillion/covenants-sdk/browser';
import { postSealed, quoteEscrow, quoteProtocolFee, seal } from '@nillion/covenants-sdk';
import { DeploymentError } from '../src/chain/deployment.mjs';
import { inspectFeasibility } from '../src/chain/feasibility.mjs';
import { verifyHookDeployment, verifyRegistryBinding, verifyRegistryReceipt } from '../src/chain/registry-verification.mjs';
import { encodeDisclosurePayload } from '../src/shared/disclosure.mjs';
import { prepareReport } from '../src/shared/report-crypto.mjs';
import { compileContracts } from './lib/contracts.mjs';
import { json, probeClient, publicFailure } from './lib/probe-runtime.mjs';
import { openJournal, writeExclusiveFiles } from './lib/researcher-files.mjs';

// Explicit synthetic wire-limit probe. Never change the product's minimum window.
export function expiryProbeWindow(nowUnix) {
  if (typeof nowUnix !== 'bigint' || nowUnix < 0n || nowUnix + 901n >= 1n << 64n) {
    throw new DeploymentError('Expiry probe time must fit uint64');
  }
  const t1 = nowUnix + 900n, t2 = t1 + 1n;
  return { mode: 'PUBLIC_CONDITION', ttl: 0, t1, t2, conditionRecord: compileCondition({ window: { t1, t2 } }) };
}

export async function runExpiryProbe(argv, services = {}) {
  const print = services.print ?? console.log, diagnostic = services.diagnostic ?? console.error;
  let out, journal, ownsOutput = false, stage = 'configuration';
  const evidence = { status: 'incomplete', chainId: 11155111, mode: 'researcher',
    scenario: 'synthetic one-second window: first-share expiry margin is insufficient', transactions: [] };
  const save = async () => { if (ownsOutput) await writeFile(out, json(evidence) + '\n'); };
  try {
    const { values } = parseArgs({ args: argv, options: Object.fromEntries(['out', 'dir', 'registry'].map(name => [name, { type: 'string' }])) });
    if (!values.out || !values.dir || !values.registry) throw new DeploymentError('Use --out FRESH.json --dir PRIVATE_DIR --registry ADDRESS');
    out = values.out;
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, json(evidence) + '\n', { flag: 'wx', mode: 0o600 }); ownsOutput = true;
    const pub = (services.client ?? probeClient)();
    stage = 'chain guard';
    if (await pub.getChainId() !== 11155111) throw new DeploymentError('Expiry probe requires Sepolia');
    stage = 'live feasibility';
    const plan = await (services.inspect ?? inspectFeasibility)(pub, process.env.EXPECTED_MARKET);
    stage = 'registry and payer verification';
    const artifact = (await compileContracts()).DisclosureRegistry;
    const registry = getAddress(values.registry);
    evidence.deploymentVerification = await verifyHookDeployment(pub, registry, artifact, plan.addresses.market);
    const account = privateKeyToAccount(process.env.AUTHOR_KEY);
    const wallet = (services.walletFactory ?? (account => createWalletClient({ account, chain: sepolia,
      transport: http(process.env.RPC_URL, { timeout: 10000, retryCount: 0 }) })))(account);
    const funds = await quoteProtocolFee(pub, plan.addresses, account.address);
    if (funds.balanceNil < funds.feeNil) throw new DeploymentError('Payer needs the resolved NIL protocol fee');
    const plaintext = new TextEncoder().encode('Pluto synthetic controlled expiry and immutable retry proof; not a vulnerability.');
    stage = 'local synthetic preparation';
    const bundle = await prepareReport(plaintext, account.address);
    await writeExclusiveFiles([[join(values.dir, 'report.txt'), plaintext], [join(values.dir, 'report.bin'), hexToBytes(bundle.ciphertext)],
      [join(values.dir, 'report.recovery.json'), json(bundle) + '\n']]);
    const window = expiryProbeWindow((await pub.getBlock()).timestamp);
    const sealed = seal(encodeDisclosurePayload(hexToBytes(bundle.key), bundle.reportId), window.mode,
      window.conditionRecord, plan.committee.k, plan.committee.keys.map(key => hexToBytes(key.mpk)));
    const args = { ...window, keys: plan.committee.keys, k: plan.committee.k, layers: sealed.layers,
      commit: sealed.commit, publicCondition: sealed.publicCondition, ceilingWei: plan.ceilingWei,
      hook: registry, hookGasLimit: Number(plan.parameters.defaultHookGas), feeApprovalAmount: funds.feeNil, skipLivenessCheck: true };
    const quote = await quoteEscrow(pub, plan.addresses.market, { ...args, keyIds: args.keys.map(key => key.keyId), maxLayerLen: plan.layerLength });
    if (await pub.getBalance({ address: account.address }) <= quote.escrowWei) throw new DeploymentError('Payer needs escrow and gas');
    const state = { version: 1, chainId: 11155111, state: 'prepared', registry, market: plan.addresses.market,
      researcher: account.address, reportId: bundle.reportId, cipherHash: bundle.cipherHash, keyCommit: bundle.keyCommit,
      window: { t1: window.t1, t2: window.t2 }, commit: sealed.commit, sealNonce: toHex(sealed.nonce), quote,
      feeNil: funds.feeNil, transactions: [] };
    Object.assign(evidence, state, { hook: registry, payer: account.address, payerNilBefore: funds.balanceNil });
    journal = await openJournal(join(values.dir, 'parent.jsonl'));
    const progress = async phase => { if (phase) state.state = phase; Object.assign(evidence, state); await journal.save(state); await save(); };
    const tracked = { ...wallet, async writeContract(request) {
      const hash = await wallet.writeContract(request);
      state.transactions.push({ call: request.functionName, hash }); await progress('submitted'); return hash;
    } };
    const confirm = async hash => {
      const receipt = await pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success' || getAddress(receipt.from) !== account.address) throw new DeploymentError('Expiry probe receipt failed or has a foreign payer');
      Object.assign(state.transactions.find(tx => tx.hash === hash), { block: receipt.blockNumber, gasUsed: receipt.gasUsed,
        gasCostWei: receipt.gasUsed * receipt.effectiveGasPrice }); await progress(); return receipt;
    };
    const call = async (functionName, args) => {
      const simulation = await pub.simulateContract({ account, address: registry, abi: artifact.abi, functionName, args });
      return confirm(await tracked.writeContract(simulation.request));
    };
    await progress();
    stage = 'registration';
    const registered = await call('register', [bundle.cipherHash, bundle.keyCommit, window.t1, window.t2]);
    state.registrationBlock = registered.blockNumber;
    evidence.registryEvents = [verifyRegistryReceipt(registered, registry, artifact.abi, 'Registered', evidence)];
    await progress('registered');
    if ((await pub.getBlock()).timestamp + 600n > window.t1) throw new DeploymentError('Expiry probe posting margin was consumed');
    stage = 'post';
    const posted = await postSealed(pub, tracked, plan.addresses, args);
    const receipt = await confirm(posted.txHash);
    Object.assign(state, { triggerId: posted.triggerId, postHash: posted.txHash, postBlock: receipt.blockNumber, escrowWei: posted.escrowWei });
    await progress('posted');
    if ((await pub.getBlock()).timestamp >= window.t1) throw new DeploymentError('Expiry probe binding window has begun');
    stage = 'binding';
    const bound = await call('bindTrigger', [bundle.reportId, posted.triggerId]);
    evidence.registryEvents.push(verifyRegistryReceipt(bound, registry, artifact.abi, 'Bound', evidence));
    evidence.registryBinding = await verifyRegistryBinding(pub, registry, artifact.abi, evidence);
    await progress('bound'); evidence.status = 'posted-awaiting-expiry'; await save();
    print(json({ evidenceFile: out, ...evidence })); return 0;
  } catch (error) {
    evidence.status = 'failed'; evidence.failedStage = stage; evidence.failure = publicFailure(error);
    try { await save(); } catch { evidence.evidenceWriteFailed = true; }
    diagnostic(json(evidence)); return 1;
  } finally { await journal?.close(); }
}

if (import.meta.main) process.exitCode = await runExpiryProbe(process.argv.slice(2));
