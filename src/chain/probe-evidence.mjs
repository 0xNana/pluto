import { keccak256, toHex } from 'viem';
import { DeploymentError } from './deployment.mjs';

export function verifySpikeReveal(evidence, payload, accepted) {
  if (!(payload instanceof Uint8Array) || payload.length !== 64 || !accepted?.args) {
    throw new DeploymentError('Reveal must contain the 64-byte payload and an acceptance event');
  }
  const key = toHex(payload.slice(0, 32));
  const reportId = toHex(payload.slice(32));
  if (keccak256(payload.slice(0, 32)) !== evidence.keyCommit?.toLowerCase()
      || reportId !== evidence.reportId?.toLowerCase()
      || accepted.args.reportId?.toLowerCase() !== reportId || accepted.args.key?.toLowerCase() !== key) {
    throw new DeploymentError('Revealed key/report or hook event differs from the M0 commitments');
  }
  return true;
}

export function classifyObservation({ nowUnix, expiry, resolved = false, verifiedReveal = false,
  escrowWei, settlementConfirmed = false }) {
  // A confirmed expiry call distinguishes terminal expiry from a missing reveal scan.
  if (!verifiedReveal && nowUnix > expiry && settlementConfirmed && escrowWei === 0n) return 'expired-settled';
  if (resolved !== verifiedReveal) throw new DeploymentError('Resolved state and verified reveal logs disagree; cannot trust this scan');
  if (resolved) return 'revealed-accepted';
  if (nowUnix <= expiry) return 'pending';
  return 'expired-unsettled';
}
