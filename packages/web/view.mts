import { formatEther } from 'viem';
import { object } from '../client/notice.mts';
import { WORKSPACES, type WorkspaceId } from './workspaces.ts';

export function node<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id); if (!value) throw new Error('Missing interface control'); return value as T;
}
export function status(id: string, message: string, kind: 'info' | 'busy' | 'error' | 'success' = 'info') {
  const target = node(id); target.textContent = message; target.dataset.state = kind;
}
export function facts(id: string, rows: [string, string][]) {
  const target = node(id); target.replaceChildren();
  const list = document.createElement('dl');
  for (const [label, value] of rows) {
    const term = document.createElement('dt'), detail = document.createElement('dd'); term.textContent = label; detail.textContent = value; list.append(term, detail);
  }
  target.append(list);
}
export function rawUnits(value: unknown) {
  if (typeof value !== 'bigint' || value < 0n) throw new Error('Invalid displayed units');
  return value.toString();
}
export function eth(value: unknown) { return `${formatEther(BigInt(rawUnits(value)))} ETH`; }
export function utc(value: unknown) {
  if (typeof value !== 'bigint' || value < 0n || value > 253402300799n) throw new Error('Invalid displayed timestamp');
  return new Date(Number(value) * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}
export function windowTiming(t1: bigint, t2: bigint, timestamp: bigint) {
  if (t1 < 0n || t2 <= t1 || timestamp < 0n) throw new Error('Invalid window timing');
  const remaining = timestamp < t1 ? t1 - timestamp : timestamp <= t2 ? t2 - timestamp : timestamp - t2;
  const duration = `${remaining / 86400n}d ${(remaining % 86400n) / 3600n}h ${(remaining % 3600n) / 60n}m ${remaining % 60n}s`;
  return timestamp < t1 ? `Opens in ${duration}` : timestamp <= t2 ? `Window expires in ${duration}` : `Window expired ${duration} ago`;
}
export function fundingState(value: unknown): string {
  const messages: Record<string, string> = { pending: 'Awaiting customer approval · no live deadline', attempted: 'Submission attempted · check finalized status',
    withdrawn: 'Unsubmitted request withdrawn', unknown: 'Outcome unknown · keep recovery and do not resubmit', 'review-required': 'Costs changed · review again before approval',
    'awaiting-binding': 'Finalized post found · binding is still required', bound: 'Finalized binding reported · verify against the chain', failed: 'Finalized submission failed · no automatic repost' };
  if (typeof value !== 'string' || !messages[value]) throw new Error('Unknown funding state'); return messages[value];
}
export function renderFundingSummary(id: string, raw: unknown) {
  const data = object(raw), available = object(data.available), budget = data.budget === null ? undefined : object(data.budget);
  const rows: [string, string][] = [['Dedicated payer', String(data.payer)], ['Unspent ETH credit', eth(available.ethWei)], ['Unspent NIL credit', `${rawUnits(available.nilUnits)} raw units`]];
  if (budget) for (const [label, key, unit] of [['ETH spending limit', 'eth', 'wei'], ['NIL spending limit', 'nil', 'raw units'], ['ETH reserved', 'reserved_eth', 'wei'], ['NIL reserved', 'reserved_nil', 'raw units'], ['Per-report ETH cap', 'per_post_eth', 'wei'], ['Per-report NIL cap', 'per_post_nil', 'raw units']]) rows.push([label, `${String(budget[key])} ${unit}`]);
  if (data.deposits !== undefined) {
    if (!Array.isArray(data.deposits)) throw new Error('Invalid deposit records');
    for (const rawDeposit of data.deposits) { const deposit = object(rawDeposit); rows.push(['Finalized deposit', `${String(deposit.hash)} · ${String(deposit.eth)} wei · ${String(deposit.nil)} raw NIL units · block ${String(deposit.block)}`]); }
    if (!data.deposits.length) rows.push(['Deposits', 'No verified deposits recorded']);
  }
  facts(id, rows);
}
export function navigation(onResearcherRoute?: (focus: boolean) => void) {
  const routes = WORKSPACES.map(workspace => workspace.id);
  let active: WorkspaceId = 'researcher';
  const activate = (focus: boolean) => {
    const destination = location.hash.slice(1), selected = destination === 'main' ? active : destination === 'funding-console' ? 'protocol' : WORKSPACES.find(workspace => workspace.id === destination.split('/')[0])?.id ?? 'researcher';
    active = selected;
    for (const id of routes) node(id).hidden = id !== selected;
    for (const link of Array.from(document.querySelectorAll<HTMLAnchorElement>('nav a[data-workspace]'))) {
      if (link.dataset.workspace === selected) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    }
    if (focus) node(destination === 'main' ? 'main' : destination === 'funding-console' ? 'funding-title' : `${selected}-title`).focus();
    if (selected === 'researcher') onResearcherRoute?.(focus);
  };
  const changed = () => activate(true);
  window.addEventListener('hashchange', changed); activate(false);
  return () => window.removeEventListener('hashchange', changed);
}
export function recoverableError(action: string) {
  if (['request-sponsorship', 'retry-funding-upload'].includes(action)) return 'Upload was not confirmed. Keep the downloaded recovery file, then retry the exact saved request or check its status. Do not create a replacement request.';
  if (['post', 'resume-binding', 'complete-funded-binding', 'approve-funding'].includes(action)) return 'Submission was not confirmed. Restore recovery and check finalized status before any retry. An unknown outcome must not be resubmitted.';
  if (action === 'withdraw-sponsorship') return 'Withdrawal was not confirmed. Check the request status. Self-funded continuation stays blocked until withdrawal is verified.';
  if (['login', 'inbox', 'funding', 'funding-requests', 'load-account', 'load-staff-contacts'].includes(action)) return 'Access could not be confirmed. Sign in with an authorized staff wallet and check the selected protocol domain.';
  if (['plan', 'refresh-costs', 'inspect-recovery', 'inspect-funded-binding', 'verify'].includes(action)) return 'Live verification or pricing was unavailable. Check the deployment, RPC and immutable window. No success is asserted; keep your recovery file.';
  return 'This step was not completed. Check the required fields and configuration, then try again. Your saved recovery is preserved.';
}
