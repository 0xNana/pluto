// A journal is public transaction evidence, not a signed notice or a secret recovery bundle.
import { isAddress } from 'viem';

const fields = ['version', 'chainId', 'registry', 'market', 'researcher', 'reportId', 'cipherHash',
  'keyCommit', 'window', 'transactions', 'quote', 'feeNil', 'commit', 'sealNonce', 'state',
  'registrationBlock', 'triggerId', 'postHash', 'postBlock', 'escrowWei', 'parentReportId', 'rootReportId'];
const exactKeys = (object, allowed) => object && typeof object === 'object' && !Array.isArray(object)
  && Object.keys(object).every(name => allowed.includes(name));
const bytes32 = value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const unsigned = value => (typeof value === 'bigint' || typeof value === 'string')
  && /^[0-9]{1,78}$/.test(String(value)) && BigInt(value) < (1n << 256n);

export function validateResearcherJournal(state) {
  const valid = exactKeys(state, fields) && state.version === 1 && state.chainId === 11155111
    && ['registry', 'market', 'researcher'].every(name => isAddress(state[name] ?? ''))
    && ['reportId', 'cipherHash', 'keyCommit', 'commit', 'sealNonce'].every(name => bytes32(state[name]))
    && ['prepared', 'registered', 'submitted', 'posted', 'bound'].includes(state.state)
    && exactKeys(state.window, ['t1', 't2']) && unsigned(state.window.t1) && unsigned(state.window.t2)
    && BigInt(state.window.t1) < BigInt(state.window.t2) && BigInt(state.window.t2) < (1n << 64n)
    && Array.isArray(state.transactions) && state.transactions.length <= 100
    && state.transactions.every(tx => exactKeys(tx, ['call', 'hash', 'block', 'gasUsed', 'gasCostWei', 'status'])
      && ['register', 'registerRetry', 'approve', 'postTrigger', 'bindTrigger'].includes(tx.call) && bytes32(tx.hash)
      && (tx.status === undefined || tx.status === 'reverted')
      && ['block', 'gasUsed', 'gasCostWei'].every(name => tx[name] === undefined || unsigned(tx[name])))
    && ['registrationBlock', 'triggerId', 'postBlock', 'feeNil', 'escrowWei'].every(name =>
      state[name] === undefined || unsigned(state[name]))
    && (state.postHash === undefined || bytes32(state.postHash))
    && ((state.parentReportId === undefined && state.rootReportId === undefined)
      || (bytes32(state.parentReportId) && bytes32(state.rootReportId)))
    && (state.quote === undefined || (exactKeys(state.quote,
      ['escrowWei', 'hookLineWei', 'bountyDiscountWei', 'drivingMarkupsBps'])
      && ['escrowWei', 'hookLineWei', 'bountyDiscountWei'].every(name => unsigned(state.quote[name]))
      && Array.isArray(state.quote.drivingMarkupsBps) && state.quote.drivingMarkupsBps.length <= 255
      && state.quote.drivingMarkupsBps.every(value => Number.isSafeInteger(value) && value >= 0)));
  if (!valid) throw new TypeError('Invalid researcher journal schema');
  return state;
}
