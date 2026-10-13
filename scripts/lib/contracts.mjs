import { readFile, readdir } from 'node:fs/promises';
import solc from 'solc';
import { triggerMarketAbi } from '@nillion/covenants-sdk';

export async function compileContracts(extraSources = {}) {
  const sources = { ...extraSources };
  const directory = new URL('../../contracts/', import.meta.url);
  for (const name of await readdir(directory)) {
    if (name.endsWith('.sol')) sources[name] = { content: await readFile(new URL(name, directory), 'utf8') };
  }
  // Derive the market interface from the installed ABI; do not transcribe signatures.
  const methods = ['postingParties', 'hookMeta', 'triggerMeta'];
  const functions = methods.map(name => {
    const item = triggerMarketAbi.find(entry => entry.type === 'function' && entry.name === name);
    const fields = values => values.map(value => `${value.type} ${value.name}`).join(', ');
    return `function ${name}(${fields(item.inputs)}) external view returns (${fields(item.outputs)});`;
  });
  sources['CovenantsMarket.sol'] = { content: `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.30;\ninterface ICovenantsMarket { ${functions.join('\n')} }` };
  const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources,
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object',
        'evm.deployedBytecode.immutableReferences'] } } } })));
  const errors = output.errors?.filter(error => error.severity === 'error') ?? [];
  if (errors.length) throw new Error(errors.map(error => error.formattedMessage).join('\n'));
  return Object.fromEntries(Object.values(output.contracts).flatMap(contracts =>
    Object.entries(contracts).filter(([, contract]) => contract.evm.bytecode.object).map(([name, contract]) =>
      [name, { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}`,
        runtimeBytecode: `0x${contract.evm.deployedBytecode.object}`,
        immutableReferences: contract.evm.deployedBytecode.immutableReferences, compiler: solc.version() }])));
}
