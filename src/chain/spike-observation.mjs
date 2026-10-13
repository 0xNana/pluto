import { decodeFunctionData, decodeFunctionResult, getAddress, keccak256 } from 'viem';
import { DeploymentError } from './deployment.mjs';

export function measureHookTrace(trace, { market, hook, abi, triggerId, commit, gasLimit }) {
  const pending = [trace];
  const matches = [];
  let visited = 0;
  while (pending.length) {
    const frame = pending.pop();
    if (++visited > 10000 || !frame || typeof frame !== 'object') throw new DeploymentError('Invalid or oversized hook trace');
    pending.push(...(frame.calls ?? []));
    if (frame.type !== 'CALL' || frame.to?.toLowerCase() !== hook.toLowerCase()
        || frame.from?.toLowerCase() !== market.toLowerCase()) continue;
    const decoded = decodeFunctionData({ abi, data: frame.input });
    if (decoded.functionName !== 'onReveal' || decoded.args[0] !== triggerId || keccak256(decoded.args[1]) !== commit) continue;
    if (frame.error || !/^0x[0-9a-f]+$/i.test(frame.gasUsed ?? '') || !/^0x[0-9a-f]+$/i.test(frame.gas ?? '')) {
      throw new DeploymentError('Hook trace contains a failed callback or invalid gas');
    }
    const used = BigInt(frame.gasUsed);
    const forwarded = BigInt(frame.gas);
    const ack = decodeFunctionResult({ abi, functionName: 'onReveal', data: frame.output });
    if (ack !== '0xd8e071b6' || used > forwarded) {
      throw new DeploymentError('Hook trace has an invalid ACK or gas measurement');
    }
    // retryHook is uncapped by protocol design. Measure it honestly without
    // treating its larger forwarding allowance as an invalid trace.
    matches.push({ status: 'measured', gasUsed: used, gasForwarded: forwarded, gasLimit, ack,
      withinDeclaredBudget: used <= gasLimit, forwardingCapped: forwarded <= gasLimit });
  }
  if (matches.length !== 1) throw new DeploymentError('Hook trace must contain exactly one matching callback');
  return matches[0];
}

export function reconcileRefunds({ deposited, remaining, owed, events }) {
  const total = name => events.filter(event => event.eventName === name).reduce((sum, event) => {
    const amount = BigInt(event.args.amount);
    if (amount < 0n) throw new DeploymentError('Negative refund event amount');
    return sum + amount;
  }, 0n);
  const issued = total('RefundIssued');
  const accrued = total('RefundOwed');
  const claimed = total('RefundClaimed');
  const allocated = issued + accrued;
  if (deposited < 0n || remaining < 0n || owed < 0n || claimed > accrued
      || accrued - claimed !== owed || allocated + remaining > deposited) {
    throw new DeploymentError('Escrow and refund events do not reconcile');
  }
  return { depositedWei: deposited, remainingWei: remaining, allocatedWei: allocated,
    paidWei: issued + claimed, owedWei: owed, spentWei: deposited - allocated - remaining };
}

// This is the synthetic FR-211 feasibility decision, not the product/G1 gate.
export function sponsorshipDecision(evidence, observation) {
  if (evidence.mode !== 'sponsored') return undefined;
  const pending = reason => ({ requirement: 'FR-211', decision: 'pending', reason });
  const before = evidence.researcherFundsBefore;
  const after = evidence.researcherFundsAfter;
  if (!before || !after) return pending('Zero-prepayment post/register/bind evidence is missing');
  if (BigInt(before.ethWei) !== 0n || BigInt(after.ethWei) !== 0n || BigInt(before.nilWei) !== 0n
      || BigInt(after.nilWei) !== 0n || before.nonce !== after.nonce) {
    return { requirement: 'FR-211', decision: 'no-go', reason: 'Zero-prepayment researcher condition failed' };
  }
  if (!evidence.sponsorshipVerified || !evidence.transactions?.length
      || evidence.transactions.some(tx => tx.status !== 'success' || !tx.sender
        || getAddress(tx.sender) !== getAddress(evidence.payer))) return pending('Payer receipts and authorization proof are incomplete');
  if (evidence.payerNilBefore === undefined || evidence.payerNilAfter === undefined || evidence.feeNil === undefined
      || BigInt(evidence.payerNilBefore) - BigInt(evidence.payerNilAfter) !== BigInt(evidence.feeNil)) {
    return pending('Actual payer NIL debit does not yet reconcile with the post fee');
  }
  if (!observation || !['revealed-accepted', 'expired-settled'].includes(observation.state)
      || !observation.refundReconciliation || observation.refundReconciliation.paidWei <= 0n
      || observation.refundReconciliation.owedWei !== 0n
      || getAddress(observation.refundRecipient) !== getAddress(evidence.payer)) {
    return pending('A terminal trigger and paid refund to the designated payer are still required');
  }
  return { requirement: 'FR-211', decision: 'go', reason: 'Synthetic registration, post, binding, payer fees and refund verified with zero researcher prepayment' };
}
