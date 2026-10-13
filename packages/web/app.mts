import { createPublicClient, createWalletClient, http, hexToBytes, toHex, type Abi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createAuthorKey, initBrowserCrypto, type AuthorKey } from '@nillion/covenants-sdk/browser';
import { prepareReport, decryptReport, maxReportBytes } from '../../src/shared/report-crypto.mjs';
import { publishCiphertext } from '../client/storage.mts';
import { sealLocalReport } from '../client/sealing.mts';
import { signNotice, hex, object, type SignedNotice } from '../client/notice.mts';
import { verifiedContacts, prepareNoticeDelivery, sendNoticeDelivery } from '../client/delivery.mts';
import type { ContactKey } from '../client/attachment.mts';
import { checkDeployment, checkReadDeployment, type RegistryArtifact } from '../client/deployment.mts';
import { decodeWire, encodeWire } from '../client/wire.mts';
import { BrowserRecoveryStore, newBrowserRecovery, validateBrowserRecovery, importBrowserRecovery, exportBrowserRecovery,
  savedSealArgs, maxRecoveryFileBytes, type BrowserRecovery, type RecoveryAction } from '../client/recovery.mts';
import { inspectBrowserRecovery, priceRecoveredBinding, resumeBrowserBinding } from '../client/binding-recovery.mts';
import { canStartPosting, fundingRequestId } from '../client/recovery.mts';
import { prepareSponsorship, priceSponsorship, releaseSponsorship, sponsorApi as requestSponsorship, sponsorshipProof, uploadSavedSponsorship } from '../client/sponsorship.mts';
import type { SponsorInput, SponsorBounds } from '../client/sponsor-wire.mts';
import { assertPostConsent, SelfFundingError, submitSelfFunded, type PostPackage } from '../client/posting.mts';
import { quoteTransactionCosts } from '../planner/costs.mts';
import { inspectReport, verifyPublicReport } from '../verifier/verify.mts';
import { readInboxRows } from './inbox-reads.mts';
import { scopedFetch } from './lifecycle.mts';
import { priceSavedSelfFunded } from '../client/continuation.mts';
import { inspectFundedBinding, priceFundedBinding } from '../client/funded-binding.mts';
import { facts as renderFacts, status as renderStatus, navigation, recoverableError, renderFundingSummary as fundingSummary, fundingState, eth, utc, windowTiming } from './view.mts';
import { parseSponsorInput } from '../client/sponsor-wire.mts';
import type { createPlan } from '../planner/planner.mts';
import { WalletAccess, WalletAccessError } from './wallet-access.mts';
import { discoverWallets, type DiscoveredWallet } from './wallet-discovery.mts';
import type { WalletConnector } from './appkit-connection.mts';
import { researcherJourney } from './researcher-journey.mts';
export { connectAppKit, manageAppKitAccount } from './appkit-connection.mts';
export { appKitSettings } from './appkit-settings.mts';

type Plan = Awaited<ReturnType<typeof createPlan>>;
interface Runtime { serviceMode?: 'preview' | 'portal' | 'researcher'; chainId: number; publicRpcUrl: string | null; expectedMarket: Hex | null; registry: Hex | null; registryFirstBlock: string | null; writesEnabled: boolean; privateRetentionDays: number; sponsorship: null | { payer: Hex; maxCeilingWei: string } }
// Mounted after React hydration; every mount owns its listeners and private state.
export function mountDisclosureWorkspace(options: { walletConnector?: WalletConnector } = {}): () => void {
const lifecycle = new AbortController();
const fetch = scopedFetch(lifecycle.signal);
const sponsorApi = async (origin: string, path: string, body?: unknown) => {
  if (path.startsWith('/api/protocols/')) assertCustomerIdentity();
  const generation = inboxGeneration;
  const result = await requestSponsorship(origin, path, body, fetch);
  if (path.startsWith('/api/protocols/') && generation !== inboxGeneration) throw new Error('Customer identity changed');
  return result;
};
const disposers: (() => void)[] = [];
const facts: typeof renderFacts = (...args) => { lifecycle.signal.throwIfAborted(); renderFacts(...args); };
const showStatus: typeof renderStatus = (...args) => { lifecycle.signal.throwIfAborted(); renderStatus(...args); };
const renderFundingSummary: typeof fundingSummary = (...args) => { lifecycle.signal.throwIfAborted(); fundingSummary(...args); };
function listen(target: EventTarget, event: string, handler: () => void) {
  const activeHandler = () => { if (!lifecycle.signal.aborted) return handler(); };
  target.addEventListener(event, activeHandler);
  disposers.push(() => target.removeEventListener(event, activeHandler));
}
function element<T extends HTMLElement>(id: string): T {
  lifecycle.signal.throwIfAborted();
  const value = document.getElementById(id); if (!value) throw new Error('Missing interface element'); return value as T;
}
const input = (id: string) => element<HTMLInputElement>(id);
const button = (id: string) => element<HTMLButtonElement>(id);
const text = (id: string, message: string) => { element(id).textContent = message; };
const download = (filename: string, data: string | Uint8Array, type: string) => {
  lifecycle.signal.throwIfAborted();
  const url = URL.createObjectURL(new Blob([typeof data === 'string' ? data : new Uint8Array(data)], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
};
let busy = false;
let releaseControls: (() => void) | undefined;
function action(id: string, status: string, job: () => Promise<void>) {
  listen(button(id), 'click', async () => {
    if (busy) return;
    for (const required of (button(id).dataset.requires ?? '').split(',').filter(Boolean)) {
      const field = input(required);
      if ((!field.value.trim() && !field.files?.length) || !field.checkValidity()) {
        showStatus(status, 'Complete the required fields before continuing.', 'error'); field.focus(); field.reportValidity(); return;
      }
    }
    busy = true;
    const controls = Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')).map(control => ({ control, disabled: control.disabled }));
    controls.forEach(({ control }) => { control.disabled = true; });
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).map(control => ({ control, disabled: control.disabled }));
    buttons.forEach(({ control }) => { control.disabled = true; });
    const statusElement = element(status);
    releaseControls = () => {
      controls.forEach(({ control, disabled }) => { control.disabled = disabled; });
      buttons.forEach(({ control, disabled }) => { control.disabled = disabled; });
      statusElement.removeAttribute('aria-busy'); busy = false;
    };
    statusElement.setAttribute('aria-busy', 'true'); showStatus(status, 'Checking this step…', 'busy');
    try { await job(); element(status).dataset.state = 'success'; }
    catch (error) {
      if (lifecycle.signal.aborted) return;
      if (['plan', 'refresh-costs'].includes(id)) clearPricing();
      if (id === 'quote-funding') customerReview = undefined;
      if (id === 'inspect-recovery') { recoveryCosts = undefined; recoveryReviewed = false; }
      if (id === 'inspect-funded-binding') { fundedCosts = undefined; fundedReviewed = false; }
      showStatus(status, error instanceof WalletAccessError || error instanceof SelfFundingError ? error.message : recoverableError(id), 'error');
      if (['report-status', 'posting-status'].includes(status)) element(status).focus();
    }
    finally {
      if (!lifecycle.signal.aborted) {
        releaseControls?.(); releaseControls = undefined; syncActions();
      }
    }
  });
}
async function api(path: string, data?: unknown, method?: string): Promise<unknown> {
  lifecycle.signal.throwIfAborted();
  if (path.startsWith('/api/protocols/') || path.startsWith('/api/enrollments')) assertCustomerIdentity();
  const generation = inboxGeneration;
  const result = await fetch(path, { method: method ?? (data === undefined ? 'GET' : 'POST'), credentials: 'same-origin', redirect: 'error',
    headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(30_000)]) });
  if (!result.ok) throw new Error('Request failed');
  const value: unknown = await result.json();
  lifecycle.signal.throwIfAborted();
  if ((path.startsWith('/api/protocols/') || path.startsWith('/api/enrollments')) && generation !== inboxGeneration) throw new Error('Customer identity changed');
  return value;
}
let runtime: Runtime, artifact: RegistryArtifact, marketAbi: Abi, nilAbi: Abi;
let walletAccess: WalletAccess | undefined;
let wallets: DiscoveredWallet[] = [];
let customerIdentityInvalidated = false;
function assertCustomerIdentity() {
  if (customerIdentityInvalidated && !walletAccess?.state.authenticated) throw new WalletAccessError('Sign in again before accessing protocol records.');
}
let author: AuthorKey | undefined, report: Awaited<ReturnType<typeof prepareReport>> | undefined;
let plan: Plan | undefined, sealed: Awaited<ReturnType<typeof sealLocalReport>> | undefined;
let cost: Awaited<ReturnType<typeof quoteTransactionCosts>> | undefined, postPackage: PostPackage | undefined;
let reviewed = false, attempted = false, verifiedPlaintext: Uint8Array | undefined, enrollmentId: string | undefined;
let signedNotice: SignedNotice | undefined, contactKeys: ContactKey[] = [];
const localStore = new BrowserRecoveryStore();
let localRecovery: BrowserRecovery | undefined;
let recoveryCosts: Awaited<ReturnType<typeof priceRecoveredBinding>> | undefined, recoveryReviewed = false;
let fundedProof: { postHash: Hex; triggerId: bigint } | undefined;
let fundedCosts: Awaited<ReturnType<typeof priceFundedBinding>> | undefined, fundedReviewed = false;
let sponsorState: string | undefined;
let sponsorPricing: { payer: Hex; escrowWei: bigint; feeNil: bigint } | undefined;
let sponsorInput: SponsorInput | undefined, sponsorBounds: SponsorBounds | undefined;
let journey: ReturnType<typeof researcherJourney>;
const pub = () => {
  if (!runtime.publicRpcUrl || !runtime.expectedMarket || !runtime.registry || runtime.chainId !== 11155111) throw new Error('Configure current Sepolia deployment');
  return createPublicClient({ chain: sepolia, transport: http(runtime.publicRpcUrl, { retryCount: 0, timeout: 20_000, fetchFn: fetch }) });
};
const guard = async () => checkDeployment(pub(), runtime.expectedMarket!, runtime.registry!, artifact);
function clearPricing() {
  cost = undefined; postPackage = undefined; sponsorPricing = undefined; sponsorInput = undefined; sponsorBounds = undefined; reviewed = false;
  input('recovery-saved').checked = false; input('irreversible').checked = false; element('final-review').hidden = true;
  text('costs', 'Refresh costs for the saved seal before reviewing.');
}
function syncActions() {
  if (lifecycle.signal.aborted) return;
  const active = localRecovery ? !!fundingRequestId(localRecovery) : false;
  const ready = !!runtime, writes = ready && runtime.writesEnabled;
  const allowed = !!localRecovery && canStartPosting(localRecovery);
  const protocolFunding = element<HTMLSelectElement>('funding-method').value === 'protocol';
  element('sponsor-fields').hidden = !protocolFunding;
  button('encrypt').disabled = attempted;
  button('plan').disabled = !ready || !report || attempted || (localRecovery?.history.length ?? 0) > 0;
  button('refresh-costs').disabled = !ready || !localRecovery?.sealing || !allowed;
  button('save-recovery').disabled = !localRecovery;
  button('review').disabled = !cost || !sealed || attempted || !input('recovery-saved').checked;
  const confirmed = reviewed && input('recovery-saved').checked && input('irreversible').checked && !!cost && !attempted;
  button('post').disabled = !writes || !confirmed || protocolFunding || !postPackage;
  button('request-sponsorship').disabled = !confirmed || !sponsorInput || !sponsorBounds || !protocolFunding;
  button('sponsorship-status').disabled = !ready || !active;
  button('retry-funding-upload').disabled = !ready || !active || !localRecovery?.funding || ![undefined, 'pending'].includes(sponsorState);
  button('withdraw-sponsorship').disabled = !ready || !active || sponsorState !== 'pending' || !input('withdraw-confirmed').checked;
  button('inspect-funded-binding').disabled = !ready || !fundedProof || sponsorState !== 'awaiting-binding';
  button('review-funded-binding').disabled = !fundedCosts || !input('funded-recovery-saved').checked;
  button('complete-funded-binding').disabled = !writes || !fundedCosts || !fundedReviewed || !input('funded-recovery-saved').checked || !input('funded-binding-confirmed').checked;
  element('funded-binding-confirmation').hidden = !fundedReviewed;
  button('inspect-recovery').disabled = !ready || !localRecovery?.sealing || !attempted || active;
  button('review-recovery').disabled = !recoveryCosts || !input('recovery-resaved').checked;
  button('resume-binding').disabled = !writes || !recoveryReviewed || !recoveryCosts || !input('recovery-resaved').checked || !input('binding-confirmed').checked;
  button('approve-funding').disabled = !writes || !customerReview || !input('funding-approved').checked;
  button('confirm-enrollment').disabled = !enrollmentId;
  for (const id of ['inbox-next', 'funding-next']) button(id).disabled = button(id).dataset.available !== 'true';
  for (const control of Array.from(document.querySelectorAll<HTMLButtonElement>('button[id^="remove-notice-"]'))) control.disabled = !input('delete-notice-confirmed').checked;
  button('disable-account').disabled = !input('disable-account-confirmed').checked;
  const delivery = !!signedNotice && !!contactKeys.find(contact => contact.contactId === contactSelect().value) && input('fingerprint-confirmed').checked && input('delivery-approved').checked;
  button('export-delivery').disabled = !delivery; button('send-delivery').disabled = !delivery;
  for (const id of ['release-time', 'window-hours', 'upload-a', 'read-a', 'upload-b', 'read-b']) input(id).disabled = (localRecovery?.history.length ?? 0) > 0;
  element<HTMLSelectElement>('funding-method').disabled = attempted;
  input('sponsor-domain').disabled = attempted;
  for (const [id, complete] of [['step-encrypted', !!report], ['step-sealed', !!localRecovery?.sealing], ['step-reviewed', reviewed]] as const) element(id).dataset.complete = String(complete);
  journey?.update({ encrypted: !!report, sealed: !!localRecovery?.sealing, priced: !!cost && !!sealed,
    attempted, notice: !!signedNotice, reportId: report?.reportId });
  syncWalletControls();
}
function syncWalletControls() {
  if (!walletAccess || lifecycle.signal.aborted) return;
  const state = walletAccess.state, locked = busy || state.busy;
  const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
  button('connect-wallet').disabled = locked || (!options.walletConnector && !wallets.length);
  button('connect-wallet').textContent = state.wallet ? short(state.wallet) : 'Connect wallet';
  button('connect-wallet').setAttribute('aria-label', state.wallet ? `${state.chainId === 11155111 ? 'Manage wallet' : 'Switch wallet to Sepolia'} ${state.wallet}` : 'Connect wallet');
  button('login').disabled = locked || !walletAccess.canAuthenticate() || (!options.walletConnector && !wallets.length) || state.authenticated || (!!state.wallet && state.chainId !== 11155111);
  button('logout').disabled = locked || !state.authenticated;
}
function showCosts() {
  if (!cost || !plan || !sealed || (!postPackage && !sponsorPricing)) throw new Error('Costs unavailable');
  facts('costs', [['Payer', sponsorPricing?.payer ?? postPackage!.author],
    ['Researcher prepayment', sponsorInput ? '0 ETH / 0 NIL' : 'Self-funded from the local author account'],
    ['NIL token', plan.addresses.nil], ['Escrow', `${eth(sponsorPricing?.escrowWei ?? postPackage!.escrowWei)} · refundable less actual costs`], ['Protocol fee', `${sponsorPricing?.feeNil ?? postPackage!.feeNil} raw NIL units · nonrefundable`],
    ...(sponsorBounds ? [['Maximum ETH reservation', eth(sponsorBounds.ethReserveWei)] as [string, string]] : []),
    ...(postPackage?.spend && !sponsorInput ? [['Self-funded gas cap including one post retry', eth(postPackage.spend.maximumGasWei)], ['ETH required with escrow', eth(postPackage.escrowWei + postPackage.spend.maximumGasWei)]] as [string, string][] : []),
    ...cost.items.map(item => [`${item.action} gas estimate`, `${eth(item.gasWei)} · payer ${item.payer}`] as [string, string]),
    ['Opens', utc(plan.t1)], ['Expires', utc(plan.t2)], ['Basefee ceiling', `${sealed.args.ceilingWei} wei`], ['Estimate', cost.note]]);
}
async function refreshSavedCosts() {
  if (!localRecovery?.sealing || !canStartPosting(localRecovery)) throw new Error('Saved seal cannot start a new submission');
  clearPricing(); const args = savedSealArgs(localRecovery);
  input('release-time').value = new Date(Number(args.t1!) * 1000).toISOString().slice(0, 16); input('window-hours').value = String(Number(args.t2! - args.t1!) / 3600);
  const response = await fetch('/api/plan', { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ t1: String(args.t1), t2: String(args.t2) }), signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(60_000)]) });
  if (!response.ok) throw new Error('Fresh plan unavailable'); plan = decodeWire(await response.text()) as Plan;
  sealed = { args, recovery: { version: 1, report: localRecovery.report, cipherUris: localRecovery.sealing.cipherUris, nonce: localRecovery.sealing.nonce, commit: args.commit } };
  if (element<HTMLSelectElement>('funding-method').value === 'protocol') {
    if (!runtime.sponsorship) throw new Error('Sponsorship not configured');
    const previous = localRecovery.funding ? parseSponsorInput(object(decodeWire(localRecovery.funding.body)).input) : undefined;
    sponsorInput = await prepareSponsorship(pub(), localRecovery, input('sponsor-domain').value.trim().toLowerCase(), runtime.sponsorship.payer,
      { expectedMarket: runtime.expectedMarket!, artifact, marketAbi, nonceFloor: previous ? previous.bundle.authorization.nonce + 1n : undefined });
    if (args.ceilingWei > BigInt(runtime.sponsorship.maxCeilingWei)) throw new Error('Spending ceiling exceeded');
    const quote = await priceSponsorship(pub(), sponsorInput, { registry: artifact.abi, market: marketAbi, nil: nilAbi });
    sponsorBounds = { requestHash: quote.requestHash, ethReserveWei: quote.ethReserveWei, feeNil: quote.feeNil }; cost = quote.costs;
    sponsorPricing = { payer: quote.payer, escrowWei: quote.escrowWei, feeNil: quote.feeNil };
  } else {
    const priced = await priceSavedSelfFunded(pub(), localRecovery, plan, { expectedMarket: runtime.expectedMarket!, artifact, marketAbi, nilAbi });
    postPackage = priced.postPackage; cost = priced.costs;
  }
  showCosts(); text('report-status', 'Fresh costs loaded. The existing seal, ciphertext and deadline were preserved. Save recovery and review again.');
}
action('refresh-costs', 'report-status', refreshSavedCosts);
action('inspect-funded-binding', 'posting-status', async () => {
  fundedCosts = undefined; fundedReviewed = false; input('funded-recovery-saved').checked = false; input('funded-binding-confirmed').checked = false;
  if (!localRecovery || !fundedProof) throw new Error('Check funded status first');
  const observed = await inspectFundedBinding(pub(), localRecovery, fundedProof, { expectedMarket: runtime.expectedMarket!, artifact, marketAbi });
  if (observed.bound) { await recoveredNotice(observed.triggerId); sponsorState = 'bound'; text('posting-status', 'Finalized binding independently verified. Signed notice downloaded.'); return; }
  fundedCosts = await priceFundedBinding(pub(), observed);
  facts('funded-binding-costs', [['Existing trigger', String(observed.triggerId)], ['Payer', observed.payer], ['Missing binding gas ceiling', eth(fundedCosts.gasWei)],
    ['Gas limit', String(fundedCosts.gasLimit)], ['Opens', utc(observed.args.t1)], ['Expires', utc(observed.args.t2)], ['Scope', 'Bind the existing finalized trigger only']]);
  text('posting-status', 'Funded post independently verified. Save recovery and review the missing binding cost.');
});
action('review-funded-binding', 'posting-status', async () => {
  if (!fundedCosts || !input('funded-recovery-saved').checked) throw new Error('Fresh binding review required');
  fundedReviewed = true; text('posting-status', runtime.writesEnabled ? 'Confirm the existing deadline and binding cost cap.' : 'Binding review available. This instance is read-only.');
});
action('complete-funded-binding', 'posting-status', async () => {
  if (!runtime.writesEnabled || !localRecovery || !fundedCosts || !fundedReviewed || !input('funded-recovery-saved').checked || !input('funded-binding-confirmed').checked) throw new Error('Confirmed review required');
  const id = fundingRequestId(localRecovery); if (!id) throw new Error('Saved request unavailable');
  const costs = fundedCosts; fundedCosts = undefined; fundedReviewed = false; sponsorState = 'unknown';
  const result = await sponsorApi(location.origin, `/api/sponsorship/requests/${id}/binding`, {
    proof: await sponsorshipProof(location.origin, id, 'binding', localRecovery.authorKey), grant: costs.grant, gasWei: costs.gasWei });
  text('posting-status', fundingState(result.state));
  // A server response alone cannot make a notice eligible for private delivery.
  sponsorState = String(result.state);
  if (result.state === 'bound' && typeof result.triggerId === 'bigint' && typeof result.postHash === 'string') {
    const observed = await inspectFundedBinding(pub(), localRecovery, { triggerId: result.triggerId, postHash: hex(result.postHash, 32) }, { expectedMarket: runtime.expectedMarket!, artifact, marketAbi });
    if (!observed.bound) throw new Error('Binding not independently finalized'); await recoveredNotice(observed.triggerId);
    text('posting-status', 'Finalized existing binding verified. Signed notice downloaded.');
  }
});
function invalidate() {
  sealed = undefined; cost = undefined; postPackage = undefined; reviewed = false;
  sponsorInput = undefined; sponsorBounds = undefined; sponsorPricing = undefined; button('request-sponsorship').disabled = true;
  signedNotice = undefined; resetContactConsent();
  input('recovery-saved').checked = false; input('irreversible').checked = false;
  button('review').disabled = true; button('post').disabled = true; button('save-recovery').disabled = true;
  element('final-review').hidden = true; text('costs', 'Fresh live estimates and a new recovery download are required.');
}
function showRecovery() {
  text('recovery-history', localRecovery?.history.length ? localRecovery.history.map(event => `${event.sequence + 1}. ${event.action}: ${event.state}${event.hash ? ` ${event.hash}` : ''}`).join('\n') : 'No transaction attempt recorded.');
}
// IndexedDB is local browser custody. Each attempted transition and hash is
// retained; nothing from this private record is uploaded to the portal.
async function persistLocal(action: string, hash?: Hex) {
  if (!localRecovery) throw new Error('Local recovery unavailable');
  localRecovery = await localStore.append(localRecovery, action as RecoveryAction, hash); showRecovery();
}
for (const id of ['release-time', 'window-hours', 'upload-a', 'read-a', 'upload-b', 'read-b']) listen(element(id), 'change', () => { invalidate(); syncActions(); });
for (const id of ['funding-method', 'sponsor-domain']) listen(element(id), 'change', () => { clearPricing(); syncActions(); });
for (const control of Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))) listen(control, 'change', syncActions);
input('release-time').value = new Date(Date.now() + 30 * 60_000).toISOString().slice(0, 16);
action('encrypt', 'report-status', async () => {
  if (attempted) throw new Error('Recover submitted work first');
  const file = input('report-file').files?.[0]; if (!file || file.size > maxReportBytes) throw new Error('Choose a supported report file');
  sponsorState = undefined; fundedProof = undefined; fundedCosts = undefined; fundedReviewed = false;
  invalidate(); author = createAuthorKey(); report = await prepareReport(new Uint8Array(await file.arrayBuffer()), author.address);
  localRecovery = await newBrowserRecovery(report, author.privateKey); showRecovery();
  input('author').value = author.address; button('plan').disabled = false; button('save-recovery').disabled = false;
  text('report-status', `Encrypted locally. Report ID: ${report.reportId}`);
});
action('plan', 'report-status', async () => {
  if (!report || !author || attempted || (localRecovery?.history.length ?? 0) > 0) throw new Error('Prepare report first');
  invalidate(); await guard();
  const t1 = BigInt(Math.floor(new Date(input('release-time').value + ':00Z').getTime() / 1000));
  const hours = Number(input('window-hours').value); if (!Number.isInteger(hours) || hours < 1 || hours > 8760) throw new Error('Invalid window');
  const t2 = t1 + BigInt(hours) * 3600n;
  const response = await fetch('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t1: String(t1), t2: String(t2) }), credentials: 'omit', signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(60_000)]) });
  if (!response.ok) throw new Error('Live plan unavailable'); plan = decodeWire(await response.text()) as Plan;
  const uris = await publishCiphertext(new Uint8Array(hexToBytes(report.ciphertext)), report.cipherHash, ['a', 'b'].map(id => ({ id, uploadUrl: input(`upload-${id}`).value, readUrl: input(`read-${id}`).value })), [location.origin], fetch);
  const crypto = await initBrowserCrypto(new URL('/cryptomata_core_bg.wasm', location.origin));
  sealed = await sealLocalReport(crypto, report, uris, { ...plan, maxPlaintextBytes: plan.parameters.maxPlaintextBytes, maxCiphertextBytes: plan.parameters.maxCiphertextBytes });
  localRecovery = await validateBrowserRecovery({ ...await newBrowserRecovery(report, author.privateKey), sealing: {
    registry: plan.registry, market: plan.addresses.market, cipherUris: sealed.recovery.cipherUris, nonce: sealed.recovery.nonce, args: encodeWire(sealed.args),
  } });
  button('save-recovery').disabled = false;
  if (element<HTMLSelectElement>('funding-method').value === 'protocol') {
    if (!runtime.sponsorship || !localRecovery) throw new Error('Protocol funding is not configured');
    sponsorInput = await prepareSponsorship(pub(), localRecovery, input('sponsor-domain').value.trim().toLowerCase(), runtime.sponsorship.payer,
      { expectedMarket: runtime.expectedMarket!, artifact, marketAbi });
    if (sealed.args.ceilingWei > BigInt(runtime.sponsorship.maxCeilingWei)) throw new Error('Protocol spending ceiling exceeded');
    const quote = await priceSponsorship(pub(), sponsorInput, { registry: artifact.abi, market: marketAbi, nil: nilAbi });
    sponsorBounds = { requestHash: quote.requestHash, ethReserveWei: quote.ethReserveWei, feeNil: quote.feeNil }; cost = quote.costs;
    sponsorPricing = { payer: quote.payer, escrowWei: quote.escrowWei, feeNil: quote.feeNil };
  } else {
    const priced = await priceSavedSelfFunded(pub(), localRecovery, plan, { expectedMarket: runtime.expectedMarket!, artifact, marketAbi, nilAbi });
    postPackage = priced.postPackage; cost = priced.costs;
  }
  showCosts();
  text('report-status', 'Both ciphertext copies matched. Payload sealed locally. Save the private recovery file before reviewing.');
  button('save-recovery').disabled = false;
  button('review').disabled = false;
});
action('save-recovery', 'report-status', async () => {
  if (!localRecovery) throw new Error('Recovery unavailable');
  download('pluto-private-recovery.json', exportBrowserRecovery(localRecovery), 'application/json');
  text('report-status', 'Recovery download requested. Save the file securely before confirming that it is saved.');
});
action('review', 'posting-status', async () => {
  if (!sealed || !cost || !input('recovery-saved').checked || attempted) throw new Error('Save recovery before review');
  reviewed = true; element('final-review').hidden = false;
  button('post').disabled = !runtime.writesEnabled || !!sponsorInput;
  button('request-sponsorship').disabled = !sponsorInput || !sponsorBounds;
  text('posting-status', runtime.writesEnabled ? 'Review the deadline and complete the second confirmation.' : 'Review available. This instance is read-only.');
});
action('post', 'posting-status', async () => {
  const consent = { recoverySaved: input('recovery-saved').checked, reviewed, confirmed: input('irreversible').checked, costsReady: !!cost };
  assertPostConsent(consent);
  if (!runtime.writesEnabled || attempted || !author || !report || !sealed || !plan || !postPackage) throw new Error('Posting unavailable');
  if (!localRecovery) throw new Error('Recovery unavailable');
  localRecovery = await localStore.save(localRecovery);
  if (!localRecovery || !canStartPosting(localRecovery)) throw new Error('Existing attempts must be recovered; no repost permitted');
  const account = privateKeyToAccount(author.privateKey), wallet = createWalletClient({ account, chain: sepolia, transport: http(runtime.publicRpcUrl!, { fetchFn: fetch }) });
  const posted = await submitSelfFunded(pub(), wallet, { ...postPackage, addresses: plan.addresses }, consent,
    async (action, hash) => { await persistLocal(action, hash); text('posting-status', `Submitted ${action}: ${hash}. Waiting for its receipt.`); }, true,
    { expectedMarket: runtime.expectedMarket!, artifact, onAttempt: async action => { attempted = true; await persistLocal(action); text('posting-status', `${action} attempt saved locally. An unknown outcome must be reconciled before retrying.`); } });
  signedNotice = await signNotice({ version: 1, chainId: 11155111, registry: plan.registry, reportId: report.reportId, triggerId: String(posted.triggerId),
    cipherHash: report.cipherHash, keyCommit: report.keyCommit, cipherUris: sealed.recovery.cipherUris, window: { t1: String(plan.t1), t2: String(plan.t2) },
    researcher: author.address, verifyUrl: `${location.origin}/workspace#verifier` }, account);
  download('pluto-signed-notice.json', JSON.stringify(signedNotice), 'application/json');
  text('posting-status', `Binding confirmed for trigger ${posted.triggerId}. Signed notice downloaded for out-of-band delivery.`);
});
function restoreRecovery(value: BrowserRecovery) {
  invalidate(); localRecovery = value; report = value.report; author = { address: value.report.researcher, privateKey: value.authorKey };
  sponsorState = undefined; fundedProof = undefined; fundedCosts = undefined; fundedReviewed = false;
  attempted = !canStartPosting(value); recoveryCosts = undefined; recoveryReviewed = false;
  input('author').value = author.address; input('local-report-id').value = value.report.reportId;
  button('plan').disabled = attempted || value.history.length > 0; button('save-recovery').disabled = false; button('inspect-recovery').disabled = !value.sealing || !attempted || !!fundingRequestId(value);
  button('review-recovery').disabled = true; button('resume-binding').disabled = true; element('recovery-confirmation').hidden = true;
  input('funded-recovery-saved').checked = false; input('funded-binding-confirmed').checked = false; input('withdraw-confirmed').checked = false;
  input('recovery-resaved').checked = false; input('binding-confirmed').checked = false; showRecovery();
  if (value.sealing) { const args = savedSealArgs(value); input('release-time').value = new Date(Number(args.t1!) * 1000).toISOString().slice(0, 16); input('window-hours').value = String(Number(args.t2! - args.t1!) / 3600); }
  text('recovery-costs', 'Inspect saved receipts before reviewing a missing binding.');
  button('sponsorship-status').disabled = !fundingRequestId(value); button('withdraw-sponsorship').disabled = !fundingRequestId(value);
  syncActions();
  text('recovery-status', attempted ? 'Private recovery restored locally. No transaction was sent. Inspect saved attempts before continuing.' : 'Prepared report restored locally. Refresh costs for the saved seal before posting.');
}
action('request-sponsorship', 'posting-status', async () => {
  if (!sponsorInput || !sponsorBounds || !localRecovery || attempted) throw new Error('Review funding first');
  const release = await releaseSponsorship(location.origin, sponsorInput, sponsorBounds, localRecovery,
    { recoverySaved: input('recovery-saved').checked, reviewed, confirmed: input('irreversible').checked, costsReady: !!cost });
  localRecovery = await localStore.save(localRecovery);
  if (!localRecovery || !canStartPosting(localRecovery)) throw new Error('Recover existing request first');
  sponsorState = undefined; fundedProof = undefined; fundedCosts = undefined; fundedReviewed = false;
  localRecovery = await localStore.claimFunding(localRecovery, release.id, 'sponsorRequest', { origin: location.origin, body: encodeWire(release.body) }); attempted = true; showRecovery();
  button('plan').disabled = true; button('post').disabled = true; button('request-sponsorship').disabled = true;
  button('sponsorship-status').disabled = false; button('withdraw-sponsorship').disabled = false;
  download('pluto-private-recovery.json', exportBrowserRecovery(localRecovery), 'application/json');
  const result = await uploadSavedSponsorship(location.origin, localRecovery, fetch); sponsorState = String(result.state);
  text('posting-status', `Funding request ${result.id}: ${result.state}. It is not a live deadline. Customer approval and finalized binding are required.`);
});
action('retry-funding-upload', 'posting-status', async () => {
  if (!localRecovery?.funding || localRecovery.funding.origin !== location.origin || fundingRequestId(localRecovery) !== localRecovery.funding.id) throw new Error('Exact local request unavailable');
  const result = await uploadSavedSponsorship(location.origin, localRecovery, fetch); sponsorState = String(result.state);
  text('posting-status', `Existing funding request ${result.id}: ${result.state}. No new post or authorization was created.`);
});
action('sponsorship-status', 'posting-status', async () => {
  if (!localRecovery || !author) throw new Error('Restore private recovery first');
  const id = fundingRequestId(localRecovery); if (!id) throw new Error('No saved funding request');
  const result = await sponsorApi(location.origin, `/api/sponsorship/requests/${id}/status`, await sponsorshipProof(location.origin, id, 'status', author.privateKey));
  if (result.id !== id) throw new Error('Request status identity mismatch');
  sponsorState = String(result.state); fundedProof = undefined; fundedCosts = undefined; fundedReviewed = false;
  if (result.state === 'withdrawn') { await recordWithdrawal(id); return; }
  text('posting-status', fundingState(result.state));
  if (['bound', 'awaiting-binding'].includes(sponsorState) && typeof result.triggerId === 'bigint' && typeof result.postHash === 'string') {
    fundedProof = { triggerId: result.triggerId, postHash: hex(result.postHash, 32) };
    const observed = await inspectFundedBinding(pub(), localRecovery, fundedProof, { expectedMarket: runtime.expectedMarket!, artifact, marketAbi });
    if (observed.bound) { await recoveredNotice(observed.triggerId); text('posting-status', `Finalized registry binding verified for trigger ${observed.triggerId}. Signed notice downloaded.`); }
  }
});
async function recordWithdrawal(id: Hex) {
  if (!localRecovery || fundingRequestId(localRecovery) !== id) throw new Error('Active local request required');
  localRecovery = await localStore.claimFunding(localRecovery, id, 'sponsorWithdraw'); attempted = false; sponsorState = 'withdrawn'; fundedProof = undefined; showRecovery();
  element<HTMLSelectElement>('funding-method').value = 'self'; clearPricing();
  download('pluto-private-recovery.json', exportBrowserRecovery(localRecovery), 'application/json');
  button('sponsorship-status').disabled = true; button('withdraw-sponsorship').disabled = true;
  text('posting-status', 'The unsubmitted funding request was withdrawn. Its history is preserved. Review fresh costs for the existing seal before proceeding self-funded.');
}
action('withdraw-sponsorship', 'posting-status', async () => {
  if (!input('withdraw-confirmed').checked || !localRecovery || !author) throw new Error('Confirm withdrawal first');
  const id = fundingRequestId(localRecovery); if (!id) throw new Error('No saved funding request');
  const result = await sponsorApi(location.origin, `/api/sponsorship/requests/${id}/withdraw`, await sponsorshipProof(location.origin, id, 'withdraw', author.privateKey));
  if (result.id !== id || result.state !== 'withdrawn') throw new Error('Withdrawal not verified');
  await recordWithdrawal(id);
});
action('import-recovery', 'recovery-status', async () => {
  const file = input('recovery-file').files?.[0]; if (!file || file.size > maxRecoveryFileBytes) throw new Error('Choose a supported private recovery file');
  const imported = await importBrowserRecovery(await file.text()), saved = await localStore.save(imported);
  if (!saved) throw new Error('Local recovery unavailable'); restoreRecovery(saved);
});
action('load-local-recovery', 'recovery-status', async () => {
  const saved = await localStore.load(hex(input('local-report-id').value, 32)); if (!saved) throw new Error('No local recovery for this report'); restoreRecovery(saved);
});
async function recoveredNotice(triggerId: bigint) {
  if (!localRecovery?.sealing || !author || !report) throw new Error('Recovery unavailable');
  const args = savedSealArgs(localRecovery);
  signedNotice = await signNotice({ version: 1, chainId: 11155111, registry: localRecovery.sealing.registry, reportId: report.reportId,
    triggerId: String(triggerId), cipherHash: report.cipherHash, keyCommit: report.keyCommit, cipherUris: localRecovery.sealing.cipherUris,
    window: { t1: String(args.t1), t2: String(args.t2) }, researcher: author.address, verifyUrl: `${location.origin}/workspace#verifier` }, privateKeyToAccount(author.privateKey));
  download('pluto-signed-notice.json', JSON.stringify(signedNotice), 'application/json');
}
action('inspect-recovery', 'recovery-status', async () => {
  recoveryCosts = undefined; recoveryReviewed = false; input('binding-confirmed').checked = false; element('recovery-confirmation').hidden = true;
  button('review-recovery').disabled = true; button('resume-binding').disabled = true;
  if (!localRecovery) throw new Error('Recovery unavailable');
  const observed = await inspectBrowserRecovery(pub(), localRecovery, { expectedMarket: runtime.expectedMarket!, artifact, marketAbi });
  if (observed.bound) {
    await recoveredNotice(observed.triggerId); text('recovery-status', `Finalized binding verified for trigger ${observed.triggerId}. Signed notice downloaded. No transaction was sent.`); return;
  }
  recoveryCosts = await priceRecoveredBinding(pub(), observed);
  facts('recovery-costs', [['Existing trigger', String(observed.triggerId)], ['Payer', observed.author], ['Missing binding gas ceiling', eth(recoveryCosts.gasWei)], ['Opens', utc(observed.args.t1)], ['Scope', 'Bind the existing trigger only']]);
  button('review-recovery').disabled = false;
  text('recovery-status', 'Successful finalized post verified. Download current recovery, then review the missing binding.');
});
action('review-recovery', 'recovery-status', async () => {
  if (!localRecovery || !recoveryCosts || !input('recovery-resaved').checked) throw new Error('Save recovery before reviewing');
  recoveryReviewed = true; element('recovery-confirmation').hidden = false; button('resume-binding').disabled = !runtime.writesEnabled;
  text('recovery-status', runtime.writesEnabled ? 'Confirm the existing immutable deadline before binding.' : 'Review available. This instance is read-only.');
});
action('resume-binding', 'recovery-status', async () => {
  if (!localRecovery || !recoveryCosts || !author) throw new Error('Inspect and review recovery first');
  const wallet = createWalletClient({ account: privateKeyToAccount(author.privateKey), chain: sepolia, transport: http(runtime.publicRpcUrl!, { fetchFn: fetch }) });
  const result = await resumeBrowserBinding(pub(), wallet, localRecovery,
    { recoverySaved: input('recovery-resaved').checked, reviewed: recoveryReviewed, confirmed: input('binding-confirmed').checked, costsReady: true },
    recoveryCosts, runtime.writesEnabled, { expectedMarket: runtime.expectedMarket!, artifact, marketAbi,
      onAttempt: async () => { await persistLocal('bind'); }, onSubmitted: async hash => { await persistLocal('bind', hash); } });
  await recoveredNotice(result.triggerId); recoveryReviewed = false; button('resume-binding').disabled = true;
  text('recovery-status', `Binding verified for trigger ${result.triggerId}. Save the updated recovery history. No report was reposted.`);
});
const recipientDomain = () => input('recipient-domain').value.trim().toLowerCase();
const contactSelect = () => element<HTMLSelectElement>('recipient-contact');
function resetContactConsent() { input('fingerprint-confirmed').checked = false; input('delivery-approved').checked = false; }
listen(input('recipient-domain'), 'change', () => { contactKeys = []; contactSelect().replaceChildren(); resetContactConsent(); text('contact-fingerprint', 'Load the verified contact directory again.'); syncActions(); });
listen(contactSelect(), 'change', () => { resetContactConsent(); syncActions(); const selected = contactKeys.find(contact => contact.contactId === contactSelect().value); text('contact-fingerprint', selected ? `Key version ${selected.keyVersion}; fingerprint ${selected.fingerprint}` : 'No verified contact selected.'); });
action('load-contacts', 'delivery-status', async () => {
  resetContactConsent(); contactKeys = await verifiedContacts(recipientDomain(), fetch); contactSelect().replaceChildren();
  for (const contact of contactKeys) { const option = document.createElement('option'); option.value = contact.contactId; option.textContent = `${contact.contactId} · key version ${contact.keyVersion}`; contactSelect().append(option); }
  text('contact-fingerprint', contactKeys[0] ? `Key version ${contactKeys[0].keyVersion}; fingerprint ${contactKeys[0].fingerprint}` : 'No verified contacts. Export the signed notice for manual recipient discovery.');
  text('delivery-status', contactKeys.length ? 'Verified keys loaded. Confirm the selected fingerprint before sharing.' : 'No verified contact is available.');
});
async function localDelivery() {
  if (!signedNotice || !report || !author || !input('fingerprint-confirmed').checked || !input('delivery-approved').checked) throw new Error('Bound signed notice and explicit delivery consent required');
  const contact = contactKeys.find(contact => contact.contactId === contactSelect().value);
  if (!contact) throw new Error('Select a verified contact');
  const fresh = (await verifiedContacts(recipientDomain(), fetch)).find(candidate => candidate.contactId === contact.contactId);
  if (!fresh || fresh.publicKey !== contact.publicKey || fresh.keyVersion !== contact.keyVersion || fresh.fingerprint !== contact.fingerprint) { resetContactConsent(); throw new Error('Contact changed; load and confirm again'); }
  return prepareNoticeDelivery({ notice: signedNotice, contact, signer: privateKeyToAccount(author.privateKey), key: report.key,
    ...(input('include-report').checked ? { plaintext: toHex(await decryptReport(hexToBytes(report.ciphertext), hexToBytes(report.key))) } : {}),
    confirmedFingerprint: contact.fingerprint, deliveryApproved: true });
}
action('export-delivery', 'delivery-status', async () => { download('pluto-encrypted-notice.json', JSON.stringify(await localDelivery()), 'application/json'); text('delivery-status', 'Encrypted, separately signed attachment exported for out-of-band delivery.'); });
action('send-delivery', 'delivery-status', async () => { await sendNoticeDelivery(await localDelivery(), fetch); text('delivery-status', 'The verified contact’s portal inbox accepted the signed notice and encrypted attachment. Email delivery is separate.'); });
const domain = () => input('protocol-domain').value.trim().toLowerCase();
const fundingPath = () => `/api/protocols/${domain()}/funding`;
action('funding', 'funding-status', async () => { const result = await sponsorApi(location.origin, fundingPath()); renderFundingSummary('funding-summary', result); text('funding-status', 'Verified deposits and spending limits loaded for this protocol.'); });
action('credit-deposit', 'funding-status', async () => { await sponsorApi(location.origin, fundingPath() + '/deposits', { hash: hex(input('deposit-hash').value, 32) }); text('funding-status', 'Canonical finalized inbound deposit credited. Reload balances before changing limits.'); });
action('configure-funding', 'funding-status', async () => {
  const amount = (id: string) => { const value = input(id).value; if (!/^(0|[1-9][0-9]{0,77})$/.test(value)) throw new Error('Invalid raw units'); return BigInt(value); };
  await sponsorApi(location.origin, fundingPath() + '/limits', { ethWei: amount('budget-eth'), nilUnits: amount('budget-nil'), perPostWei: amount('post-eth'), perPostNil: amount('post-nil') });
  text('funding-status', 'Spending limits saved within verified customer funds. Existing disclosures are unaffected.');
});
let fundingOffset = 0, inboxOffset = 0, inboxGeneration = 0;
function clearCustomerView() {
  inboxGeneration++; customerReview = undefined; enrollmentId = undefined; fundingOffset = 0; inboxOffset = 0;
  for (const id of ['notices', 'funding-summary', 'funding-request-list', 'funding-review', 'account-summary', 'staff-contacts']) text(id, 'Load authorized records for the selected protocol.');
  for (const id of ['funding-request-id', 'contact-id', 'contact-code', 'contact-email', 'contact-key', 'rotation-key', 'deposit-hash', 'budget-eth', 'budget-nil', 'post-eth', 'post-nil']) input(id).value = '';
  for (const id of ['funding-approved', 'delete-notice-confirmed', 'disable-account-confirmed']) input(id).checked = false;
  text('ownership-proof', 'No proof requested.'); button('funding-next').dataset.available = 'false'; button('inbox-next').dataset.available = 'false';
  button('approve-funding').disabled = true; button('confirm-enrollment').disabled = true;
}
async function loadRequests() {
  assertCustomerIdentity();
  const generation = inboxGeneration;
  const response = await fetch(`/api/protocols/${domain()}/sponsorship/requests?offset=${fundingOffset}`, { credentials: 'same-origin', redirect: 'error', signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(30_000)]) });
  if (!response.ok) throw new Error('Funding requests unavailable'); const contents = await response.text();
  if (generation !== inboxGeneration) throw new Error('Customer identity changed');
  if (contents.length > 200_000) throw new Error('Oversized requests'); const requests = decodeWire(contents);
  if (!Array.isArray(requests)) throw new Error('Invalid funding requests'); const target = element('funding-request-list'); target.replaceChildren();
  for (const value of requests) {
    const row = object(value), article = document.createElement('article'), title = document.createElement('h4'), state = document.createElement('p'), select = document.createElement('button');
    title.textContent = `Report ${String(row.reportId)}`; state.textContent = `${fundingState(row.state)} · author ${String(row.author)} · request ${String(row.id)}`;
    select.type = 'button'; select.className = 'secondary'; select.textContent = 'Select for review';
    listen(select, 'click', () => { if (busy) return; input('funding-request-id').value = hex(row.id, 32); customerReview = undefined; input('funding-approved').checked = false;
      text('funding-review', 'Load fresh terms and costs for this selected request.'); syncActions(); button('quote-funding').focus(); });
    article.append(title, state, select); target.append(article);
  }
  if (!requests.length) text('funding-request-list', 'No requests on this page. Reload to return to the first page.');
  button('funding-next').dataset.available = String(requests.length === 50);
  text('funding-status', `Requests ${fundingOffset + 1}–${fundingOffset + requests.length} loaded. Selection does not authorize spending.`);
}
action('funding-requests', 'funding-status', async () => { fundingOffset = 0; await loadRequests(); });
action('funding-next', 'funding-status', async () => { const previous = fundingOffset; fundingOffset += 50; try { await loadRequests(); } catch { fundingOffset = previous; throw new Error('Next page unavailable'); } });
let customerReview: { protocolId: string; id: Hex; bounds: SponsorBounds } | undefined;
listen(input('funding-request-id'), 'input', () => { customerReview = undefined; input('funding-approved').checked = false; text('funding-review', 'Load fresh terms for the selected request.'); syncActions(); });
listen(input('protocol-domain'), 'input', () => { clearCustomerView(); syncActions(); });
action('quote-funding', 'funding-status', async () => {
  customerReview = undefined; input('funding-approved').checked = false; text('funding-review', 'Checking fresh terms and costs…'); button('approve-funding').disabled = true;
  const id = hex(input('funding-request-id').value, 32), protocolId = domain();
  const quote = await sponsorApi(location.origin, `/api/protocols/${protocolId}/sponsorship/requests/${id}/quote`, {});
  const nextReview = { protocolId, id, bounds: { requestHash: hex(quote.requestHash, 32), ethReserveWei: BigInt(String(quote.ethReserveWei)), feeNil: BigInt(String(quote.feeNil)) } };
  const terms = parseSponsorInput(quote.input), args = terms.bundle.args;
  facts('funding-review', [['Request', id], ['Report', terms.bundle.reportId], ['Author', terms.bundle.authorization.author], ['Dedicated payer', String(quote.payer)],
    ['Ciphertext commitment', terms.bundle.cipherHash], ['Key commitment', terms.bundle.keyCommit], ['Opens', utc(args.t1)], ['Expires', utc(args.t2)],
    ['Maximum ETH reservation', eth(nextReview.bounds.ethReserveWei)], ['Protocol fee', `${nextReview.bounds.feeNil} raw NIL units`], ['Escrow', eth(quote.escrowWei)],
    ['Basefee ceiling', `${args.ceilingWei} wei`], ['Authorization expiry', utc(terms.bundle.authorization.deadline)], ['Signed release', hex(quote.release, 65)], ['Scope', 'One sponsored report with these immutable terms']]);
  customerReview = nextReview; input('funding-approved').checked = false;
  button('approve-funding').disabled = !runtime.writesEnabled;
  text('funding-status', runtime.writesEnabled ? 'Review the signed author release and exact ETH/NIL caps before approving the Sepolia submission.' : 'Review the signed author release and exact ETH/NIL caps. This instance is read-only.');
});
action('approve-funding', 'funding-status', async () => {
  if (!runtime.writesEnabled || !customerReview || customerReview.protocolId !== domain() || customerReview.id !== input('funding-request-id').value || !input('funding-approved').checked) throw new Error('Fresh approval required');
  const approved = customerReview; customerReview = undefined; input('funding-approved').checked = false;
  const result = await sponsorApi(location.origin, `/api/protocols/${approved.protocolId}/sponsorship/requests/${approved.id}/approve`, approved.bounds);
  button('approve-funding').disabled = true; facts('funding-review', [['Request', String(result.id)], ['Status', fundingState(result.state)]]);
  text('funding-status', `Funding status: ${result.state}. Finalized binding is required before asserting a live deadline.`);
});
action('login', 'portal-status', async () => {
  if (!walletAccess?.state.wallet) await connectWallet();
  await walletAccess!.signIn(); text('portal-status', walletAccess!.state.message);
});
action('logout', 'portal-status', async () => { await walletAccess!.signOut(); text('portal-status', 'Signed out.'); });
async function connectWallet() {
  if (options.walletConnector) {
    const provider = await options.walletConnector.connect(lifecycle.signal);
    lifecycle.signal.throwIfAborted();
    await walletAccess!.connect(provider, options.walletConnector.switchNetwork?.bind(options.walletConnector)); return;
  }
  const selected = wallets[0];
  if (!selected) throw new WalletAccessError('Install or unlock a browser wallet, then reload this page.');
  await walletAccess!.connect(selected.provider);
}
action('connect-wallet', 'global-status', async () => {
  const state = walletAccess!.state;
  if (state.wallet && state.chainId === 11155111) {
    const accountControls = options.walletConnector?.manageAccount;
    const connected = accountControls ? await accountControls.call(options.walletConnector, lifecycle.signal) : false;
    lifecycle.signal.throwIfAborted();
    if (!connected) {
      try { await walletAccess!.disconnect(); }
      finally { if (!accountControls) await options.walletConnector?.disconnect(); }
    }
  } else await connectWallet();
  text('global-status', walletAccess!.state.message);
});
action('enroll', 'portal-status', async () => {
  const proof = object(await api('/api/enrollments', { domain: domain() })); enrollmentId = String(proof.id);
  text('ownership-proof', `TXT ${proof.name}\n${proof.value}\nExpires: ${proof.expires}`); button('confirm-enrollment').disabled = false;
});
action('confirm-enrollment', 'portal-status', async () => { await api('/api/enrollments/confirm', { id: enrollmentId }); text('portal-status', 'Domain ownership verified.'); });
action('request-contact', 'portal-status', async () => {
  const contact = object(await api(`/api/protocols/${domain()}/contacts`, { email: input('contact-email').value, publicKey: input('contact-key').value }));
  input('contact-id').value = String(contact.id); text('portal-status', `Contact challenge queued. Public key fingerprint: ${contact.fingerprint}. Email delivery requires the configured adapter.`);
});
action('confirm-contact', 'portal-status', async () => { await api(`/api/protocols/${domain()}/contact-confirmation`, { id: input('contact-id').value, code: input('contact-code').value }); text('portal-status', 'Security contact verified.'); });
async function loadInbox() {
  const notices = await api(`/api/protocols/${domain()}/notices?offset=${inboxOffset}`); if (!Array.isArray(notices)) throw new Error('Invalid inbox');
  const target = element('notices'); target.replaceChildren();
  const generation = ++inboxGeneration, chainReads: (() => Promise<void>)[] = [];
  const current = () => !lifecycle.signal.aborted && generation === inboxGeneration;
  for (const item of notices) {
    const raw = object(item), container = document.createElement('article'), title = document.createElement('h3'), state = document.createElement('p'), exportButton = document.createElement('button'), remove = document.createElement('button');
    title.textContent = String(raw.reportId); state.textContent = 'Chain state unknown until verified.';
    exportButton.type = 'button'; exportButton.className = 'secondary'; exportButton.textContent = 'Download signed notice & encrypted attachment';
    listen(exportButton, 'click', () => { if (!busy) download('pluto-private-notice.json', JSON.stringify(raw), 'application/json'); });
    remove.type = 'button'; remove.className = 'danger'; remove.textContent = 'Remove private notice';
    const id = `remove-notice-${String(raw.reportId)}`; remove.id = id;
    container.append(title, state, exportButton, remove); target.append(container);
    action(id, 'portal-status', async () => {
      if (!input('delete-notice-confirmed').checked) throw new Error('Confirm private deletion first');
      await api(`/api/protocols/${domain()}/notices?reportId=${hex(raw.reportId, 32)}`, undefined, 'DELETE'); lifecycle.signal.throwIfAborted(); container.remove(); input('delete-notice-confirmed').checked = false;
      text('portal-status', 'Private notice removed. Permanent chain commitments are unaffected.');
    });
    chainReads.push(async () => {
    try { const observed = await inspectReport({ pub: pub(), notice: raw.notice, market: runtime.expectedMarket!, registryAbi: artifact.abi, marketAbi, artifact, fromBlock: BigInt(runtime.registryFirstBlock!) });
      if (!current()) return;
      state.textContent = `${observed.state}. Opens ${utc(observed.record.t1)}; expires ${utc(observed.record.t2)}. ${windowTiming(observed.record.t1, observed.record.t2, observed.timestamp)} at last chain read (block ${observed.block}).`;
    } catch { if (!current()) return; state.textContent = 'Chain state could not be verified. No live deadline is asserted.'; }
    });
  }
  if (!notices.length) target.textContent = 'No unexpired private notices on this page. Reload to return to the first page.';
  button('inbox-next').dataset.available = String(notices.length === 50);
  text('portal-status', `Private inbox loaded for ${domain()}. Independent chain checks continue below; unverified states remain unknown.`);
  void readInboxRows(chainReads, job => job(), current).catch(() => {
    if (current()) text('portal-status', 'Private inbox loaded. Some chain checks were unavailable; their states remain unknown.');
  });
}
action('inbox', 'portal-status', async () => { inboxOffset = 0; await loadInbox(); });
action('inbox-next', 'portal-status', async () => { const previous = inboxOffset; inboxOffset += 50; try { await loadInbox(); } catch { inboxOffset = previous; throw new Error('Next page unavailable'); } });
action('load-account', 'portal-status', async () => {
  const account = object(await api(`/api/protocols/${domain()}/account`));
  facts('account-summary', [['Protocol', String(account.protocolId)], ['Staff wallet', String(account.wallet)], ['Role', String(account.role)], ['Private retention', `${runtime.privateRetentionDays} days`]]);
  text('portal-status', 'Scoped staff access verified for this domain.');
});
action('load-staff-contacts', 'portal-status', async () => {
  const contacts = await api(`/api/protocols/${domain()}/contacts`); if (!Array.isArray(contacts)) throw new Error('Invalid contacts');
  const target = element('staff-contacts'); target.replaceChildren();
  for (const value of contacts) {
    const contact = object(value), article = document.createElement('article'), title = document.createElement('h4'), detail = document.createElement('p'), select = document.createElement('button');
    title.textContent = String(contact.email); detail.textContent = `${contact.verified ? 'Verified' : 'Verification pending'} · key version ${String(contact.key_version)} · ${String(contact.public_key)}`;
    select.type = 'button'; select.className = 'secondary'; select.textContent = 'Select contact'; listen(select, 'click', () => { if (!busy) { input('contact-id').value = String(contact.id); input('contact-code').value = ''; input('rotation-key').focus(); } });
    article.append(title, detail, select); target.append(article);
  }
  if (!contacts.length) target.textContent = 'No contact records. Request email verification below.';
  text('portal-status', 'Scoped contact records loaded.');
});
action('rotate-contact', 'portal-status', async () => {
  const result = object(await api(`/api/protocols/${domain()}/contact-rotation`, { id: input('contact-id').value, publicKey: hex(input('rotation-key').value, 32) }));
  input('contact-code').value = ''; text('portal-status', `Rotation challenge queued. Fingerprint: ${String(result.fingerprint)}. Confirm using the fresh email code; queueing does not prove email delivery.`);
});
action('confirm-rotation', 'portal-status', async () => { await api(`/api/protocols/${domain()}/rotation-confirmation`, { id: input('contact-id').value, code: input('contact-code').value }); input('contact-code').value = ''; text('portal-status', 'Contact key rotation verified. Reload contact records.'); });
action('disable-account', 'portal-status', async () => {
  if (!input('disable-account-confirmed').checked) throw new Error('Explicit account confirmation required');
  await api(`/api/protocols/${domain()}/disabled`, {}); clearCustomerView(); text('portal-status', 'Future protocol intake disabled. Posted disclosures remain independent.');
});
action('check-customer-request', 'funding-status', async () => {
  customerReview = undefined; input('funding-approved').checked = false;
  const result = await sponsorApi(location.origin, `/api/protocols/${domain()}/sponsorship/requests/${hex(input('funding-request-id').value, 32)}/status`);
  facts('funding-review', [['Request', String(result.id)], ['Status', fundingState(result.state)], ['Trigger', result.triggerId === undefined ? 'Unknown' : String(result.triggerId)], ['Post transaction', result.postHash === undefined ? 'Unknown' : String(result.postHash)]]);
  text('funding-status', 'Latest finalized service status loaded. A reported binding needs independent chain verification.');
});
action('export', 'portal-status', async () => { download('pluto-private-metadata.json', JSON.stringify(await api(`/api/protocols/${domain()}/export`)), 'application/json'); });
action('verify', 'verify-status', async () => {
  verifiedPlaintext = undefined; button('download-report').hidden = true; element('record').replaceChildren();
  await checkReadDeployment(pub(), runtime.expectedMarket!, runtime.registry!, artifact);
  const file = input('notice-file').files?.[0]; if (file && file.size > 100_000) throw new Error('Notice too large');
  const notice: unknown = file ? JSON.parse(await file.text()) : await api(`/api/public-notices/${hex(input('report-id').value, 32)}`);
  const options = { pub: pub(), notice, market: runtime.expectedMarket!, registryAbi: artifact.abi, marketAbi, artifact, fromBlock: BigInt(runtime.registryFirstBlock!) };
  const observed = await inspectReport(options), record = element('record'); record.replaceChildren();
  const add = (key: string, value: string) => { lifecycle.signal.throwIfAborted(); const label = document.createElement('dt'), body = document.createElement('dd'); label.textContent = key; body.textContent = value; record.append(label, body); };
  add('State', observed.state); add('Timing at last chain read', windowTiming(observed.record.t1, observed.record.t2, observed.timestamp)); add('Read block', String(observed.block)); add('Registered', new Date(Number(observed.record.registeredAt) * 1000).toISOString());
  add('Bound', observed.record.bindTime ? new Date(Number(observed.record.bindTime) * 1000).toISOString() : 'Unbound');
  add('Window (UTC)', `${new Date(Number(observed.record.t1) * 1000).toISOString()} — ${new Date(Number(observed.record.t2) * 1000).toISOString()}`);
  add('Ciphertext hash', observed.notice.cipherHash); add('Key commitment', observed.notice.keyCommit);
  if (observed.state !== 'disclosed') { text('verify-status', 'Signed notice and commitments verified. No authenticated disclosure is available yet.'); return; }
  let ciphertext: Uint8Array | undefined;
  for (const uri of observed.notice.cipherUris) {
    if (!uri.startsWith('https:')) continue;
    try {
      const result = await fetch(uri, { credentials: 'omit', redirect: 'error', signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(30_000)]) });
      if (!result.ok || !result.body) throw new Error('Ciphertext unavailable');
      const reader = result.body.getReader(), parts: Uint8Array[] = []; let size = 0;
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 1_048_610) { await reader.cancel(); throw new Error('Ciphertext too large'); } parts.push(chunk.value); }
      const candidate = new Uint8Array(size); let offset = 0; for (const part of parts) { candidate.set(part, offset); offset += part.length; }
      const verified = await verifyPublicReport(options, candidate); ciphertext = candidate; verifiedPlaintext = verified.plaintext;
      add('Disclosure block', String(verified.disclosureBlock)); add('Disclosed (UTC)', new Date(Number(verified.disclosureTimestamp) * 1000).toISOString()); add('Delay from t1', `${verified.delaySecs} seconds`); break;
    } catch { text('verify-status', 'A ciphertext copy could not be verified. Trying the next supplied HTTPS URI.'); }
  }
  if (!ciphertext || !verifiedPlaintext) throw new Error('Verified ciphertext unavailable');
  button('download-report').hidden = false; text('verify-status', 'Author signature, registry acceptance, ciphertext and key commitments verified. Decryption succeeded locally.');
});
action('download-report', 'verify-status', async () => { if (!verifiedPlaintext) throw new Error('Report unavailable'); download('verified-report.bin', verifiedPlaintext, 'application/octet-stream'); });
async function start() {
  journey = researcherJourney();
  if (journey) disposers.push(() => journey!.dispose());
  disposers.push(navigation(focus => journey?.activate(focus)));
  runtime = object(await api('/api/runtime')) as unknown as Runtime;
  void walletAccess!.restore().catch(() => { syncWalletControls(); });
  const sdk = object(await api('/sdk-abis.json')); marketAbi = sdk.market as Abi; nilAbi = sdk.nil as Abi;
  artifact = object(await api('/registry-artifact.json')) as unknown as RegistryArtifact;
  syncActions();
  text('posting-status', runtime.writesEnabled ? 'Sepolia submission is available after recovery, cost review and both confirmations.'
    : runtime.publicRpcUrl ? 'This instance is read-only. You can prepare a report and save recovery.' : 'Prepare locally. Use a configured Sepolia workspace to submit.');
  text('global-status', runtime.serviceMode === 'preview'
    ? ''
    : runtime.publicRpcUrl ? 'Connected to Sepolia. Deployment and costs are rechecked before submission.' : 'Offline preparation available. Live RPC and deployed registry configuration are missing.');
}
walletAccess = new WalletAccess({ origin: location.origin, chainId: 11155111, api,
  portalAvailable: () => !!runtime && !['preview', 'researcher'].includes(runtime.serviceMode ?? ''),
  onChange: syncWalletControls, onIdentityChange: () => { customerIdentityInvalidated = true; clearCustomerView(); if (!busy) syncActions(); } });
disposers.push(() => walletAccess?.dispose());
disposers.push(discoverWallets(window, found => {
  wallets = found;
  syncWalletControls();
}));
listen(window, 'focus', () => { if (!busy && !walletAccess!.state.busy) void walletAccess!.restore().catch(() => { syncWalletControls(); }); });
syncActions();
start().catch(() => { if (lifecycle.signal.aborted) return; showStatus('global-status', 'Configuration could not be loaded. Local encryption remains available; live actions are unavailable.', 'error'); syncActions(); });
return () => {
  if (lifecycle.signal.aborted) return;
  releaseControls?.(); releaseControls = undefined;
  lifecycle.abort(); inboxGeneration++;
  for (const dispose of disposers) dispose();
  author = undefined; report = undefined; localRecovery = undefined;
  sealed = undefined; signedNotice = undefined; verifiedPlaintext = undefined;
  postPackage = undefined; plan = undefined; sponsorInput = undefined;
};
}
