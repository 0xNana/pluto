import { nilAbi, triggerMarketAbi } from '@nillion/covenants-sdk';
import { decodeFunctionData, getAddress, keccak256, parseEventLogs, type Abi, type Hex, type PublicClient } from 'viem';

export interface LedgerChain { payer: Hex; market: Hex; nil: Hex; registry: Hex; registryAbi: Abi }
async function finalizedHead(pub: PublicClient) {
  if (await pub.getChainId() !== 11155111) throw new Error('Ledger requires Sepolia');
  const head = await pub.getBlock({ blockTag: 'finalized' });
  if (head.number === null || !head.hash) throw new Error('Finalized head unavailable');
  return head;
}
export async function finalizedCosts(pub: PublicClient, chain: LedgerChain, author: Hex, attempts: Record<string, unknown>[], interrupted = false) {
  const head = await finalizedHead(pub);
  let ethSpentWei = 0n, nilSpentUnits = 0n, refundableWei = 0n, triggerId: bigint | undefined, postBlock = 0n;
  let reverted = false;
  let bindingSucceeded = false;
  const outcomes: { action: string; hash: Hex; status: string }[] = [];
  for (const attempt of attempts) {
    const hash = String(attempt.hash) as Hex;
    const tx = await pub.getTransaction({ hash });
    const receipt = await pub.getTransactionReceipt({ hash });
    const action = String(attempt.action).split(':')[0], abi = action === 'approve' ? nilAbi : action === 'post' ? triggerMarketAbi : chain.registryAbi;
    const target = action === 'approve' ? chain.nil : action === 'post' ? chain.market : chain.registry;
    const expectedFunction = action === 'approve' ? 'approve' : action === 'post' ? 'postTriggerSponsored' : action === 'register' ? 'registerBySig' : 'bindBySig';
    if (!tx.to || tx.hash !== hash || receipt.transactionHash !== hash || getAddress(tx.from) !== getAddress(chain.payer)
        || getAddress(tx.to) !== getAddress(target) || getAddress(tx.to) !== getAddress(String(attempt.destination))
        || keccak256(tx.input) !== attempt.data_hash || tx.value !== BigInt(String(attempt.value))
        || typeof tx.gas !== 'bigint' || tx.gas > BigInt(String(attempt.gas_units)) || (tx.maxFeePerGas ?? tx.gasPrice ?? 0n) > BigInt(String(attempt.max_fee))
        || receipt.blockNumber > head.number! || !['success', 'reverted'].includes(receipt.status)
        || receipt.gasUsed > tx.gas || receipt.effectiveGasPrice > BigInt(String(attempt.max_fee))
        || (await pub.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash
        || decodeFunctionData({ abi, data: tx.input }).functionName !== expectedFunction) throw new Error('Finalized transaction proof mismatch; reservation retained');
    ethSpentWei += receipt.gasUsed * receipt.effectiveGasPrice;
    outcomes.push({ action: String(attempt.action), hash, status: receipt.status });
    if (receipt.status === 'reverted') { reverted = true; continue; }
    if (action === 'post') {
      if (triggerId !== undefined) throw new Error('Multiple successful posts; reservation retained');
      const events = parseEventLogs({ abi: triggerMarketAbi, eventName: 'TriggerPosted', logs: receipt.logs, strict: true }).filter(log => getAddress(log.address) === getAddress(chain.market) && !log.removed);
      if (events.length !== 1 || getAddress(events[0].args.author) !== getAddress(author)) throw new Error('Posted author proof unavailable');
      triggerId = events[0].args.triggerId; postBlock = receipt.blockNumber; refundableWei = tx.value;
    } else if (tx.value !== 0n) throw new Error('Unexpected payable action');
    if (action === 'bind') bindingSucceeded = true;
    let actionNil = 0n;
    for (const log of parseEventLogs({ abi: nilAbi, eventName: 'Transfer', logs: receipt.logs, strict: true })) {
      if (getAddress(log.address) === getAddress(chain.nil) && getAddress(log.args.from) === getAddress(chain.payer) && !log.removed) actionNil += log.args.value;
    }
    if (actionNil > BigInt(String(attempt.nil_units))) throw new Error('NIL debit exceeds claimed ceiling; reservation retained');
    nilSpentUnits += actionNil;
  }
  if (triggerId === undefined && !interrupted && !reverted) throw new Error('Posted trigger unavailable');
  if (triggerId !== undefined) {
    const parties = await pub.readContract({ address: chain.market, abi: triggerMarketAbi, functionName: 'postingParties', args: [triggerId], blockNumber: head.number! });
    if (getAddress(parties[0]) !== getAddress(author) || getAddress(parties[1]) !== getAddress(chain.payer)) throw new Error('Refund payer proof mismatch');
  }
  if ((await pub.getBlock({ blockNumber: head.number! })).hash !== head.hash) throw new Error('Finality changed; reservation retained');
  return { ethSpentWei, nilSpentUnits, refundableWei, triggerId, postBlock, reverted, bindingSucceeded, outcomes };
}
export async function finalizedEscrow(pub: PublicClient, chain: LedgerChain, triggerId: bigint, postBlock: bigint, deposit: bigint) {
  const head = await finalizedHead(pub);
  const meta = await pub.readContract({ address: chain.market, abi: triggerMarketAbi, functionName: 'triggerMeta', args: [triggerId], blockNumber: head.number! });
  const parties = await pub.readContract({ address: chain.market, abi: triggerMarketAbi, functionName: 'postingParties', args: [triggerId], blockNumber: head.number! });
  if (getAddress(parties[1]) !== getAddress(chain.payer) || meta[10] !== 0n || meta[11] !== 0n || (!meta[8] && head.timestamp <= meta[3])) throw new Error('Escrow outcome unresolved; reservation retained');
  let refunded = 0n;
  const seen = new Set<string>();
  for (let fromBlock = postBlock; fromBlock <= head.number!; fromBlock += 1000n) {
    const toBlock = fromBlock + 999n < head.number! ? fromBlock + 999n : head.number!;
    for (const eventName of ['RefundIssued', 'RefundClaimed'] as const) {
    const logs = await pub.getContractEvents({ address: chain.market, abi: triggerMarketAbi, eventName, args: { triggerId }, fromBlock, toBlock, strict: true });
    for (const log of logs) {
      const id = `${log.transactionHash}:${log.logIndex}`;
      if (log.removed || log.args.triggerId !== triggerId || getAddress(log.address) !== getAddress(chain.market) || !log.transactionHash || log.logIndex === null || log.blockNumber === null || log.blockNumber < fromBlock || log.blockNumber > toBlock || (await pub.getBlock({ blockNumber: log.blockNumber })).hash !== log.blockHash) throw new Error('Invalid refund evidence');
      if (!seen.has(id)) { refunded += log.args.amount; seen.add(id); }
    }
    }
  }
  if (refunded > deposit || (await pub.getBlock({ blockNumber: head.number! })).hash !== head.hash) throw new Error('Invalid final escrow accounting');
  // A missing archive event conservatively consumes the budget; it never frees
  // additional spending capacity. Archive completeness is a release prerequisite.
  return deposit - refunded;
}
