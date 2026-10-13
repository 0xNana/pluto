import { BaseError, ContractFunctionRevertedError } from 'viem';
import { postSealed, postSponsored } from '@nillion/covenants-sdk/browser';

export function contractErrorName(error) {
  return error instanceof BaseError
    ? error.walk(cause => cause instanceof ContractFunctionRevertedError)?.data?.errorName : undefined;
}

// SDK posting re-quotes every attempt. Retry only an authenticated WrongValue
// and never an ambiguous send/receipt failure. Keep failed hashes recoverable.
export async function postWithEscrowRetry(pub, wallet, addresses, args,
  { onRequote = async () => {}, onReverted = async () => {} } = {}) {
  const post = args.authorization ? postSponsored : postSealed;
  for (let attempt = 0; attempt < 2; attempt++) {
    let postHash;
    let receipt;
    let broadcastAttempted = false;
    let preflightFailed = false;
    const trackedWallet = { ...wallet, async writeContract(request) {
      if (preflightFailed) throw new Error('Live committee preflight unavailable; submission refused');
      if (['postTrigger', 'postTriggerSponsored'].includes(request.functionName)) {
        // A simulation revert is safe to re-quote. A wallet error without a
        // hash may follow broadcast, so it must never authorize another send.
        await pub.simulateContract({ ...request, account: request.account ?? wallet.account });
        broadcastAttempted = true;
      }
      const hash = await wallet.writeContract(request);
      if (['postTrigger', 'postTriggerSponsored'].includes(request.functionName)) postHash = hash;
      return hash;
    } };
    const trackedPub = { ...pub, async readContract(request) {
      try { return await pub.readContract(request); }
      catch (error) {
        if (request.functionName !== 'getActiveKeys') throw error;
        // SDK liveness warnings render error.message. Do not allow a raw RPC
        // exception to leak a credential-bearing URL, and do not proceed.
        preflightFailed = true; throw new Error('Live committee preflight unavailable');
      }
    }, async getBlock(request) {
      try { return await pub.getBlock(request); }
      catch { preflightFailed = true; throw new Error('Live committee preflight unavailable'); }
    }, async waitForTransactionReceipt(request) {
      const observed = await pub.waitForTransactionReceipt(request);
      if (request.hash === postHash) receipt = observed;
      return observed;
    } };
    try { return await post(trackedPub, trackedWallet, addresses, args); } catch (error) {
      if (attempt || contractErrorName(error) !== 'WrongValue') throw error;
      if (broadcastAttempted && !postHash) throw error;
      if (postHash) {
        if (receipt?.status !== 'reverted' || receipt.transactionHash !== postHash) throw error;
        // A recent reverted receipt can be orphaned. Wait for independent
        // finalized/canonical evidence before permitting a second paid post.
        const head = await pub.getBlock({ blockTag: 'finalized' });
        if (head.number === null || !head.hash || typeof receipt.blockNumber !== 'bigint' || receipt.blockNumber > head.number
            || !receipt.blockHash || (await pub.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash
            || (await pub.getBlock({ blockNumber: head.number })).hash !== head.hash) throw error;
        await onReverted(receipt);
      }
      await onRequote();
    }
  }
  throw new Error('Escrow retry exhausted');
}
