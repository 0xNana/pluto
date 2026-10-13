import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, chmod, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { ContractFunctionRevertedError, encodeErrorResult, encodeFunctionData, decodeFunctionData, decodeEventLog, encodeAbiParameters, encodeEventTopics, hexToBytes, toHex } from 'viem';
import { createAddressFromString } from '@ethereumjs/util';
import { compileCondition, triggerMarketAbi, nilAbi, mpkFromSecret, seal, selectCommittee, SPONSORED_POST_TYPES, sponsoredPostMessage, hashSponsoredPost } from '@nillion/covenants-sdk';
import { evmHarness } from './support/evm.mjs';
import { marketMockSource } from './support/market.mjs';
import { compileContracts } from '../scripts/lib/contracts.mjs';
import { signRegistryAction, registryDomain } from '../src/shared/registry-authorization.mjs';
import { prepareReport } from '../src/shared/report-crypto.mjs';
import { PortalStore } from '../packages/portal/store.mts';
import { SponsorService } from '../packages/relayer/service.mts';
import { SponsorRequests } from '../packages/relayer/requests.mts';
import { sponsorHandler } from '../packages/portal/sponsor-http.mts';
import { parseSponsorInput, sponsorReleaseMessage } from '../packages/client/sponsor-wire.mts';
import { PortalInbox } from '../packages/portal/inbox.mts';
import { signNotice } from '../packages/client/notice.mts';
import { verifyPublicReport } from '../packages/verifier/verify.mts';
import { submitSelfFunded } from '../packages/client/posting.mts';
import { newBrowserRecovery, validateBrowserRecovery, appendRecoveryEvent, exportBrowserRecovery, importBrowserRecovery, mergeBrowserRecovery } from '../packages/client/recovery.mts';
import { encodeWire, decodeWire } from '../packages/client/wire.mts';
import { inspectBrowserRecovery, priceRecoveredBinding, resumeBrowserBinding } from '../packages/client/binding-recovery.mts';
import { prepareSponsorship, releaseSponsorship, reviewedSponsorBounds, uploadSavedSponsorship, priceSponsorship, sponsorshipProof } from '../packages/client/sponsorship.mts';
import { inspectFundedBinding, priceFundedBinding } from '../packages/client/funded-binding.mts';
import { priceSavedSelfFunded } from '../packages/client/continuation.mts';
import { createPlan } from '../packages/planner/planner.mts';
import { researcherDevelopmentHandler } from '../packages/planner/development.mts';
import { applicationHandler } from '../packages/portal/application.mts';
import { ProtocolEnrollment } from '../packages/portal/enrollment.mts';

test('T-13/14 real registry sponsorship (mock market): exact saved upload retry, HTTP approval, finalized WrongValue retry and zero author prepayment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pluto-relayer-')); await chmod(dir, 0o700);
  let portalTime = 1000;
  let store = new PortalStore(join(dir, 'portal.sqlite'), 'https://pluto.example', 11155111, () => portalTime);
  const artifacts = await compileContracts({ 'MockMarket.sol': marketMockSource() }), chain = await evmHarness({ chainId: 11155111 });
  const market = await chain.deploy(artifacts.MockMarket), registry = await chain.deploy(artifacts.DisclosureRegistry, [market.address]);
  const author = privateKeyToAccount('0x' + '12'.repeat(32)), customer = privateKeyToAccount('0x' + '34'.repeat(32));
  const address = n => toHex(BigInt(n), { size: 20 }), hash = n => toHex(BigInt(n), { size: 32 });
  const addresses = { market: market.address, config: address(10), registry: address(11), staking: address(12), emissions: address(13), nil: address(14) };
  const candidates = [1, 2, 3].map(n => ({ keyId: BigInt(n), nodeId: BigInt(n), mpk: toHex(mpkFromSecret(new Uint8Array(32).fill(n))), expiresAt: 10000n, stake: 10n, fired: 0n, markup: 0, operator: address(n + 20) }));
  const parameters = { minStake: 1n, maxM: 5n, maxPlaintextBytes: 96n, maxCiphertextBytes: 10000n, protocolFee: 25n,
    defaultHookGas: 250000, maxHookGas: 8000000, defaultRetryWindowSecs: 600, maxRetryWindowSecs: 3600, layerOverheadPublicBytes: 134, keyTTL: 10000 };
  let sequence = 0n, allowance = 0n, postCalls = 0; const receipts = new Map(), transactions = new Map(), writes = [];
  const pub = { getChainId: async () => 11155111, getBlock: async ({ blockNumber } = {}) => ({ number: blockNumber ?? 10n, timestamp: blockNumber === undefined ? 1000n : blockNumber * 100n, baseFeePerGas: 1n, hash: hash(99) }),
    getBytecode: async ({ address: target }) => target.toLowerCase() === registry.address.toLowerCase() ? toHex(await chain.evm.stateManager.getCode(createAddressFromString(target))) : '0x1234',
    getCode: async () => '0x1234', getBalance: async () => 10n ** 22n,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 3n, maxPriorityFeePerGas: 1n }),
    estimateContractGas: async () => 3000000n,
    simulateBlocks: async ({ blocks }) => [{ calls: blocks[0].calls.map(() => ({ status: 'success', gasUsed: 3000000n })) }],
    simulateContract: async request => {
      if (request.functionName === 'postTriggerSponsored' && request.blockNumber === 10n) throw new ContractFunctionRevertedError({ abi: triggerMarketAbi, data: encodeErrorResult({ abi: triggerMarketAbi, errorName: 'WrongValue' }) });
      return { request };
    }, waitForTransactionReceipt: async ({ hash }) => receipts.get(hash), getTransactionReceipt: async ({ hash }) => receipts.get(hash), getTransaction: async ({ hash }) => transactions.get(hash),
    getContractEvents: async ({ eventName }) => eventName === 'SharePosted' ? candidates.map((c, i) => ({ args: { triggerId: 0n, node: c.nodeId, slot: i, share: '0x01' }, blockNumber: 9n })) : [],
    readContract: async request => {
      if (request.address.toLowerCase() === registry.address.toLowerCase()) return chain.call(registry, request.functionName, request.args ?? []);
      if (['hookMeta', 'postingParties', 'triggerMeta'].includes(request.functionName)) return [...await chain.call(market, request.functionName, request.args)];
      if (request.functionName in parameters) return parameters[request.functionName];
      if (request.functionName === 'digestOf') {
        const [params, auth] = request.args;
        return hashSponsoredPost({ chainId: 11155111, verifyingContract: market.address }, sponsoredPostMessage({ ...params, mode: 'PUBLIC_CONDITION', layers: params.layers.map(hexToBytes),
          keys: params.keyIds.map(keyId => ({ keyId })), publicCondition: hexToBytes(params.publicCondition) }, auth));
      }
      if (request.functionName === 'isEligibleStake') return [true];
      if (request.functionName === 'isUsableKey') return true;
      if (request.functionName === 'authNonceUsed') return false;
      if (request.functionName === 'authVerifier') return address(16);
      const getters = { triggerMarket: addresses.market, nodeRegistry: addresses.registry, staking: addresses.staking, emissions: addresses.emissions, stakingToken: addresses.nil, escrowMath: address(15), quoteEscrow: 500n, nextTriggerId: 7n, balanceOf: 1000n, allowance, getActiveKeys: candidates, retired: false };
      if (request.functionName === 'operatorOf') return candidates.find(c => c.nodeId === request.args[0]).operator;
      if (request.functionName in getters) return getters[request.functionName];
      throw new Error('Unexpected fixture RPC read: ' + request.functionName);
    } };
  const wallet = { account: { address: chain.foreign }, chain: { id: 11155111 }, sendTransaction: async request => {
    writes.push(request); const h = hash(++sequence), logs = [];
    transactions.set(h, { hash: h, from: chain.foreign, to: request.to, input: request.data, value: request.value ?? 0n, gas: request.gas, maxFeePerGas: request.maxFeePerGas });
    if (request.to === addresses.nil) { const call = decodeFunctionData({ abi: nilAbi, data: request.data }); allowance = call.args[1]; assert.equal(allowance, 25n); }
    else if (request.to === market.address) {
      const call = decodeFunctionData({ abi: triggerMarketAbi, data: request.data }); assert.equal(call.functionName, 'postTriggerSponsored');
      const [params, auth] = call.args; assert.equal(auth.author, author.address); assert.equal(auth.payer, chain.foreign);
      if (++postCalls === 1) {
        receipts.set(h, { transactionHash: h, status: 'reverted', blockNumber: 10n, blockHash: hash(99), gasUsed: 50000n, effectiveGasPrice: 2n, logs }); return h;
      }
      await chain.call(market, 'setTrigger', [7n, author.address, chain.foreign, registry.address, params.t1, params.t2, false]);
      const event = triggerMarketAbi.find(e => e.type === 'event' && e.name === 'TriggerPosted'), args = { ...params, triggerId: 7n, author: author.address, expiry: params.t2 };
      logs.push({ address: market.address, topics: encodeEventTopics({ abi: triggerMarketAbi, eventName: 'TriggerPosted', args }), data: encodeAbiParameters(event.inputs.filter(i => !i.indexed), event.inputs.filter(i => !i.indexed).map(i => args[i.name])) });
      const transfer = nilAbi.find(e => e.type === 'event' && e.name === 'Transfer');
      const fee = { from: chain.foreign, to: market.address, value: 25n };
      logs.push({ address: addresses.nil, topics: encodeEventTopics({ abi: nilAbi, eventName: 'Transfer', args: fee }), data: encodeAbiParameters(transfer.inputs.filter(i => !i.indexed), transfer.inputs.filter(i => !i.indexed).map(i => fee[i.name])) });
    } else {
      const call = decodeFunctionData({ abi: registry.abi, data: request.data }); await chain.call(registry, call.functionName, call.args, chain.foreign);
      for (const [addr, topics, data] of chain.result().execResult.logs ?? []) logs.push({ address: toHex(addr), topics: topics.map(toHex), data: toHex(data) });
    }
    receipts.set(h, { transactionHash: h, status: 'success', blockNumber: 10n, blockHash: hash(99), gasUsed: 50000n, effectiveGasPrice: 2n, logs }); return h;
  } };
  try {
    store.enrollVerifiedProtocol('alpha.example', customer.address);
    const c = store.challenge(customer.address), session = await store.authenticate(c.id, await customer.signMessage({ message: c.message }));
    const report = await prepareReport(new TextEncoder().encode('secret researcher fixture'), author.address), t1 = 1600n, t2 = 5200n;
    const committee = selectCommittee(candidates, { m: 3, k: 2, mode: 'PUBLIC_CONDITION', minStake: 1n, nowUnix: 1000n, pick: 'top' });
    const payload = new Uint8Array([...hexToBytes(report.key), ...hexToBytes(report.reportId)]), sealed = seal(payload, 'PUBLIC_CONDITION', compileCondition({ window: { t1, t2 } }), 2, committee.keys.map(k => hexToBytes(k.mpk)));
    const args = { ...sealed, mode: 'PUBLIC_CONDITION', ttl: 0, keys: committee.keys, k: 2, t1, t2, ceilingWei: 6n, hook: registry.address, hookGasLimit: 250000, retryWindowSecs: 600 };
    const authorization = { author: author.address, payer: chain.foreign, minCeiling: 5n, nonce: 0n, deadline: 1500n };
    authorization.signature = await author.signTypedData({ domain: { name: 'Covenants TriggerMarket', version: '1', chainId: 11155111, verifyingContract: market.address }, types: SPONSORED_POST_TYPES, primaryType: 'SponsoredPost', message: sponsoredPostMessage(args, authorization) });
    const registration = await signRegistryAction(author, registryDomain(11155111, registry.address), 'RegisterReport', { cipherHash: report.cipherHash, keyCommit: report.keyCommit, t1, t2 }, { payer: chain.foreign, nonce: 1n, deadline: 1500n });
    const binding = { ...await signRegistryAction(author, registryDomain(11155111, registry.address), 'BindReport', { reportId: report.reportId, triggerId: 7n }, { payer: chain.foreign, nonce: 2n, deadline: 1500n }), triggerId: 7n };
    // The relayer receives sealed data only; the seal nonce stays client-side.
    const { nonce: _localNonce, ...sealedArgs } = args;
    const bundle = parseSponsorInput({ protocolId: 'alpha.example', binding, bundle: { reportId: report.reportId, cipherHash: report.cipherHash, keyCommit: report.keyCommit,
      args: { ...sealedArgs, keys: sealedArgs.keys.map(({ keyId, nodeId, mpk }) => ({ keyId, nodeId, mpk })) }, authorization, registration } }).bundle;
    const config = { expectedMarket: market.address, registry: registry.address, artifact: artifacts.DisclosureRegistry, maxCeilingWei: 10n, writesEnabled: false };
    const disabled = new SponsorService(store, pub, wallet, config);
    disabled.configure(session, 'alpha.example', { ethWei: 100000000n, nilUnits: 100n, perPostWei: 100000000n, perPostNil: 100n });
    const fundedRecovery = await validateBrowserRecovery({ ...await newBrowserRecovery(report, '0x' + '12'.repeat(32)),
      sealing: { registry: registry.address, market: market.address, cipherUris: ['https://a.example/r', 'https://b.example/r'], nonce: toHex(sealed.nonce), args: encodeWire(sealedArgs) } });
    const browserInput = await prepareSponsorship(pub, fundedRecovery, 'alpha.example', chain.foreign, { expectedMarket: market.address, artifact: artifacts.DisclosureRegistry, marketAbi: triggerMarketAbi });
    const browserQuote = await disabled.quote('alpha.example', browserInput.bundle, browserInput.binding);
    const browserBounds = reviewedSponsorBounds(browserInput, { ...browserQuote, payer: chain.foreign }, chain.foreign);
    await assert.rejects(releaseSponsorship(store.origin, browserInput, browserBounds, fundedRecovery, { recoverySaved: false, reviewed: true, confirmed: true, costsReady: true }), /Save recovery/);
    const release = await releaseSponsorship(store.origin, browserInput, browserBounds, fundedRecovery, { recoverySaved: true, reviewed: true, confirmed: true, costsReady: true });
    assert.ok(!encodeWire(release.body).includes(report.key.slice(2))); assert.ok(!encodeWire(release.body).includes(toHex(sealed.nonce).slice(2)));
    const localQuote = await priceSponsorship(pub, browserInput, { registry: registry.abi, market: triggerMarketAbi, nil: nilAbi });
    assert.equal(localQuote.ethReserveWei, browserBounds.ethReserveWei); assert.equal(localQuote.feeNil, browserBounds.feeNil);
    const exactRecovery = await validateBrowserRecovery({ ...appendRecoveryEvent(appendRecoveryEvent(fundedRecovery, 'sponsorRequest'), 'sponsorRequest', release.id),
      funding: { origin: store.origin, id: release.id, body: encodeWire(release.body) } });
    const savedBeforeFailure = exportBrowserRecovery(exactRecovery), uploads = [];
    await assert.rejects(uploadSavedSponsorship(store.origin, exactRecovery, async (_url, request) => { uploads.push(request.body); throw new Error('fixture disconnected upload'); }), /disconnected upload/);
    assert.equal(exportBrowserRecovery(exactRecovery), savedBeforeFailure);
    const restoredFunding = await importBrowserRecovery(savedBeforeFailure);
    const uploaded = await uploadSavedSponsorship(store.origin, restoredFunding, async (_url, request) => { uploads.push(request.body); return new Response(encodeWire({ id: release.id, state: 'pending' })); });
    assert.equal(uploaded.id, release.id); assert.deepEqual(uploads, [encodeWire(release.body), encodeWire(release.body)]); assert.equal(writes.length, 0);
    const { funding: _removedFunding, ...oldBackup } = restoredFunding;
    assert.equal(mergeBrowserRecovery(oldBackup, exactRecovery).funding.body, encodeWire(release.body));
    await assert.rejects(uploadSavedSponsorship('https://evil.example', exactRecovery), /Exact local/);
    await assert.rejects(validateBrowserRecovery({ ...exactRecovery, funding: { ...exactRecovery.funding, body: encodeWire({ ...release.body, key: report.key }) } }), /schema/);
    const prepared = await disabled.prepare(session, 'alpha.example', bundle, binding);
    await assert.rejects(disabled.submit(session, prepared), /disabled/); assert.equal(writes.length, 0);
    let service = new SponsorService(store, pub, wallet, { ...config, writesEnabled: true });
    const requestController = new SponsorRequests(store, service), requestHandler = sponsorHandler(requestController);
    // Read-only startup/runtime/planning probes over the real local registry and
    // fixture market. They enable configuration, never call a sender.
    const assetDirectory = join(dir, 'assets'); await mkdir(assetDirectory);
    for (const name of ['index.html', 'app.js', 'app.css', 'sdk-abis.json', 'cryptomata_core_bg.wasm']) await writeFile(join(assetDirectory, name), name);
    await writeFile(join(assetDirectory, 'registry-artifact.json'), JSON.stringify(artifacts.DisclosureRegistry));
    const applicationConfig = { assetDirectory, pub, expectedMarket: market.address, registry: registry.address,
      registryFirstBlock: 0n, publicRpcUrl: 'https://public.example', writesEnabled: true, sponsorship: { requests: requestController } };
    const enabledPortal = await applicationHandler(store, new PortalInbox(store, 86400), new ProtocolEnrollment(store, async () => []), applicationConfig);
    const enabledRuntime = await (await enabledPortal(new Request(store.origin + '/api/runtime'))).json();
    assert.equal(enabledRuntime.writesEnabled, true); assert.equal(enabledRuntime.chainId, 11155111);
    assert.equal(enabledRuntime.sponsorship.payer, wallet.account.address);
    assert.equal((await (await enabledPortal(new Request(store.origin + '/healthz'))).json()).liveWritesEnabled, true);
    await assert.rejects(applicationHandler(store, new PortalInbox(store, 86400), new ProtocolEnrollment(store), { ...applicationConfig, pub: { ...pub, getChainId: async () => 1 } }), /Sepolia/);
    await assert.rejects(applicationHandler(store, new PortalInbox(store, 86400), new ProtocolEnrollment(store), { ...applicationConfig, writesEnabled: false }), /matching submission/);
    const development = await researcherDevelopmentHandler({ origin: 'http://localhost:3000', publicRpcUrl: 'https://public.example', pub,
      expectedMarket: market.address, registry: registry.address, registryFirstBlock: 0n, writesEnabled: true, artifact: artifacts.DisclosureRegistry });
    const developmentRuntime = await (await development(new Request('http://localhost:3000/api/runtime'))).json();
    assert.equal(developmentRuntime.serviceMode, 'researcher'); assert.equal(developmentRuntime.writesEnabled, true);
    assert.equal(developmentRuntime.sponsorship, null); assert.equal(Object.hasOwn(developmentRuntime, 'rpcUrl'), false);
    const planRequest = (origin, extra = {}) => new Request('http://localhost:3000/api/plan', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ t1: '1600', t2: '5200', ...extra }) });
    assert.equal((await development(planRequest('https://other.example'))).status, 403);
    assert.equal((await development(planRequest('http://localhost:3000', { K: 'synthetic rejected field' }))).status, 503);
    const planned = await development(planRequest('http://localhost:3000')); assert.equal(planned.status, 200);
    const developmentPlan = decodeWire(await planned.text()); assert.equal(developmentPlan.t1, 1600n); assert.equal(developmentPlan.ttl, 0);
    assert.equal((await development(new Request('http://localhost:3000/api/auth/session'))).status, 404);
    assert.equal(writes.length, 0, 'enabling and planning never broadcast');
    const reviewedCaps = { requestHash: prepared.requestHash, ethReserveWei: prepared.ethReserveWei, feeNil: prepared.feeNil };
    const requestBody = { input: { protocolId: 'alpha.example', bundle, binding }, bounds: reviewedCaps,
      release: await author.signMessage({ message: sponsorReleaseMessage(store.origin, 'alpha.example', reviewedCaps) }) };
    const request = (path, body, token = '') => new Request(store.origin + path, { method: 'POST', headers: { origin: store.origin, 'content-type': 'application/json',
      ...(token ? { cookie: `pluto_session=${token}` } : {}) }, body: encodeWire(body) });
    const acceptedRequest = await requestHandler(request('/api/sponsorship/requests', requestBody)); assert.equal(acceptedRequest.status, 201);
    const requestId = (await acceptedRequest.json()).id;
    // Simulate a process loss after the successful post hash was persisted but
    // before sponsored_posts received its trigger ID. Recovery must use the
    // saved canonical receipt, never post again.
    const originalRun = store.db.prepare.bind(store.db);
    let crashOnPostSave = true;
    store.db.prepare = sql => {
      const statement = originalRun(sql);
      if (sql.startsWith('UPDATE sponsored_posts SET trigger_id=?') && crashOnPostSave) {
        crashOnPostSave = false;
        return { ...statement, run: () => { throw new Error('fixture process loss after saved post hash'); } };
      }
      return statement;
    };
    const interrupted = await requestHandler(request(`/api/protocols/alpha.example/sponsorship/requests/${requestId}/approve`, reviewedCaps, session));
    assert.equal(interrupted.status, 200); assert.equal((await interrupted.json()).state, 'unknown');
    store.db.prepare = originalRun;
    assert.equal(writes.length, 4);
    assert.equal(store.db.prepare('SELECT trigger_id FROM sponsored_posts WHERE intent_id=?').get(prepared.id).trigger_id, null);
    store.close();
    store = new PortalStore(join(dir, 'portal.sqlite'), 'https://pluto.example', 11155111, () => portalTime);
    const restarted = new SponsorService(store, pub, wallet, { ...config, writesEnabled: true });
    service = restarted;
    const restartRequests = new SponsorRequests(store, restarted), restartHandler = sponsorHandler(restartRequests);
    const localFunded = await validateBrowserRecovery({ ...appendRecoveryEvent(appendRecoveryEvent(fundedRecovery, 'sponsorRequest'), 'sponsorRequest', requestId),
      funding: { origin: store.origin, id: requestId, body: encodeWire(requestBody) } });
    const resumedStatus = await restartRequests.customerStatus(session, 'alpha.example', requestId);
    assert.equal(resumedStatus.state, 'awaiting-binding');
    const observedFunded = await inspectFundedBinding(pub, localFunded, resumedStatus, { expectedMarket: market.address, artifact: artifacts.DisclosureRegistry, marketAbi: triggerMarketAbi });
    assert.equal(observedFunded.bound, false); assert.equal(observedFunded.payer, chain.foreign);
    const noCurrentKeys = { ...pub, readContract: request => request.functionName === 'getActiveKeys' ? Promise.resolve([]) : pub.readContract(request) };
    assert.equal((await inspectFundedBinding(noCurrentKeys, localFunded, resumedStatus, { expectedMarket: market.address, artifact: artifacts.DisclosureRegistry, marketAbi: triggerMarketAbi })).bound, false);
    await assert.rejects(inspectFundedBinding(pub, localFunded, { ...resumedStatus, triggerId: 8n }, { expectedMarket: market.address, artifact: artifacts.DisclosureRegistry, marketAbi: triggerMarketAbi }), /event terms/);
    const fundedBindingCosts = await priceFundedBinding(pub, observedFunded);
    await assert.rejects(restarted.completeBinding(prepared.id, fundedBindingCosts.grant, 1n), /reviewed live costs/); assert.equal(writes.length, 4);
    const boundResponse = await restartHandler(request(`/api/sponsorship/requests/${requestId}/binding`, {
      proof: await sponsorshipProof(store.origin, requestId, 'binding', '0x' + '12'.repeat(32), 1000), grant: fundedBindingCosts.grant, gasWei: fundedBindingCosts.gasWei }));
    assert.equal(boundResponse.status, 200);
    const result = decodeWire(await boundResponse.text());
    assert.equal(result.state, 'bound'); assert.equal(result.triggerId, 7n);
    assert.equal((await chain.call(registry, 'statusOf', [report.reportId])).researcher, author.address);
    assert.equal((await chain.evm.stateManager.getAccount(createAddressFromString(author.address)))?.balance ?? 0n, 0n);
    assert.equal(writes.length, 5); assert.equal(postCalls, 2); assert.ok(writes.every(call => call.gas > 0n && call.maxFeePerGas === 3n));
    assert.deepEqual(service.intent(session, 'alpha.example', prepared.id).transactions.map(tx => tx.action).sort(), ['approve', 'bind', 'post', 'post:1', 'register']);
    assert.equal((await restarted.completeBinding(prepared.id, binding)).state, 'bound');
    assert.equal(writes.length, 5);
    const transmitted = JSON.stringify(writes, (_key, value) => typeof value === 'bigint' ? String(value) : value);
    assert.ok(!transmitted.includes(report.key.slice(2))); assert.ok(!transmitted.includes('secret researcher fixture'));
    await assert.rejects(service.submit(session, prepared), /already attempted/); assert.equal(writes.length, 5);
    // Exercise the separate browser-compatible self-funded submission library,
    // including finite approval and actual registry events/state. RPC/market
    // transport remains a fixture; this is not a live acceptance test.
    const self = await prepareReport(new TextEncoder().encode('unenrolled self-funded fixture'), author.address);
    const selfSeal = seal(new Uint8Array([...hexToBytes(self.key), ...hexToBytes(self.reportId)]), 'PUBLIC_CONDITION', compileCondition({ window: { t1, t2 } }), 2, committee.keys.map(k => hexToBytes(k.mpk)));
    const unposted = await validateBrowserRecovery({ ...await newBrowserRecovery(self, '0x' + '12'.repeat(32)), sealing: { registry: registry.address, market: market.address,
      cipherUris: ['https://a.example/r', 'https://b.example/r'], nonce: toHex(selfSeal.nonce), args: encodeWire({ ...sealedArgs, commit: selfSeal.commit, layers: selfSeal.layers, publicCondition: selfSeal.publicCondition }) } });
    const requestIdentity = hash(222);
    let withdrawn = appendRecoveryEvent(appendRecoveryEvent(unposted, 'sponsorRequest'), 'sponsorRequest', requestIdentity);
    const plan = await createPlan(pub, { expectedMarket: market.address, registry: registry.address, t1, t2 });
    await assert.rejects(priceSavedSelfFunded(pub, withdrawn, plan, { expectedMarket: market.address, artifact: artifacts.DisclosureRegistry, marketAbi: triggerMarketAbi, nilAbi }), /Reconcile existing/);
    withdrawn = appendRecoveryEvent(appendRecoveryEvent(withdrawn, 'sponsorWithdraw'), 'sponsorWithdraw', requestIdentity);
    const beforeRefresh = exportBrowserRecovery(withdrawn);
    const refreshed = await priceSavedSelfFunded(pub, withdrawn, plan, { expectedMarket: market.address, artifact: artifacts.DisclosureRegistry, marketAbi: triggerMarketAbi, nilAbi });
    assert.equal(refreshed.postPackage.args.commit, selfSeal.commit); assert.equal(refreshed.postPackage.args.t1, t1); assert.equal(exportBrowserRecovery(withdrawn), beforeRefresh);
    assert.equal(refreshed.postPackage.feeNil, 25n); assert.equal(writes.length, 5);
    const localJournal = [], attempts = [], selfSpends = [];
    const selfWallet = { account: author, chain: { id: 11155111 }, sendTransaction: async request => {
      selfSpends.push(request);
      const h = hash(++sequence), logs = [];
      transactions.set(h, { hash: h, to: request.to, from: author.address, input: request.data, value: 0n });
      const call = decodeFunctionData({ abi: registry.abi, data: request.data });
      await chain.call(registry, call.functionName, call.args, author.address);
      for (const [addr, topics, data] of chain.result().execResult.logs ?? []) logs.push({ address: toHex(addr), topics: topics.map(toHex), data: toHex(data) });
      receipts.set(h, { transactionHash: h, status: 'success', blockNumber: 10n, blockHash: hash(99), logs }); return h;
    }, writeContract: async request => {
      selfSpends.push(request);
      const h = hash(++sequence), logs = [];
      if (request.functionName === 'postTrigger') transactions.set(h, { hash: h, to: market.address, from: author.address, input: encodeFunctionData({ abi: triggerMarketAbi, functionName: 'postTrigger', args: request.args }), value: request.value });
      if (request.functionName === 'approve') { assert.equal(request.args[1], 25n); allowance = request.args[1]; }
      else {
        assert.equal(request.functionName, 'postTrigger'); assert.ok(request.value <= 500n);
        const params = request.args[0];
        await chain.call(market, 'setTrigger', [8n, author.address, author.address, registry.address, params.t1, params.t2, false]);
        const event = triggerMarketAbi.find(e => e.type === 'event' && e.name === 'TriggerPosted'), args = { ...params, triggerId: 8n, author: author.address, expiry: params.t2 };
        logs.push({ address: market.address, topics: encodeEventTopics({ abi: triggerMarketAbi, eventName: 'TriggerPosted', args }), data: encodeAbiParameters(event.inputs.filter(i => !i.indexed), event.inputs.filter(i => !i.indexed).map(i => args[i.name])) });
      }
      receipts.set(h, { transactionHash: h, status: 'success', blockNumber: 10n, blockHash: hash(99), logs }); return h;
    } };
    allowance = 0n;
    const postPackage = { author: author.address, registry: registry.address, registryAbi: registry.abi, marketAbi: triggerMarketAbi, nilAbi, addresses,
      reportId: self.reportId, cipherHash: self.cipherHash, keyCommit: self.keyCommit, feeNil: 25n, escrowWei: 500n, nextTriggerId: 8n,
      args: { ...args, ...selfSeal }, spend: refreshed.postPackage.spend };
    const consent = { recoverySaved: true, reviewed: true, confirmed: true, costsReady: true };
    const safety = { expectedMarket: market.address, artifact: artifacts.DisclosureRegistry, onAttempt: async action => { attempts.push(action); } };
    await assert.rejects(submitSelfFunded(pub, selfWallet, postPackage, consent, async () => {}, false, safety), /disabled/); assert.equal(attempts.length, 0);
    await assert.rejects(submitSelfFunded({ ...pub, getBalance: async () => 0n }, selfWallet, postPackage, consent, async () => {}, true, safety), /Fund.*ETH/);
    await assert.rejects(submitSelfFunded({ ...pub, readContract: request => request.functionName === 'balanceOf' ? 0n : pub.readContract(request) }, selfWallet, postPackage, consent, async () => {}, true, safety), /Fund.*NIL/);
    await assert.rejects(submitSelfFunded({ ...pub, readContract: request => request.functionName === 'protocolFee' ? 30n : pub.readContract(request) }, selfWallet, postPackage, consent, async () => {}, true, safety), /Costs increased/);
    await assert.rejects(submitSelfFunded({ ...pub, readContract: request => request.functionName === 'quoteEscrow' ? 501n : pub.readContract(request) }, selfWallet, postPackage, consent, async () => {}, true, safety), /Costs increased/);
    await assert.rejects(submitSelfFunded({ ...pub, estimateFeesPerGas: async () => ({ maxFeePerGas: 4n, maxPriorityFeePerGas: 1n }) }, selfWallet, postPackage, consent, async () => {}, true, safety), /Costs increased/);
    assert.equal(attempts.length, 0, 'preflight funding and fee failures record no attempt and send nothing');
    const { nonce: _nonce, ...recoverableArgs } = postPackage.args;
    let browserRecovery = await validateBrowserRecovery({ ...await newBrowserRecovery(self, '0x' + '12'.repeat(32)),
      sealing: { registry: registry.address, market: market.address, cipherUris: ['https://a.example/report', 'https://b.example/report'], nonce: toHex(selfSeal.nonce), args: encodeWire(recoverableArgs) } });
    let interruptAfterPost = true;
    const interruptedPub = { ...pub, readContract: async request => {
      if (request.functionName === 'hookMeta' && request.args[0] === 8n && interruptAfterPost) { interruptAfterPost = false; throw new Error('fixture loss after successful post'); }
      return pub.readContract(request);
    } };
    const save = async (action, hash) => { browserRecovery = appendRecoveryEvent(browserRecovery, action, hash); localJournal.push({ action, hash }); };
    await assert.rejects(submitSelfFunded(interruptedPub, selfWallet, postPackage, consent, save, true, {
      ...safety, onAttempt: async action => { browserRecovery = appendRecoveryEvent(browserRecovery, action); attempts.push(action); },
    }), /fixture loss after successful post/);
    assert.equal(browserRecovery.history.length, 6);
    assert.equal(selfSpends.length, 3);
    for (const request of selfSpends) {
      assert.equal(request.maxFeePerGas, postPackage.spend.maxFeePerGas);
      assert.equal(request.maxPriorityFeePerGas, postPackage.spend.maxPriorityFeePerGas);
      assert.equal(request.gas, postPackage.spend.gas.post, 'fixture estimates match; every actual send has the reviewed headroom cap');
    }
    const recoveryOptions = { expectedMarket: market.address, artifact: artifacts.DisclosureRegistry, marketAbi: triggerMarketAbi };
    const observed = await inspectBrowserRecovery(pub, browserRecovery, recoveryOptions);
    assert.equal(observed.triggerId, 8n); assert.equal(observed.bound, false);
    for (const number of [undefined, null, 10, '10', -1n]) {
      await assert.rejects(inspectBrowserRecovery({ ...pub, getBlock: async request => request?.blockTag === 'finalized' ? { ...await pub.getBlock(request), number } : pub.getBlock(request) }, browserRecovery, recoveryOptions), /Finalized recovery head unavailable/);
    }
    for (const hash of [undefined, '0x', '0x1234', 'x'.repeat(66)]) {
      await assert.rejects(inspectBrowserRecovery({ ...pub, getBlock: async request => request?.blockTag === 'finalized' ? { ...await pub.getBlock(request), hash } : pub.getBlock(request) }, browserRecovery, recoveryOptions), /Finalized recovery head unavailable/);
    }
    await assert.rejects(inspectBrowserRecovery({ ...pub, getChainId: async () => 1 }, browserRecovery, recoveryOptions), /Sepolia/);
    await assert.rejects(inspectBrowserRecovery({ ...pub, getBlock: async request => request?.blockTag === 'finalized' ? { ...await pub.getBlock(request), number: 9n } : pub.getBlock(request) }, browserRecovery, recoveryOptions), /unresolved or noncanonical/);
    await assert.rejects(inspectBrowserRecovery({ ...pub, getBlock: async request => request?.blockNumber === 10n ? { ...await pub.getBlock(request), hash: hash(100) } : pub.getBlock(request) }, browserRecovery, recoveryOptions), /unresolved or noncanonical/);
    await assert.rejects(inspectBrowserRecovery(pub, appendRecoveryEvent(browserRecovery, 'bind'), recoveryOptions), /Unresolved/);
    const savedTx = transactions.get(observed.postHash);
    transactions.set(observed.postHash, { ...savedTx, input: '0x' });
    await assert.rejects(inspectBrowserRecovery(pub, browserRecovery, recoveryOptions), /transaction/);
    transactions.set(observed.postHash, savedTx);
    const costs = await priceRecoveredBinding(pub, observed);
    for (const field of ['maxPriorityFeePerGas', 'maxFeePerGas']) {
      for (const value of [undefined, null, '3', 3]) {
        await assert.rejects(priceRecoveredBinding({ ...pub, estimateFeesPerGas: async () => ({ maxFeePerGas: 3n, maxPriorityFeePerGas: 1n, [field]: value }) }, observed), /Live binding costs unavailable/);
      }
    }
    const before = sequence;
    await assert.rejects(resumeBrowserBinding(pub, selfWallet, browserRecovery, consent, costs, false, { ...recoveryOptions, onAttempt: async () => {}, onSubmitted: async () => {} }), /disabled/);
    assert.equal(sequence, before);
    for (const balance of [undefined, null, '100000000', -1n]) {
      await assert.rejects(resumeBrowserBinding({ ...pub, getBalance: async () => balance }, selfWallet, browserRecovery, consent, costs, true, {
        ...recoveryOptions, onAttempt: async () => { throw new Error('unexpected write'); }, onSubmitted: async () => {},
      }), /Author funds unavailable/);
    }
    for (const field of ['gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas', 'gasWei']) {
      await assert.rejects(resumeBrowserBinding(pub, selfWallet, browserRecovery, consent, { ...costs, [field]: undefined }, true, {
        ...recoveryOptions, onAttempt: async () => { throw new Error('unexpected write'); }, onSubmitted: async () => {},
      }), /Reviewed binding costs unavailable/);
    }
    await assert.rejects(resumeBrowserBinding({ ...pub, estimateFeesPerGas: async () => ({ maxFeePerGas: 4n, maxPriorityFeePerGas: 1n }) }, selfWallet, browserRecovery, consent, costs, true, { ...recoveryOptions, onAttempt: async () => { throw new Error('unexpected write'); }, onSubmitted: async () => {} }), /exceeds reviewed cost/);
    assert.equal(sequence, before);
    for (const timestamp of [undefined, null, '1000', -1n, 0n, 1n << 64n]) {
      await assert.rejects(resumeBrowserBinding({ ...pub, getBlock: async request => request ? pub.getBlock(request) : { ...await pub.getBlock(), timestamp } }, selfWallet, browserRecovery, consent, costs, true, {
        ...recoveryOptions, onAttempt: async () => { throw new Error('unexpected write'); }, onSubmitted: async () => {},
      }), /Live binding timestamp unavailable/);
    }
    assert.equal(sequence, before);
    let newlyMined = false;
    const laggingFinality = { ...pub,
      getBlock: async request => request?.blockTag === 'finalized' && newlyMined ? { ...await pub.getBlock(request), number: 9n } : pub.getBlock(request),
      waitForTransactionReceipt: async request => { newlyMined = true; return pub.waitForTransactionReceipt(request); },
    };
    await assert.rejects(resumeBrowserBinding(laggingFinality, selfWallet, browserRecovery, consent, costs, true, {
      ...recoveryOptions, onAttempt: async () => { browserRecovery = appendRecoveryEvent(browserRecovery, 'bind'); attempts.push('bind'); },
      onSubmitted: async hash => { await save('bind', hash); },
    }), /unresolved or noncanonical/);
    const after = sequence;
    const selfPosted = await resumeBrowserBinding(pub, selfWallet, browserRecovery, consent, costs, false, { ...recoveryOptions, onAttempt: async () => { throw new Error('unexpected write'); }, onSubmitted: async () => { throw new Error('unexpected write'); } });
    assert.equal(selfPosted.state, 'bound');
    assert.equal(sequence, after);
    assert.equal(selfPosted.triggerId, 8n); assert.equal((await chain.call(registry, 'statusOf', [self.reportId])).bindTime > 0n, true);
    assert.deepEqual(attempts, ['register', 'approve', 'postTrigger', 'bind']);
    assert.deepEqual(localJournal.map(tx => tx.action), ['register', 'approve', 'postTrigger', 'bind']);
    // T-17 local composition: disabling the portal leaves the real immutable
    // registry callable by its market and its public notice available at t1.
    const inbox = new PortalInbox(store, 90 * 86400);
    const contact = inbox.requestContact(session, 'alpha.example', { email: 'security@alpha.example', publicKey: '0x' + 'ab'.repeat(32) });
    inbox.confirmContact(session, 'alpha.example', contact.id, inbox.pendingDeliveries()[0].code);
    const notice = await signNotice({ version: 1, chainId: 11155111, registry: registry.address, reportId: report.reportId, triggerId: '7', cipherHash: report.cipherHash,
      keyCommit: report.keyCommit, cipherUris: ['https://a.example/cipher', 'https://b.example/cipher'], window: { t1: '1600', t2: '5200' }, researcher: author.address, verifyUrl: 'https://pluto.example/#verifier' }, author);
    await inbox.deliverNotice(contact.id, notice); assert.equal(inbox.publicCopy(report.reportId), undefined);
    store.setEnabled(session, 'alpha.example', false); portalTime = 1601; chain.setTime(1601n);
    await chain.call(registry, 'onReveal', [7n, toHex(new Uint8Array([...payload, ...sealed.nonce]))], market.address);
    const acceptance = chain.result().execResult.logs.map(([address, topics, data]) => ({ address: toHex(address), ...decodeEventLog({ abi: registry.abi, topics: topics.map(toHex), data: toHex(data) }), blockNumber: 20n, blockHash: hash(99), removed: false }));
    assert.equal((await chain.call(registry, 'statusOf', [report.reportId])).disclosed, true);
    assert.ok(inbox.publicCopy(report.reportId));
    const verified = await verifyPublicReport({ pub: { ...pub, getBlock: async () => ({ number: 20n, timestamp: 1601n, hash: hash(99) }), getContractEvents: async () => acceptance },
      notice: inbox.publicCopy(report.reportId), market: market.address, registryAbi: registry.abi, marketAbi: triggerMarketAbi, artifact: artifacts.DisclosureRegistry, fromBlock: 1n }, hexToBytes(report.ciphertext));
    assert.equal(new TextDecoder().decode(verified.plaintext), 'secret researcher fixture');
  } finally { store.close(); await rm(dir, { recursive: true }); }
});
