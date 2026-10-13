// Isolated acceptance fixture, never included in production assets. All signing
// material is freshly generated here; no chain or external service is contacted.
import { initBrowserCrypto, createAuthorKey, selectCommittee } from '@nillion/covenants-sdk/browser';
import { privateKeyToAccount } from 'viem/accounts';
import { toHex, hexToBytes, keccak256, type Hex } from 'viem';
import { prepareReport } from '../../src/shared/report-crypto.mjs';
import { sealLocalReport } from '../../packages/client/sealing.mts';
import { BrowserRecoveryStore, newBrowserRecovery, validateBrowserRecovery, exportBrowserRecovery, importBrowserRecovery, savedSealArgs, type BrowserRecovery } from '../../packages/client/recovery.mts';
import { sponsorReleaseMessage, sponsorRequestId } from '../../packages/client/sponsor-wire.mts';
import { uploadSavedSponsorship } from '../../packages/client/sponsorship.mts';
import { encodeWire } from '../../packages/client/wire.mts';

const store = new BrowserRecoveryStore();
let local: BrowserRecovery;
const ensure = (ok: boolean) => { if (!ok) throw new Error('Acceptance assertion failed'); };
export async function seed() {
  const author = createAuthorKey(), account = privateKeyToAccount(author.privateKey);
  const report = await prepareReport(new TextEncoder().encode('synthetic browser acceptance report'), account.address);
  const crypto = await initBrowserCrypto(new URL('/cryptomata_core_bg.wasm', location.origin));
  const candidates = [1, 2, 3].map(n => ({ keyId: BigInt(n), nodeId: BigInt(n), mpk: toHex(crypto.mpkFromSecret(new Uint8Array(32).fill(n))),
    expiresAt: 10000n, stake: 10n, fired: 0n, markup: 0, operator: toHex(BigInt(n), { size: 20 }) }));
  const registry = toHex(34n, { size: 20 }), market = toHex(56n, { size: 20 });
  const sealed = await sealLocalReport(crypto, report, ['https://a.example/report', 'https://b.example/report'], {
    committee: selectCommittee(candidates, { m: 3, k: 2, mode: 'PUBLIC_CONDITION', minStake: 1n, nowUnix: 1000n }),
    registry, t1: 1600n, t2: 5200n, ceilingWei: 5n, hookGasLimit: 250000, retryWindowSecs: 600, maxPlaintextBytes: 96n, maxCiphertextBytes: 690n,
  });
  const shares = sealed.args.layers.slice(0, 2).map((layer, i) => crypto.openLayer(layer, new Uint8Array(32).fill(Number(sealed.args.keys[i].nodeId)), hexToBytes(sealed.args.commit), 'PUBLIC_CONDITION').share);
  ensure(toHex(crypto.reconstruct(shares)) === report.key + report.reportId.slice(2) + sealed.recovery.nonce.slice(2));
  local = await validateBrowserRecovery({ ...await newBrowserRecovery(report, author.privateKey), sealing: {
    registry, market, cipherUris: sealed.recovery.cipherUris, nonce: sealed.recovery.nonce, args: encodeWire(sealed.args),
  } });
  await store.save(local);
  ensure(exportBrowserRecovery(await importBrowserRecovery(exportBrowserRecovery(local))) === exportBrowserRecovery(local));
  return report.reportId; // Public identity only; never return the private record.
}
export async function load(id: Hex) {
  const restored = await store.load(id); ensure(!!restored); local = restored!;
  return { sealed: !!local.sealing, events: local.history.length, funding: !!local.funding };
}
export async function claimRegister() {
  try { local = await store.append(local, 'register'); return 'claimed'; }
  catch (error) {
    if (!(error instanceof Error) || error.message !== 'Local recovery transaction failed') throw error;
    // An arbitrary rejection cannot count as the expected loser: independently
    // prove the stored competing claim and that this tab still reads/writes it.
    const current = await store.load(local.report.reportId);
    ensure(!!current && local.history.length === 0 && current.authorKey === local.authorKey
      && current.history.length === 1 && current.history[0].action === 'register' && current.history[0].state === 'unknown');
    await store.save(current!); return 'stale';
  }
}
export async function fundingFailureAndRetry() {
  const id = await seed(), account = privateKeyToAccount(local.authorKey);
  const args = savedSealArgs(local);
  const signature = toHex(new Uint8Array(65).fill(1)), payer = toHex(78n, { size: 20 });
  const grant = { researcher: account.address, payer, nonce: 1n, deadline: 1500n, signature };
  // Chain grants are shape fixtures; the local release signature is real. This
  // test covers durable custody/upload recovery, not registry authorization.
  const input = { protocolId: 'alpha.example', bundle: { reportId: local.report.reportId, cipherHash: local.report.cipherHash, keyCommit: local.report.keyCommit,
    args: { ...args, keys: args.keys.map(({ keyId, nodeId, mpk }: { keyId: bigint; nodeId: bigint; mpk: Hex }) => ({ keyId, nodeId, mpk })) },
    authorization: { author: account.address, payer, minCeiling: 5n, nonce: 0n, deadline: 1500n, signature }, registration: grant },
    binding: { ...grant, nonce: 2n, triggerId: 7n } };
  const bounds = { requestHash: keccak256(toHex(encodeWire({ bundle: input.bundle, binding: input.binding }))), ethReserveWei: 100n, feeNil: 25n };
  const message = sponsorReleaseMessage(location.origin, input.protocolId, bounds), requestId = sponsorRequestId(message);
  const body = encodeWire({ input, bounds, release: await account.signMessage({ message }) });
  local = await store.claimFunding(local, requestId, 'sponsorRequest', { origin: location.origin, body });
  const transport: typeof fetch = (_url, init) => {
    ensure(init?.body === body); return fetch('/acceptance/upload', init);
  };
  let failed = false;
  try { await uploadSavedSponsorship(location.origin, local, transport); } catch { failed = true; }
  ensure(failed);
  const imported = await importBrowserRecovery(exportBrowserRecovery(local));
  ensure(imported.funding?.body === body);
  const restored = await store.load(id); ensure(restored?.funding?.body === body);
  const result = await uploadSavedSponsorship(location.origin, restored!, transport);
  ensure(result.id === requestId && result.state === 'pending');
  return id;
}
export async function fundingReloadProof(id: Hex) {
  await load(id); ensure(!!local.funding);
  const imported = await importBrowserRecovery(exportBrowserRecovery(local));
  ensure(imported.funding?.body === local.funding!.body);
  const result = await uploadSavedSponsorship(location.origin, local, (_url, init) => {
    ensure(init?.body === local.funding!.body); return fetch('/acceptance/upload', init);
  });
  ensure(result.id === local.funding!.id); return true;
}
