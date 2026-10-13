import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Account, createAddressFromString } from '@ethereumjs/util';
import { ContractFunctionRevertedError, encodeAbiParameters, encodeErrorResult, encodeEventTopics, hashTypedData,
  hexToBytes, recoverTypedDataAddress, toHex, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseConditionRecord } from '@nillion/covenants-sdk/browser';
import { mpkFromSecret, selectCommittee, sponsoredPostMessage, SPONSORED_POST_TYPES,
  SPONSORED_DOMAIN_NAME, SPONSORED_DOMAIN_VERSION, triggerMarketAbi } from '@nillion/covenants-sdk';
import { compileContracts } from '../scripts/lib/contracts.mjs';
import { runSpikeCommand } from '../scripts/spike-sepolia.mjs';
import { evmHarness } from './support/evm.mjs';
import { marketMockSource } from './support/market.mjs';

// Actual SDK signing/posting and compiled registry; market/RPC pricing and
// authorization verification are independent local fixtures, not Sepolia proof.
test('P-03 wires SDK sponsorship through deployed EVM registration/post/binding and saves a pending refund decision', async () => {
  const artifacts = await compileContracts({ 'MockMarket.sol': marketMockSource() });
  const chain = await evmHarness({ chainId: 11155111 });
  const market = await chain.deploy(artifacts.MockMarket);
  const payerKey = `0x${'05'.repeat(32)}`;
  const payer = privateKeyToAccount(payerKey);
  await chain.evm.stateManager.putAccount(createAddressFromString(payer.address), new Account(0n, 10n ** 22n));
  const directory = await mkdtemp(join(tmpdir(), 'pluto-sponsored-'));
  const out = join(directory, 'evidence.json');
  let hook, posted, nilBalance = 1000n, sequence = 0n;
  const receipts = new Map(), used = new Set();
  const domain = { name: SPONSORED_DOMAIN_NAME, version: SPONSORED_DOMAIN_VERSION,
    chainId: 11155111, verifyingContract: market.address };
  const message = (params, authorization) => sponsoredPostMessage({ ...params,
    mode: params.mode === 1 ? 'PUBLIC_CONDITION' : 'PRIVATE_CONDITION',
    layers: params.layers, keys: params.keyIds.map(keyId => ({ keyId })) }, authorization);
  const revert = name => { throw new ContractFunctionRevertedError({ abi: triggerMarketAbi,
    data: encodeErrorResult({ abi: triggerMarketAbi, errorName: name }), functionName: 'postTriggerSponsored' }); };
  const receipt = (hash, logs = [], contractAddress) => ({ transactionHash: hash, blockNumber: 10n,
    from: payer.address, status: 'success', gasUsed: 50000n, effectiveGasPrice: 1n, logs, contractAddress });
  const committee = selectCommittee([1, 2, 3].map(n => ({ nodeId: BigInt(n), keyId: BigInt(n),
    mpk: toHex(mpkFromSecret(new Uint8Array(32).fill(n))), expiresAt: 10000n, stake: 10n, fired: 0n, markup: 0,
    operator: toHex(BigInt(n), { size: 20 }) })), { m: 3, k: 2, minStake: 1n, nowUnix: 1000n, pick: 'top' });
  const plan = { addresses: { market: market.address, config: chain.foreign, nil: chain.foreign }, committee,
    ceilingWei: 90n, layerLength: 230n, parameters: { defaultHookGas: 250000, maxHookGas: 500000,
      maxRetryWindowSecs: 604800, maxCiphertextBytes: 1000n } };
  const client = { getChainId: async () => 11155111, getBlock: async () => ({ number: 10n, timestamp: 1000n, baseFeePerGas: 1n }),
    getBalance: async ({ address }) => (await chain.evm.stateManager.getAccount(createAddressFromString(address)))?.balance ?? 0n,
    getTransactionCount: async () => 0,
    getBytecode: async ({ address }) => toHex(await chain.evm.stateManager.getCode(createAddressFromString(address))),
    getCode: async ({ address }) => toHex(await chain.evm.stateManager.getCode(createAddressFromString(address))),
    waitForTransactionReceipt: async ({ hash }) => receipts.get(hash),
    readContract: async request => {
      if (hook && request.address.toLowerCase() === hook.address) return chain.call(hook, request.functionName, request.args);
      if (['postingParties', 'hookMeta', 'triggerMeta'].includes(request.functionName)) return chain.call(market, request.functionName, request.args);
      if (request.functionName === 'protocolFee') return 25n;
      if (request.functionName === 'balanceOf') return request.args[0].toLowerCase() === payer.address.toLowerCase() ? nilBalance : 0n;
      if (request.functionName === 'allowance') return 25n;
      if (['escrowMath', 'authVerifier'].includes(request.functionName)) return chain.foreign;
      if (request.functionName === 'authNonceUsed') return used.has(`${request.args[0]}:${request.args[1]}`);
      if (request.functionName === 'quoteEscrow') return request.args[5] === zeroAddress ? 400n : 500n;
      if (request.functionName === 'digestOf') return hashTypedData({ domain, types: SPONSORED_POST_TYPES,
        primaryType: 'SponsoredPost', message: message(...request.args) });
      throw new Error(`Unexpected fixture read: ${request.functionName}`);
    },
    simulateContract: async request => {
      if (request.functionName === 'postTriggerSponsored') {
        const [params, auth] = request.args;
        if (used.has(`${auth.author}:${auth.nonce}`)) revert('AuthConsumed');
        const recovered = await recoverTypedDataAddress({ domain, types: SPONSORED_POST_TYPES,
          primaryType: 'SponsoredPost', message: message(params, auth), signature: auth.signature });
        if (recovered !== auth.author) revert('BadAuthSignature');
      } else if (request.functionName === 'postTrigger') {
        const params = request.args[0];
        if (params.ttl !== 0) revert('TtlForbidden');
        if (params.t1 < 1000n || params.t2 <= params.t1) revert('BadWindow');
        const record = parseConditionRecord(hexToBytes(params.publicCondition));
        if (params.t1 !== record.t1 || params.t2 !== record.t2) revert('WindowMismatch');
        if (params.hookGasLimit > 500000) revert('HookGasTooLarge');
        if (params.retryWindowSecs > 604800) revert('RetryWindowTooLong');
        if (params.layers.reduce((sum, layer) => sum + hexToBytes(layer).length, 0) > 1000) revert('CiphertextTooLarge');
      } else {
        await chain.evm.stateManager.checkpoint();
        try { await chain.call(hook, request.functionName, request.args, payer.address); }
        catch (error) {
          throw new ContractFunctionRevertedError({ abi: hook.abi, data: error.message.split(': ').at(-1), functionName: request.functionName });
        } finally { await chain.evm.stateManager.revert(); }
      }
      return { request: { ...request, account: typeof request.account === 'string'
        ? { address: request.account, type: 'json-rpc' } : request.account } };
    },
  };
  const wallet = { account: payer, chain: { id: 11155111 },
    async deployContract(artifact) {
      hook = await chain.deploy(artifact, artifact.args, payer.address);
      const hash = toHex(++sequence, { size: 32 });
      receipts.set(hash, receipt(hash, [], hook.address));
      return hash;
    },
    async writeContract(request) {
      const signer = request.account ?? wallet.account;
      assert.equal(signer.type, 'local', 'Preserve local signing rather than an RPC account');
      assert.equal(signer.address, payer.address);
      assert.equal(typeof signer.signTransaction, 'function');
      const hash = toHex(++sequence, { size: 32 });
      const logs = [];
      if (request.functionName === 'postTriggerSponsored') {
        const [params, auth] = request.args;
        posted = params;
        used.add(`${auth.author}:${auth.nonce}`);
        nilBalance -= 25n;
        await chain.call(market, 'setTrigger', [0n, auth.author, payer.address, hook.address, params.t1, params.t2, false]);
        const fields = triggerMarketAbi.find(item => item.type === 'event' && item.name === 'TriggerPosted').inputs;
        const args = { ...params, triggerId: 0n, author: auth.author, expiry: params.t2 };
        logs.push({ address: market.address, topics: encodeEventTopics({ abi: triggerMarketAbi, eventName: 'TriggerPosted', args }),
          data: encodeAbiParameters(fields.filter(field => !field.indexed), fields.filter(field => !field.indexed).map(field => args[field.name])) });
      } else {
        await chain.call(hook, request.functionName, request.args, payer.address);
        logs.push(...chain.result().execResult.logs.map(([address, topics, data]) =>
          ({ address: toHex(address), topics: topics.map(toHex), data: toHex(data) })));
      }
      receipts.set(hash, receipt(hash, logs));
      return hash;
    },
  };
  try {
    const output = [];
    assert.equal(await runSpikeCommand(['sponsored', '--out', out], { client: () => client,
      inspect: async () => plan, walletFactory: () => wallet, payerKey, expectedMarket: market.address,
      print: text => output.push(text), diagnostic: text => output.push(text) }), 0, output.join('\n'));
    const saved = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(saved.sponsorshipVerified, true);
    assert.equal(saved.registryBinding.bound, true);
    assert.equal(saved.triggerId, '0');
    assert.equal(saved.fundingDecision.decision, 'pending');
    assert.equal(saved.payerNilBefore, '1000');
    assert.equal(saved.payerNilAfter, '975');
    assert.equal(saved.signedMarketFields.length, 18);
    assert.deepEqual(saved.windowWidthChecks.map(check => check.outcome), ['accepted', 'accepted']);
    assert.ok(saved.rejectionChecks.some(check => check.label === 'reused market grant'));
    assert.deepEqual(saved.registryEvents.map(event => event.event), ['Registered', 'Bound']);
    assert.ok(!JSON.stringify(saved).includes(posted.layers[0].slice(2)));
    assert.ok(!JSON.stringify(saved).includes('signature'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
