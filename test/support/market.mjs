import { triggerMarketAbi } from '@nillion/covenants-sdk';

export function marketMockSource() {
  const values = { author: 't.author', payer: 't.payer', hook: 't.hook', hookGas: '250000', hookOk: 'false',
    retryWindow: '604800', retryDeadline: '0', bountyOff: 'false', mode: '1', k: '2', m: '3',
    expiry: 't.t2', t1: 't.t1', t2: 't.t2', commit: 'bytes32(0)', ceiling: '90', resolved: 't.resolved',
    firstShareAt: '0', escrow: '0', refundOwed: '0' };
  const functions = ['postingParties', 'hookMeta', 'triggerMeta'].map(name => {
    const item = triggerMarketAbi.find(entry => entry.type === 'function' && entry.name === name);
    const fields = list => list.map(value => `${value.type} ${value.name}`).join(', ');
    return `function ${name}(${fields(item.inputs)}) external view returns (${fields(item.outputs)}) {
      require(!failViews, "read failure"); Trigger memory t = triggers[triggerId];
      return (${item.outputs.map(output => values[output.name]).join(', ')}); }`;
  }).join('\n');
  return { content: `// SPDX-License-Identifier: MIT
    pragma solidity ^0.8.30;
    contract MockMarket {
      struct Trigger { address author; address payer; address hook; uint64 t1; uint64 t2; bool resolved; }
      mapping(uint256 => Trigger) public triggers;
      bool public failViews;
      function setFailViews(bool value) external { failViews = value; }
      function setTrigger(uint256 id, address author, address payer, address hook, uint64 t1, uint64 t2, bool resolved) external {
        triggers[id] = Trigger(author, payer, hook, t1, t2, resolved);
      }
      ${functions}
    }` };
}
