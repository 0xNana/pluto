import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { PortalStore } from '../packages/portal/store.mts';
import { PortalInbox } from '../packages/portal/inbox.mts';
import { ProtocolEnrollment } from '../packages/portal/enrollment.mts';
import { portalHandler } from '../packages/portal/http.mts';

test('T-15 HTTP rejects forged sessions, cross-tenant access and cross-origin writes; cookies are private', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pluto-http-')); await chmod(directory, 0o700);
  const store = new PortalStore(join(directory, 'portal.sqlite'), 'https://pluto.example', 11155111);
  try {
    const account = privateKeyToAccount('0x' + '12'.repeat(32)); store.enrollVerifiedProtocol('alpha.example', account.address);
    const handler = portalHandler(store, new PortalInbox(store, 90 * 86400), new ProtocolEnrollment(store));
    const request = (path, body, cookie, origin = store.origin) => new Request(store.origin + path, {
      method: body ? 'POST' : 'GET', headers: { ...(body ? { origin, 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const challenge = await (await handler(request('/api/auth/challenges', { wallet: account.address }))).json();
    const login = await handler(request('/api/auth/sessions', { id: challenge.id, signature: await account.signMessage({ message: challenge.message }) }));
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Strict/);
    assert.equal((await handler(request('/api/protocols/alpha.example/notices', undefined, cookie))).status, 200);
    assert.equal((await handler(request('/api/protocols/beta.example/notices', undefined, cookie))).status, 403);
    assert.equal((await handler(request('/api/protocols/alpha.example/notices', undefined, 'pluto_session=forged'))).status, 403);
    assert.equal((await handler(request('/api/protocols/alpha.example/disabled', {}, cookie, 'https://evil.example'))).status, 403);
    const denied = await handler(request('/api/protocols/beta.example/contacts', undefined, cookie));
    assert.deepEqual(await denied.json(), { error: { code: 'FORBIDDEN' } });
    assert.equal(denied.headers.get('cache-control'), 'no-store');
    assert.match(denied.headers.get('content-security-policy'), /default-src 'none'/);
  } finally { store.close(); await rm(directory, { recursive: true }); }
});

test('wallet session inspection is cookie-bound, redacted, expires and reflects logout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pluto-session-')); await chmod(directory, 0o700);
  let now = 1000;
  const store = new PortalStore(join(directory, 'portal.sqlite'), 'https://pluto.example', 11155111, () => now);
  try {
    const handler = portalHandler(store, new PortalInbox(store, 90 * 86400), new ProtocolEnrollment(store));
    const request = (path, body, cookie) => new Request(store.origin + path, { method: body ? 'POST' : 'GET', headers: {
      ...(body ? { origin: store.origin, 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const anonymous = await handler(request('/api/auth/session'));
    assert.equal(anonymous.status, 200); assert.deepEqual(await anonymous.json(), { authenticated: false });
    assert.equal(anonymous.headers.get('cache-control'), 'no-store');
    const account = privateKeyToAccount('0x' + '12'.repeat(32));
    const challenge = await (await handler(request('/api/auth/challenges', { wallet: account.address }))).json();
    const login = await handler(request('/api/auth/sessions', { id: challenge.id, signature: await account.signMessage({ message: challenge.message }) }));
    const cookie = login.headers.get('set-cookie');
    assert.deepEqual(await (await handler(request('/api/auth/session', undefined, cookie))).json(), { authenticated: true, wallet: account.address, chainId: 11155111, expires: 4600 });
    assert.deepEqual(await (await handler(request('/api/auth/session', undefined, 'pluto_session=' + 'ff'.repeat(32)))).json(), { authenticated: false });
    assert.equal((await handler(new Request('https://evil.example/api/auth/session', { headers: { cookie } }))).status, 403);
    now = 4600;
    assert.deepEqual(await (await handler(request('/api/auth/session', undefined, cookie))).json(), { authenticated: false });
    now = 1000;
    await handler(request('/api/auth/logout', {}, cookie));
    assert.deepEqual(await (await handler(request('/api/auth/session', undefined, cookie))).json(), { authenticated: false });
  } finally { store.close(); await rm(directory, { recursive: true }); }
});
