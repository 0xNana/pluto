import { BaseError, ContractFunctionRevertedError, createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import { DeploymentError } from '../../src/chain/deployment.mjs';
import { withPaginatedEvents } from '../../src/chain/rpc.mjs';

export const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item, 2);

export function probeClient() {
  if (!process.env.RPC_URL || !process.env.EXPECTED_MARKET) {
    throw new DeploymentError('Set RPC_URL and EXPECTED_MARKET from the current Nillion Contracts page');
  }
  return withPaginatedEvents(createPublicClient({ chain: sepolia,
    transport: http(process.env.RPC_URL, { timeout: 10000, retryCount: 2, retryDelay: 1000 }),
  }), { blockSpan: BigInt(process.env.RPC_LOG_BLOCK_RANGE ?? '10') });
}

export function revertedName(error) {
  return error instanceof BaseError
    ? error.walk(cause => cause instanceof ContractFunctionRevertedError)?.data?.errorName : undefined;
}

// Do not render RPC exceptions: they can include credential-bearing URLs or signed calldata.
const committeeFailures = [
  /^only \d+ eligible nodes; need m=\d+$/,
  /^need \d+ distinct operators for m=\d+ k=\d+, found \d+$/,
  /^the operator cap of \d+ admits at most \d+ of \d+ eligible nodes; need m=\d+$/,
  /^operator cap \d+ left only \d+ of m=\d+ selectable$/,
];
export function publicFailure(error) {
  const codes = [];
  for (let cause = error; cause; cause = cause.cause) {
    if (typeof cause.code === 'number' || /^[A-Z_]+$/.test(cause.code ?? '')) codes.push(cause.code);
  }
  return { detail: error instanceof DeploymentError ? error.message
    : committeeFailures.some(pattern => pattern.test(error.message ?? '') && !/[\r\n]/.test(error.message)) ? error.message
    : revertedName(error) ?? 'RPC or SDK call failed; endpoint and calldata details withheld', codes };
}

export function receiptEvidence(receipt) {
  return { hash: receipt.transactionHash, block: receipt.blockNumber, sender: receipt.from,
    status: receipt.status, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice,
    gasCostWei: receipt.gasUsed * receipt.effectiveGasPrice };
}
