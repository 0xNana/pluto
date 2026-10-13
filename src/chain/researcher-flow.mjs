import { concat, getAddress, hexToBytes, keccak256, parseEventLogs, toHex } from 'viem';
import { quoteEscrow, quoteProtocolFee, seal, triggerMarketAbi } from '@nillion/covenants-sdk';
import { compileDisclosureWindow, encodeDisclosurePayload, retryReportIdFor } from '../shared/disclosure.mjs';
import { decryptReport, validateRecoveryBundle } from '../shared/report-crypto.mjs';
import { validateResearcherJournal } from '../shared/researcher-journal.mjs';
import { DeploymentError, resolveSepolia } from './deployment.mjs';
import { inspectFeasibility } from './feasibility.mjs';
import { postWithEscrowRetry } from './posting.mjs';

const same = (a, b) => getAddress(a) === getAddress(b);
const requireThat = (condition, message) => { if (!condition) throw new DeploymentError(message); };
const read = (pub, registry, functionName, args = []) => pub.readContract({
  address: registry.address, abi: registry.abi, functionName, args,
});

async function checkRegistry(pub, registry, market) {
  const code = await pub.getBytecode({ address: registry.address });
  requireThat(code && code !== '0x', 'Registry has no deployed code');
  requireThat(same(await read(pub, registry, 'market'), market), 'Registry market differs from the current deployment');
}

async function authorBundle(wallet, bundle) {
  const valid = await validateRecoveryBundle(bundle);
  requireThat(same(wallet.account.address, valid.researcher), 'Wallet must match the report researcher');
  return valid;
}

function checkJournalIdentity(journal, bundle, registry, market) {
  validateResearcherJournal(journal);
  const expectedId = journal.parentReportId === undefined ? bundle.reportId
    : retryReportIdFor(journal.parentReportId, BigInt(journal.window.t1), BigInt(journal.window.t2));
  requireThat(same(journal.registry, registry.address) && same(journal.market, market)
    && same(journal.researcher, bundle.researcher) && journal.reportId === expectedId
    && (journal.rootReportId === undefined || journal.rootReportId === bundle.reportId)
    && ['cipherHash', 'keyCommit'].every(name => journal[name] === bundle[name]),
  'Journal does not match this report and deployment');
}

function checkRecord(record, journal, bundle) {
  requireThat(record.registeredAt > 0n && record.t1 === BigInt(journal.window.t1)
    && record.t2 === BigInt(journal.window.t2) && same(record.researcher, bundle.researcher)
    && record.cipherHash === bundle.cipherHash && record.keyCommit === bundle.keyCommit
    && record.rootReportId === bundle.reportId
    && record.parentReportId === (journal.parentReportId ?? `0x${'00'.repeat(32)}`),
  'Registered report differs from recovery journal');
}

// Only explicitly selected public metadata enters the journal. Never spread a recovery bundle.
function tracker(pub, wallet, state, onProgress = async () => {}) {
  const save = async phase => {
    if (phase) state.state = phase;
    await onProgress(structuredClone(state));
  };
  const trackedWallet = { ...wallet, async writeContract(request) {
    // The approval and registration may have consumed the original posting margin.
    if (request.functionName === 'postTrigger') compileDisclosureWindow({
      nowUnix: (await pub.getBlock()).timestamp, ...state.window,
    });
    if (request.functionName === 'bindTrigger') requireThat((await pub.getBlock()).timestamp < state.window.t1,
      'Binding window has begun; do not submit a late bind');
    const hash = await wallet.writeContract(request);
    state.transactions.push({ call: request.functionName, hash });
    await save('submitted'); // Persist the hash before the SDK or caller waits for a receipt.
    return hash;
  } };
  const confirm = async hash => {
    const receipt = await pub.waitForTransactionReceipt({ hash });
    requireThat(receipt?.status === 'success', 'Transaction did not succeed; inspect its journal hash');
    const entry = state.transactions.find(tx => tx.hash === hash);
    if (entry) Object.assign(entry, { block: receipt.blockNumber, gasUsed: receipt.gasUsed,
      gasCostWei: receipt.gasUsed * receipt.effectiveGasPrice });
    await save();
    return receipt;
  };
  const call = async (registry, functionName, args) => {
    const simulation = await pub.simulateContract({ address: registry.address, abi: registry.abi,
      functionName, args, account: wallet.account });
    return confirm(await trackedWallet.writeContract(simulation.request));
  };
  return { wallet: trackedWallet, save, confirm, call };
}

export async function postReport(options, { inspect = inspectFeasibility } = {}) {
  const { pub, wallet, registry, expectedMarket, t1, t2, onProgress } = options;
  const bundle = await authorBundle(wallet, options.bundle);
  requireThat(await pub.getChainId() === 11155111, 'Pluto requires Sepolia');
  const window = compileDisclosureWindow({ nowUnix: (await pub.getBlock()).timestamp, t1, t2 });
  let reportId = bundle.reportId;
  const parent = options.parentJournal;
  if (parent) {
    const addresses = await resolveSepolia(pub, expectedMarket);
    await checkRegistry(pub, registry, addresses.market);
    checkJournalIdentity(parent, bundle, registry, addresses.market);
    const record = await read(pub, registry, 'statusOf', [parent.reportId]);
    checkRecord(record, parent, bundle);
    requireThat((await pub.getBlock()).timestamp > record.t2, 'Parent report must be expired before retrying');
    requireThat(!await read(pub, registry, 'lineageDisclosed', [record.rootReportId]),
      'Report lineage has already been disclosed');
    reportId = retryReportIdFor(parent.reportId, window.t1, window.t2);
  }
  const plan = await inspect(pub, expectedMarket);
  await checkRegistry(pub, registry, plan.addresses.market);
  const funds = await quoteProtocolFee(pub, plan.addresses, bundle.researcher);
  const sealed = seal(encodeDisclosurePayload(hexToBytes(bundle.key), reportId), window.mode,
    window.conditionRecord, plan.committee.k, plan.committee.keys.map(key => hexToBytes(key.mpk)));
  const args = { ...window, keys: plan.committee.keys, k: plan.committee.k,
    layers: sealed.layers, commit: sealed.commit, publicCondition: sealed.publicCondition,
    ceilingWei: plan.ceilingWei, hook: registry.address, hookGasLimit: Number(plan.parameters.defaultHookGas),
    feeApprovalAmount: funds.feeNil, skipLivenessCheck: true };
  const quote = await quoteEscrow(pub, plan.addresses.market, { ...args,
    keyIds: args.keys.map(key => key.keyId), maxLayerLen: plan.layerLength });
  requireThat(funds.balanceNil >= funds.feeNil, 'Researcher needs NIL for the protocol fee');
  requireThat(await pub.getBalance({ address: bundle.researcher }) > quote.escrowWei,
    'Researcher needs Sepolia ETH for escrow and transaction gas');
  const state = { version: 1, chainId: 11155111, registry: getAddress(registry.address),
    market: getAddress(plan.addresses.market), researcher: bundle.researcher,
    reportId, cipherHash: bundle.cipherHash, keyCommit: bundle.keyCommit,
    window: { t1: window.t1, t2: window.t2 }, transactions: [], quote,
    feeNil: funds.feeNil, commit: sealed.commit, sealNonce: toHex(sealed.nonce) };
  if (parent) Object.assign(state, { parentReportId: parent.reportId, rootReportId: bundle.reportId });
  const tracking = tracker(pub, wallet, state, onProgress);
  await tracking.save('prepared');
  const registered = parent
    ? await tracking.call(registry, 'registerRetry', [parent.reportId, window.t1, window.t2])
    : await tracking.call(registry, 'register', [bundle.cipherHash, bundle.keyCommit, window.t1, window.t2]);
  checkRecord(await read(pub, registry, 'statusOf', [reportId]), state, bundle);
  state.registrationBlock = registered.blockNumber;
  await tracking.save('registered');
  const posted = await postWithEscrowRetry(pub, tracking.wallet, plan.addresses, args, {
    async onRequote() {
      state.quote = await quoteEscrow(pub, plan.addresses.market, { ...args,
        keyIds: args.keys.map(key => key.keyId), maxLayerLen: plan.layerLength });
      await tracking.save('registered');
    },
    async onReverted(receipt) {
      const transaction = state.transactions.find(tx => tx.hash === receipt.transactionHash);
      requireThat(transaction, 'Reverted post hash is missing from the journal');
      Object.assign(transaction, { status: 'reverted', block: receipt.blockNumber,
        gasUsed: receipt.gasUsed, gasCostWei: receipt.gasUsed * receipt.effectiveGasPrice });
      await tracking.save();
    },
  });
  const receipt = await tracking.confirm(posted.txHash);
  Object.assign(state, { triggerId: posted.triggerId, postHash: posted.txHash,
    postBlock: receipt.blockNumber, escrowWei: posted.escrowWei, feeNil: posted.feeNil });
  await tracking.save('posted');
  return bindReport({ ...options, journal: state });
}

export async function bindReport({ pub, wallet, registry, expectedMarket, bundle: recovery, journal, onProgress }) {
  validateResearcherJournal(journal);
  const bundle = await authorBundle(wallet, recovery);
  const addresses = await resolveSepolia(pub, expectedMarket);
  await checkRegistry(pub, registry, addresses.market);
  checkJournalIdentity(journal, bundle, registry, addresses.market);
  const state = structuredClone(journal);
  state.window = { t1: BigInt(state.window.t1), t2: BigInt(state.window.t2) };
  const record = await read(pub, registry, 'statusOf', [state.reportId]);
  checkRecord(record, state, bundle);
  requireThat((await pub.getBlock()).timestamp < record.t1, 'Binding window has begun; do not submit a late bind');
  const tracking = tracker(pub, wallet, state, onProgress);
  // Recover an interrupted SDK receipt wait from the submitted hash, without ever reposting.
  const postings = state.transactions.filter(tx => tx.call === 'postTrigger' && tx.status !== 'reverted');
  requireThat(postings.length === 1, 'Journal must identify exactly one submitted post');
  const postHash = state.postHash ?? postings[0].hash;
  requireThat(postHash === postings[0].hash, 'Journal posting hashes disagree');
  requireThat(postHash, 'Journal has no submitted post; automatic reposting is refused');
  const receipt = await tracking.confirm(postHash);
  requireThat(same(receipt.from, bundle.researcher), 'Posting receipt sender differs from the researcher');
  const logs = parseEventLogs({ abi: triggerMarketAbi, eventName: 'TriggerPosted', logs: receipt.logs })
    .filter(log => same(log.address, addresses.market));
  requireThat(logs.length === 1, 'Post receipt must contain exactly one market posting event');
  const posted = logs[0].args;
  requireThat(state.triggerId === undefined || BigInt(state.triggerId) === posted.triggerId, 'Journal trigger ID differs from receipt');
  requireThat(same(posted.author, bundle.researcher) && posted.commit === state.commit,
    'Posting event differs from researcher or sealed commitment');
  Object.assign(state, { triggerId: posted.triggerId, postHash, postBlock: receipt.blockNumber });
  if (state.registrationBlock === undefined) {
    const registration = state.transactions.find(tx => tx.call === (state.parentReportId ? 'registerRetry' : 'register'));
    requireThat(registration, 'Missing registration evidence');
    state.registrationBlock = (await tracking.confirm(registration.hash)).blockNumber;
  }
  await tracking.save('posted');
  const marketRead = functionName => pub.readContract({ address: addresses.market, abi: triggerMarketAbi,
    functionName, args: [state.triggerId] });
  const [hook, parties, meta, binding] = await Promise.all([
    marketRead('hookMeta'), marketRead('postingParties'), marketRead('triggerMeta'),
    read(pub, registry, 'bindings', [state.triggerId]),
  ]);
  requireThat(same(hook[0], registry.address), 'Recorded hook does not match the registry');
  requireThat(parties.every(address => same(address, bundle.researcher)), 'Recorded author or payer does not match the researcher');
  requireThat(/^0x[0-9a-fA-F]{64}$/.test(state.sealNonce), 'Invalid journal seal nonce');
  const commit = keccak256(concat([encodeDisclosurePayload(hexToBytes(bundle.key), state.reportId), hexToBytes(state.sealNonce)]));
  requireThat(meta[0] === 1 && !meta[8] && meta[3] === record.t2 && meta[4] === record.t1
    && meta[5] === record.t2 && meta[6] === commit && state.commit === commit,
  'Recorded trigger mode, window or commitment differs from the report');
  if (binding[1]) requireThat(binding[0] === state.reportId, 'Trigger is bound to another report');
  else await tracking.call(registry, 'bindTrigger', [state.reportId, state.triggerId]);
  const bound = await read(pub, registry, 'bindings', [state.triggerId]);
  requireThat(bound[1] && bound[0] === state.reportId, 'Registry binding was not confirmed');
  await tracking.save('bound');
  return state;
}

export async function readReportStatus({ pub, registry, expectedMarket, reportId }) {
  const addresses = await resolveSepolia(pub, expectedMarket);
  await checkRegistry(pub, registry, addresses.market);
  const record = await read(pub, registry, 'statusOf', [reportId]);
  requireThat(record.registeredAt > 0n, 'Report is not registered');
  const [block, lineageDisclosed] = await Promise.all([
    pub.getBlock(), read(pub, registry, 'lineageDisclosed', [record.rootReportId]),
  ]);
  let state = record.bindTime > 0n ? 'bound' : 'registered';
  if (block.timestamp > record.t2) state = 'expired';
  if (lineageDisclosed) state = 'lineage-disclosed';
  if (record.disclosed) state = 'disclosed';
  return { reportId, registry: registry.address, market: addresses.market, block: block.number,
    timestamp: block.timestamp, state, record, lineageDisclosed };
}

export async function verifyDisclosedReport({ pub, registry, expectedMarket, reportId, fromBlock, ciphertext }) {
  const status = await readReportStatus({ pub, registry, expectedMarket, reportId });
  requireThat(status.record.disclosed, 'Report has not been disclosed by the registry');
  requireThat(ciphertext instanceof Uint8Array && keccak256(ciphertext) === status.record.cipherHash,
    'Report ciphertext does not match the registered hash');
  requireThat(fromBlock !== undefined && BigInt(fromBlock) >= 0n && BigInt(fromBlock) <= status.block,
    'Verification requires a valid registration block for a bounded event scan');
  const events = await pub.getContractEvents({ address: registry.address, abi: registry.abi,
    eventName: 'Disclosed', args: { reportId }, fromBlock: BigInt(fromBlock), toBlock: status.block, strict: true });
  requireThat(events.length === 1 && same(events[0].address, registry.address)
    && !events[0].removed && events[0].blockNumber >= BigInt(fromBlock)
    && events[0].blockNumber <= status.block && events[0].args.reportId === reportId,
  'Accepted disclosure event is missing, out of range or ambiguous');
  const { key, triggerId } = events[0].args;
  requireThat(keccak256(key) === status.record.keyCommit, 'Disclosed key does not match its commitment');
  const binding = await read(pub, registry, 'bindings', [triggerId]);
  requireThat(binding[1] && binding[0] === reportId, 'Disclosure event trigger is not bound to the report');
  return { reportId, triggerId, block: events[0].blockNumber,
    plaintext: await decryptReport(ciphertext, hexToBytes(key)) };
}
