import { keccak256, parseEventLogs } from 'viem';
import { triggerMarketAbi } from '@nillion/covenants-sdk';
import { DeploymentError } from '../../src/chain/deployment.mjs';

export function verifyRejectionReceipt(receipt, expected, abi) {
  if (receipt.status !== 'success' || !Array.isArray(receipt.logs) || receipt.logs.some(log => log.removed)) {
    throw new DeploymentError('Rejection proof requires a successful receipt without removed logs');
  }
  const at = address => receipt.logs.filter(log => log.address.toLowerCase() === address.toLowerCase());
  const watched = events => events.filter(event => event.args.triggerId === BigInt(expected.triggerId));
  const marketEvents = watched(parseEventLogs({ abi: triggerMarketAbi, logs: at(expected.market), strict: true }));
  const hookEvents = watched(parseEventLogs({ abi, logs: at(expected.hook), strict: true }));
  const reveals = marketEvents.filter(event => event.eventName === 'TriggerResolved');
  const invocations = marketEvents.filter(event => event.eventName === 'HookInvoked');
  const rejections = hookEvents.filter(event => event.eventName === 'Rejected');
  if (reveals.length !== 1 || invocations.length !== 1 || !invocations[0].args.ok
      || rejections.length !== 1 || rejections[0].args.reason !== expected.expectedReason
      || hookEvents.some(event => event.eventName === 'Disclosed')
      || keccak256(reveals[0].args.plaintext) !== expected.commit) {
    throw new DeploymentError('Receipt does not prove the expected committed reveal, rejection and ACK');
  }
  return { reason: rejections[0].args.reason, plaintext: reveals[0].args.plaintext,
    commit: expected.commit, hookAcknowledged: true, unauthorizedDisclosure: false };
}
