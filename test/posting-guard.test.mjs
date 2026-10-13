import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileCondition, mpkFromSecret, seal, selectCommittee } from '@nillion/covenants-sdk';
import { ContractFunctionRevertedError, encodeErrorResult, encodeAbiParameters, encodeEventTopics, hexToBytes, toHex } from 'viem';
import { triggerMarketAbi } from '@nillion/covenants-sdk';
import { postWithEscrowRetry } from '../src/chain/posting.mjs';

test('posting refuses an unavailable SDK liveness preflight without logging raw RPC credentials or broadcasting', async () => {
  const addresses = { market: '0x' + '12'.repeat(20), config: '0x' + '34'.repeat(20), nil: '0x' + '56'.repeat(20) };
  const candidates = [1, 2, 3].map(n => ({ nodeId: BigInt(n), keyId: BigInt(n), mpk: toHex(mpkFromSecret(new Uint8Array(32).fill(n))), expiresAt: 10000n, stake: 10n, fired: 0n, markup: 0, operator: toHex(BigInt(n), { size: 20 }) }));
  const committee = selectCommittee(candidates, { m: 3, k: 2, minStake: 1n, nowUnix: 1000n, pick: 'top' });
  const sealed = seal(new Uint8Array(64), 'PUBLIC_CONDITION', compileCondition({ window: { t1: 1600n, t2: 5200n } }), 2, committee.keys.map(k => hexToBytes(k.mpk)));
  const args = { ...sealed, keys: committee.keys, k: 2, mode: 'PUBLIC_CONDITION', ttl: 0, t1: 1600n, t2: 5200n, ceilingWei: 5n, feeApprovalAmount: 25n };
  const pub = { getCode: async () => '0x1234', getBalance: async () => 10n ** 22n, getBlock: async () => ({ timestamp: 1000n }),
    readContract: async request => {
      if (request.functionName === 'getActiveKeys') throw new Error('https://user:private-rpc-token@rpc.example signed calldata');
      if (request.functionName === 'protocolFee') return 25n;
      if (request.functionName === 'balanceOf') return 1000n;
      if (request.functionName === 'allowance') return 0n;
      if (request.functionName === 'quoteEscrow') return 500n;
      if (request.functionName === 'escrowMath') return addresses.market;
      throw new Error('Unexpected read');
    } };
  let broadcasts = 0;
  const wallet = { account: { address: addresses.market }, writeContract: async () => { broadcasts++; throw new Error('unexpected broadcast'); } };
  const warnings = [], original = console.warn; console.warn = value => warnings.push(value);
  try {
    await assert.rejects(postWithEscrowRetry(pub, wallet, addresses, args), /preflight unavailable/);
    assert.equal(broadcasts, 0); assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings.join('\n'), /private-rpc-token|rpc\.example|signed calldata/);
  } finally { console.warn = original; }
});

test('FR-205 a mined WrongValue retries only after a canonical finalized revert and retains failed-hash evidence', async () => {
  const market = '0x' + '12'.repeat(20), module = '0x' + '34'.repeat(20), author = '0x' + '56'.repeat(20);
  const candidates = [1, 2, 3].map(n => ({ nodeId: BigInt(n), keyId: BigInt(n), mpk: toHex(mpkFromSecret(new Uint8Array(32).fill(n))), expiresAt: 10000n, stake: 10n, fired: 0n, markup: 0, operator: toHex(BigInt(n), { size: 20 }) }));
  const committee = selectCommittee(candidates, { m: 3, k: 2, minStake: 1n, nowUnix: 1000n, pick: 'top' });
  const sealed = seal(new Uint8Array(64), 'PUBLIC_CONDITION', compileCondition({ window: { t1: 1600n, t2: 5200n } }), 2, committee.keys.map(k => hexToBytes(k.mpk)));
  const args = { ...sealed, keys: committee.keys, k: 2, mode: 'PUBLIC_CONDITION', ttl: 0, t1: 1600n, t2: 5200n, ceilingWei: 5n, feeApprovalAmount: 25n };
  const blockHash = toHex(99n, { size: 32 }), firstHash = toHex(1n, { size: 32 }), secondHash = toHex(2n, { size: 32 });
  for (const scenario of ['unfinalized', 'orphaned', 'finalized']) {
    let sends = 0, posted;
    const failed = [], wallet = { account: { address: author }, writeContract: async request => { assert.equal(request.functionName, 'postTrigger'); posted = request.args[0]; return ++sends === 1 ? firstHash : secondHash; } };
    const pub = { getBlock: async ({ blockTag, blockNumber } = {}) => ({ number: blockTag === 'finalized' && scenario === 'unfinalized' ? 9n : blockNumber ?? 20n,
      hash: scenario === 'orphaned' && blockNumber === 10n ? toHex(100n, { size: 32 }) : blockHash, timestamp: 1000n }),
      getBalance: async () => 10n ** 22n,
      readContract: async ({ functionName }) => functionName === 'getActiveKeys' ? candidates : functionName === 'protocolFee' || functionName === 'allowance' ? 25n
        : functionName === 'balanceOf' ? 1000n : functionName === 'quoteEscrow' ? 500n : module,
      simulateContract: async request => {
        if (request.blockNumber === 10n) throw new ContractFunctionRevertedError({ abi: triggerMarketAbi, data: encodeErrorResult({ abi: triggerMarketAbi, errorName: 'WrongValue' }) });
        return { request };
      }, waitForTransactionReceipt: async ({ hash }) => {
        if (hash === firstHash) return { transactionHash: hash, status: 'reverted', blockNumber: 10n, blockHash, logs: [] };
        const event = triggerMarketAbi.find(e => e.type === 'event' && e.name === 'TriggerPosted'), fields = { ...posted, author, triggerId: 7n, expiry: posted.t2 };
        return { transactionHash: hash, status: 'success', blockNumber: 20n, blockHash, logs: [{ address: market,
          topics: encodeEventTopics({ abi: triggerMarketAbi, eventName: 'TriggerPosted', args: fields }), data: encodeAbiParameters(event.inputs.filter(i => !i.indexed), event.inputs.filter(i => !i.indexed).map(i => fields[i.name])) }] };
      } };
    const operation = postWithEscrowRetry(pub, wallet, { market, config: module, nil: module }, args, { onReverted: async receipt => { failed.push(receipt.transactionHash); } });
    if (scenario === 'finalized') { assert.equal((await operation).triggerId, 7n); assert.equal(sends, 2); assert.deepEqual(failed, [firstHash]); }
    else { await assert.rejects(operation, error => error.data?.errorName === 'WrongValue'); assert.equal(sends, 1); assert.deepEqual(failed, []); }
  }
});
