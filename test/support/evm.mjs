import { createEVM } from '@ethereumjs/evm';
import { createCustomCommon, Mainnet, Hardfork } from '@ethereumjs/common';
import { createAddressFromString, Account } from '@ethereumjs/util';
import { createBlock } from '@ethereumjs/block';
import { decodeFunctionResult, encodeDeployData, encodeFunctionData, hexToBytes, toHex } from 'viem';

export async function evmHarness({ chainId = 31337 } = {}) {
  const common = createCustomCommon({ chainId }, Mainnet, { hardfork: Hardfork.Cancun });
  const evm = await createEVM({ common });
  const author = '0x1111111111111111111111111111111111111111';
  const foreign = '0x2222222222222222222222222222222222222222';
  const market = '0x3333333333333333333333333333333333333333';
  for (const address of [author, foreign, market]) {
    await evm.stateManager.putAccount(createAddressFromString(address), new Account(0n, 10n ** 22n));
  }
  let timestamp = 1000n;
  let lastResult;
  async function execute({ caller = author, to, data, gasLimit = 8000000n }) {
    const result = await evm.runCall({ caller: createAddressFromString(caller),
      origin: createAddressFromString(caller), to: to ? createAddressFromString(to) : undefined,
      data: hexToBytes(data), gasLimit,
      block: createBlock({ header: { timestamp, number: 1n, gasLimit: 30000000n } }, { common }) });
    lastResult = result;
    if (result.execResult.exceptionError) throw new Error(`EVM ${result.execResult.exceptionError.error}: ${toHex(result.execResult.returnValue)}`);
    return result;
  }
  return { author, foreign, market, evm,
    setTime: value => { timestamp = value; },
    result: () => lastResult,
    async deploy(artifact, args = [], caller = author) {
      const result = await execute({ caller, data: encodeDeployData({ ...artifact, args }) });
      return { address: result.createdAddress.toString(), abi: artifact.abi };
    },
    async call(contract, functionName, args = [], caller = author, gasLimit) {
      const result = await execute({ caller, to: contract.address, gasLimit,
        data: encodeFunctionData({ abi: contract.abi, functionName, args }) });
      return decodeFunctionResult({ abi: contract.abi, functionName, data: toHex(result.execResult.returnValue) });
    },
  };
}
