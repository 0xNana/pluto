import { getAddress, isAddress, type Hex, type PublicClient } from 'viem';

export interface CostCall { action: 'approve' | 'register' | 'post' | 'bind'; payer: Hex; to: Hex; data: Hex; value: bigint }
// eth_simulateV1 builds on each preceding call's state, so registration and
// binding can be priced before any transaction is sent. No storage overrides.
// https://viem.sh/docs/actions/public/simulateBlocks
export async function quoteTransactionCosts(pub: PublicClient, calls: readonly CostCall[]) {
  if (await pub.getChainId() !== 11155111) throw new Error('Cost planner requires Sepolia');
  if (calls.length < 3 || calls.length > 4 || new Set(calls.map(c => c.action)).size !== calls.length
      || !['register', 'post', 'bind'].every(action => calls.some(c => c.action === action))
      || calls.some(c => !isAddress(c.to) || !isAddress(c.payer) || !/^0x(?:[a-fA-F0-9]{2})+$/.test(c.data) || c.data.length > 100_000 || c.value < 0n)) throw new Error('Invalid cost calls');
  const block = await pub.getBlock();
  if (block.number === null) throw new Error('Live block unavailable');
  const fees = await pub.estimateFeesPerGas();
  const feeWei = fees.maxFeePerGas;
  if (typeof feeWei !== 'bigint' || feeWei < 1n) throw new Error('Current gas fee estimate unavailable');
  if (typeof fees.maxPriorityFeePerGas !== 'bigint' || fees.maxPriorityFeePerGas < 0n || fees.maxPriorityFeePerGas > feeWei) throw new Error('Current priority fee estimate unavailable');
  let result;
  try {
    result = await pub.simulateBlocks({ blockNumber: block.number, validation: false, blocks: [{
      calls: calls.map(c => ({ from: c.payer, to: c.to, data: c.data, value: c.value })) }] });
  } catch { throw new Error('Sequential gas simulation unavailable; do not post'); }
  const outcomes = result[0]?.calls;
  if (!outcomes || outcomes.length !== calls.length || outcomes.some(c => c.status !== 'success' || c.gasUsed < 1n)) throw new Error('Posting sequence gas simulation failed');
  const items = calls.map((call, i) => ({ action: call.action, payer: getAddress(call.payer),
    gasUnits: outcomes[i].gasUsed, gasWei: outcomes[i].gasUsed * feeWei, refundable: false }));
  return { block: block.number, maxFeePerGas: feeWei, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, items, totalGasWei: items.reduce((sum, item) => sum + item.gasWei, 0n),
    note: 'Live sequential simulation estimate; gas and basefee may change before mining' };
}
