import { hexToBytes, keccak256, toHex } from 'viem';
import { decryptReport, validateRecoveryBundle } from '../shared/report-crypto.mjs';
import { validateResearcherJournal } from '../shared/researcher-journal.mjs';
import { encodeDisclosurePayload, retryReportIdFor } from '../shared/disclosure.mjs';
import { DeploymentError } from './deployment.mjs';

// From drand/tlock-js src/drand/defaults.ts. Pin identity, not just a relay URL.
export const quicknet = Object.freeze({
  hash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  public_key: '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  period: 3, genesis_time: 1692803367, schemeID: 'bls-unchained-g1-rfc9380',
});
const requireThat = (condition, message) => { if (!condition) throw new DeploymentError(message); };
const bytes32 = value => /^0x[0-9a-fA-F]{64}$/.test(value ?? '');
const seconds = milliseconds => Math.floor(milliseconds / 1000);
const defaults = { now: Date.now, monotonic: () => performance.now() };

function releaseRound(t1) {
  requireThat(Number.isSafeInteger(t1 * 1000) && t1 >= quicknet.genesis_time,
    'Comparison release time is outside the supported range');
  // drand roundAt floors to the most recent round. Round UP to prevent early release.
  return Math.ceil((t1 - quicknet.genesis_time) / quicknet.period) + 1;
}
const roundTime = round => quicknet.genesis_time + (round - 1) * quicknet.period;

// Inspect framing only; the official library still verifies AGE's MAC and decrypts.
// 0.9.0's decryptor reads a round from the stanza without checking its chain hash.
function checkCapsuleRecipient(evidence) {
  const armored = /^-----BEGIN AGE ENCRYPTED FILE-----\n([A-Za-z0-9+/=\n]+)-----END AGE ENCRYPTED FILE-----\n?$/.exec(evidence.capsule);
  requireThat(armored, 'Invalid tlock capsule recipient framing');
  const base64 = armored[1].replaceAll('\n', '');
  const decoded = Buffer.from(base64, 'base64');
  requireThat(decoded.toString('base64') === base64, 'Invalid tlock capsule recipient encoding');
  const contents = decoded.toString('latin1');
  const headerEnd = contents.indexOf('\n--- ');
  const header = contents.slice(0, headerEnd);
  const recipient = /^age-encryption.org\/v1\n-> tlock ([0-9]+) ([a-f0-9]{64})\n/.exec(header);
  requireThat(headerEnd > 0 && recipient && recipient[1] === String(evidence.round)
    && recipient[2] === evidence.chainHash && (header.match(/^-> /gm) ?? []).length === 1,
  'Capsule recipient differs from the comparison round or chain');
}

async function clientFor(sdk) {
  const client = sdk.mainnetClient();
  requireThat(client.options.disableBeaconVerification === false, 'Beacon verification must be enabled');
  const info = await client.chain().info();
  requireThat(Object.entries(quicknet).every(([field, value]) => info[field] === value),
    'drand relay does not match pinned quicknet identity');
  return client;
}

export async function prepareTlockComparison({ bundle: recovery, journal }, services) {
  const { sdk, now, monotonic } = { ...defaults, ...services };
  const bundle = await validateRecoveryBundle(recovery);
  validateResearcherJournal(journal);
  const t1 = Number(journal.window.t1);
  const round = releaseRound(t1);
  requireThat(t1 > seconds(now()), 'Comparison needs a future release time');
  const reportId = journal.parentReportId === undefined ? bundle.reportId
    : retryReportIdFor(journal.parentReportId, BigInt(journal.window.t1), BigInt(journal.window.t2));
  requireThat(journal.state === 'bound' && journal.triggerId !== undefined
    && journal.researcher.toLowerCase() === bundle.researcher.toLowerCase()
    && journal.reportId === reportId && (journal.rootReportId === undefined || journal.rootReportId === bundle.reportId)
    && ['cipherHash', 'keyCommit'].every(field => journal[field] === bundle[field]),
  'Comparison journal does not match the bound recovery report');
  const client = await clientFor(sdk);
  const started = monotonic();
  const capsule = await sdk.timelockEncrypt(round,
    Buffer.from(encodeDisclosurePayload(hexToBytes(bundle.key), reportId)), client);
  requireThat(t1 > seconds(now()), 'Release time elapsed while preparing the comparison');
  const evidence = { version: 1, implementation: 'tlock-js@0.9.0', status: 'sealed', g1Decision: 'pending',
    chainHash: quicknet.hash, reportId, researcher: bundle.researcher, cipherHash: bundle.cipherHash,
    keyCommit: bundle.keyCommit, registry: journal.registry, market: journal.market,
    triggerId: String(journal.triggerId), window: { t1: String(journal.window.t1), t2: String(journal.window.t2) },
    round, roundTimeUnix: roundTime(round), preparedAtUnix: seconds(now()),
    encryptDurationMs: monotonic() - started, capsule, capsuleHash: keccak256(toHex(Buffer.from(capsule))),
    cost: { transactionWei: '0', feeNil: '0', hosting: 'unmeasured' } };
  validateComparison(evidence);
  return evidence;
}

export function validateComparison(evidence) {
  const fields = ['version', 'implementation', 'status', 'g1Decision', 'chainHash', 'reportId', 'researcher',
    'cipherHash', 'keyCommit', 'registry', 'market', 'triggerId', 'window', 'round', 'roundTimeUnix',
    'preparedAtUnix', 'encryptDurationMs', 'capsule', 'capsuleHash', 'cost', 'observation'];
  requireThat(evidence && typeof evidence === 'object' && Object.keys(evidence).every(field => fields.includes(field))
    && evidence.version === 1 && evidence.implementation === 'tlock-js@0.9.0'
    && evidence.g1Decision === 'pending' && ['sealed', 'pending', 'decrypted'].includes(evidence.status)
    && evidence.chainHash === quicknet.hash
    && ['reportId', 'cipherHash', 'keyCommit', 'capsuleHash'].every(field => bytes32(evidence[field]))
    && ['researcher', 'registry', 'market'].every(field => /^0x[0-9a-fA-F]{40}$/.test(evidence[field] ?? ''))
    && /^[0-9]{1,78}$/.test(evidence.triggerId ?? '') && BigInt(evidence.triggerId) < (1n << 256n)
    && evidence.window && Object.keys(evidence.window).sort().join(',') === 't1,t2'
    && ['t1', 't2'].every(field => /^[0-9]{1,20}$/.test(evidence.window[field] ?? ''))
    && BigInt(evidence.window.t2) > BigInt(evidence.window.t1) && BigInt(evidence.window.t2) < (1n << 64n)
    && evidence.round === releaseRound(Number(evidence.window.t1))
    && evidence.roundTimeUnix === roundTime(evidence.round)
    && Number.isSafeInteger(evidence.preparedAtUnix) && evidence.preparedAtUnix < Number(evidence.window.t1)
    && Number.isFinite(evidence.encryptDurationMs) && evidence.encryptDurationMs >= 0
    && typeof evidence.capsule === 'string' && evidence.capsule.length > 0 && evidence.capsule.length <= 4096
    && keccak256(toHex(Buffer.from(evidence.capsule))) === evidence.capsuleHash
    && JSON.stringify(evidence.cost) === JSON.stringify({ transactionWei: '0', feeNil: '0', hosting: 'unmeasured' }),
  'Invalid tlock comparison evidence');
  checkCapsuleRecipient(evidence);
  // Do not accept arbitrary nested metadata that could be copied into public output.
  if (evidence.observation !== undefined) {
    const observation = evidence.observation;
    requireThat(observation && Object.keys(observation).sort().join(',')
      === 'decryptDurationMs,latencyKind,observedAtUnix,plaintextBytes,releaseDeltaSecs'
      && observation.latencyKind === 'upper-bound-at-observation'
      && ['observedAtUnix', 'plaintextBytes', 'releaseDeltaSecs'].every(field => Number.isSafeInteger(observation[field]) && observation[field] >= 0)
      && Number.isFinite(observation.decryptDurationMs) && observation.decryptDurationMs >= 0,
    'Invalid tlock observation');
  }
  return evidence;
}

export async function observeTlockComparison({ evidence, ciphertext }, services) {
  validateComparison(evidence);
  const { sdk, now, monotonic } = { ...defaults, ...services };
  requireThat(ciphertext instanceof Uint8Array && keccak256(ciphertext) === evidence.cipherHash,
    'Ciphertext does not match the comparison report');
  if (seconds(now()) < evidence.roundTimeUnix) {
    const pending = { ...evidence, status: 'pending' };
    delete pending.observation;
    return { evidence: pending };
  }
  const client = await clientFor(sdk);
  const started = monotonic();
  const payload = await sdk.timelockDecrypt(evidence.capsule, client);
  requireThat(payload instanceof Uint8Array && payload.length === 64, 'Invalid decrypted tlock payload');
  requireThat(toHex(payload.slice(32)) === evidence.reportId
    && keccak256(payload.slice(0, 32)) === evidence.keyCommit, 'Decrypted payload differs from report ID or key commitment');
  const plaintext = await decryptReport(ciphertext, payload.slice(0, 32));
  const observedAtUnix = seconds(now());
  return { plaintext, evidence: { ...evidence, status: 'decrypted', observation: {
    observedAtUnix, releaseDeltaSecs: observedAtUnix - Number(evidence.window.t1),
    latencyKind: 'upper-bound-at-observation', decryptDurationMs: monotonic() - started,
    plaintextBytes: plaintext.length,
  } } };
}
