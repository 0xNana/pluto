import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { renderComponent } from './lib/render-react.mjs';
import { createElement } from 'react';

test('landing explains disclosure and links to real workspace destinations without loading report or wallet controls', async () => {
  const html = await renderComponent('apps/web/app/page.tsx', 'default');
  assert.equal([...html.matchAll(/<h1\b/g)].length, 1);
  assert.equal([...html.matchAll(/<main\b/g)].length, 1);
  assert.match(html, /href="#landing-main"/);
  assert.match(html, /id="landing-main"[^>]*tabindex="-1"/);
  assert.match(html, /href="\/workspace#researcher"[^>]*>Get started/);
  for (const role of ['protocol', 'verifier']) assert.match(html, new RegExp(`href="/workspace#${role}"`));
  for (const target of [...html.matchAll(/href="#([^"]+)"/g)]) assert.match(html, new RegExp(`id="${target[1]}"`));
  assert.doesNotMatch(html, /id="report-file"|id="connect-wallet"|id="global-status"|Loading configuration|Encrypted locally\. Verified publicly\.|Vulnerability disclosure, on your terms/);
  assert.match(html, /committee/i);
  assert.match(html, /cannot be cancelled, extended or amended/);
  const source = await readFile('apps/web/app/page.tsx', 'utf8');
  assert.doesNotMatch(source, /DisclosureWorkspace|use client|walletConnector|controller\.mjs/);
});

test('workspace route retains the mounted workflow and omits the former product introduction', async () => {
  const html = await renderComponent('apps/web/app/workspace/page.tsx', 'default');
  assert.match(html, /id="researcher-prepare-panel"/);
  assert.match(html, /id="connect-wallet"/);
  assert.equal([...html.matchAll(/<h1\b/g)].length, 1);
  assert.doesNotMatch(html, /Vulnerability disclosure, on your terms|Give protocol teams time to respond|Encrypted locally\. Verified publicly\./);
});

test('legacy workspace bookmarks move to the new document without forwarding arbitrary fragments', async () => {
  const { legacyWorkspaceDestination } = await import('../apps/web/lib/workspace-routes.ts');
  for (const fragment of ['researcher', 'researcher/prepare', 'researcher/seal', 'researcher/review', 'researcher/share', 'researcher/recovery', 'protocol', 'verifier', 'funding-console']) {
    assert.equal(legacyWorkspaceDestination(`#${fragment}`), `/workspace#${fragment}`);
  }
  for (const hash of ['', '#how-it-works', '#questions', '#top', '#verifier/private', '#researcher/unknown', '#researcher?key=synthetic', '#//other.example']) {
    assert.equal(legacyWorkspaceDestination(hash), undefined);
  }
});

test('Next React workspace retains native labeled controls, risk copy, recovery and disabled submission gates', async () => {
    const html = await renderComponent('apps/web/components/disclosure-workspace.tsx', 'DisclosureWorkspace');
    const reference = await readFile('packages/web/index.html', 'utf8');
    const ids = text => [...text.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]).sort();
    const addedIds = ['connect-wallet', 'researcher-new', 'researcher-saved', 'researcher-recovery-title', 'researcher-prepare-panel', 'researcher-seal-panel', 'researcher-review-panel', 'researcher-share-panel', 'researcher-recovery-panel', 'researcher-stage-controls', 'researcher-back', 'researcher-next', 'researcher-continue', 'researcher-task-status', 'researcher-report-id', 'researcher-report-state', 'researcher-prepare', 'researcher-seal', 'researcher-review', 'researcher-share', 'step-shared'];
    assert.deepEqual(ids(html), [...ids(reference), ...addedIds].sort(), 'all workflow controls and exactly the shell/journey controls are retained');
    assert.equal(new Set(ids(html)).size, ids(html).length);
    for (const label of html.matchAll(/\bfor="([^"]+)"/g)) assert.ok(ids(html).includes(label[1]));
    for (const id of ['post', 'request-sponsorship', 'approve-funding', 'resume-binding', 'complete-funded-binding']) {
      assert.match(html, new RegExp(`<button\\b[^>]*id="${id}"[^>]*disabled`));
    }
    assert.match(html, /class="skip" href="#main"/);
    assert.match(html, /id="main"[^>]*tabindex="-1"/);
    assert.match(html, /id="window-hours"[^>]*value="24"/);
    assert.match(html, /deadline cannot be cancelled, extended or amended/);
    assert.match(html, /Protocol customer/);
    assert.doesNotMatch(html, /Wallet access|Loading wallet controls|wallet-panel|wallet-menu|wallet-sign-in|disconnect-wallet|Open protocol workspace|<iframe|onclick=|<script[^>]*src="https?:/);
});

test('app shell provides one main landmark and named persistent navigation for independent users and customers', async () => {
  const html = await renderComponent('apps/web/components/disclosure-workspace.tsx', 'DisclosureWorkspace');
  assert.match(html, /class="app-shell"/);
  assert.match(html, /<header\b[^>]*class="app-header"/);
  assert.match(html, /<aside\b[^>]*class="app-sidebar"[\s\S]*?<nav\b[^>]*aria-label="Workspaces"/);
  assert.equal([...html.matchAll(/<main\b/g)].length, 1);
  assert.equal([...html.matchAll(/<h1\b/g)].length, 1);
  assert.equal([...html.matchAll(/<nav\b/g)].length, 1, 'one navigation works at all viewport sizes');
  const links = [...html.matchAll(/<a\b([^>]*)data-workspace="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/g)];
  assert.deepEqual(links.map(link => link[2]), ['researcher', 'protocol', 'verifier']);
  for (const link of links) assert.match(link[1], new RegExp(`href="#${link[2]}"`));
  assert.equal(links.filter(link => /aria-current="page"/.test(link[1] + link[3])).length, 1);
  assert.match(links[0][4], /Independent researcher/);
  assert.match(links[1][4], /Protocol customer/);
  assert.match(links[2][4], /Public access/);
  assert.doesNotMatch(html, /Sepolia · development|class="network"/);
  assert.match(html, /id="global-status"[^>]*role="status"/);
  assert.match(html, /<footer\b[^>]*class="app-footer"/);
});

test('shared shell composes content without rendering workflow forms or mounting a controller', async () => {
  const html = await renderComponent('apps/web/components/shell/app-shell.tsx', 'AppShell', {
    children: createElement('button', { type: 'button' }, 'Example workspace action'),
  });
  assert.match(html, /<main\b[\s\S]*?<button type="button">Example workspace action<\/button>[\s\S]*?<\/main>/);
  assert.equal([...html.matchAll(/Example workspace action/g)].length, 1);
  assert.doesNotMatch(html, /id="report-file"|id="login"|id="notice-file"|id="global-status"|Loading configuration|<script/);
});

test('researcher workspace presents one stage, keeps every workflow mounted and separates saved-report tools', async () => {
  const html = await renderComponent('apps/web/components/researcher-workspace.tsx', 'ResearcherWorkspace');
  for (const stage of ['prepare', 'seal', 'review', 'share', 'recovery']) {
    assert.match(html, new RegExp(`id="researcher-${stage}-panel"`));
  }
  assert.match(html, /id="researcher-prepare-panel"[^>]*aria-labelledby="prepare-title"/);
  for (const stage of ['seal', 'review', 'share', 'recovery']) assert.match(html, new RegExp(`id="researcher-${stage}-panel"[^>]*hidden`));
  assert.match(html, /aria-label="Researcher tasks"/);
  assert.match(html, /aria-label="Disclosure steps"/);
  assert.match(html, /id="researcher-new"[^>]*aria-pressed="true"/);
  assert.match(html, /id="researcher-prepare"[^>]*aria-current="step"/);
  for (const id of ['researcher-prepare', 'researcher-seal', 'researcher-review', 'researcher-share', 'researcher-next']) {
    const button = html.match(new RegExp(`<button\\b[^>]*id="${id}"[^>]*>`));
    assert.ok(button, `${id} is rendered`);
    assert.doesNotMatch(button[0], /\bdisabled\b/, `${id} allows browsing before preparation`);
  }
  const support = html.slice(html.indexOf('<aside'));
  assert.match(support, /aria-label="Current report"/);
  for (const id of ['save-recovery', 'report-status', 'posting-status']) assert.ok(support.includes(`id="${id}"`), `${id} remains visible across stages`);
  const saved = html.slice(html.indexOf('id="researcher-recovery-panel"'), html.indexOf('id="researcher-stage-controls"'));
  for (const id of ['import-recovery', 'inspect-recovery', 'resume-binding', 'retry-funding-upload', 'complete-funded-binding']) assert.ok(saved.includes(`id="${id}"`));
  assert.match(html, /deadline cannot be cancelled, extended or amended/);
  assert.match(html, /A bound, signed notice and explicit sharing consent are required/);
});
