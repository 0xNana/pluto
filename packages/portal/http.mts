import { type Hex } from 'viem';
import { exact, hex, object } from '../client/notice.mts';
import { PortalStore } from './store.mts';
import { PortalInbox } from './inbox.mts';
import { ProtocolEnrollment } from './enrollment.mts';

function response(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json',
    'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra } });
}
export async function readJson(request: Request, limit = 2_300_000): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.startsWith('application/json') || !request.body) throw new Error('Invalid request');
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const chunk = await reader.read(); if (chunk.done) break;
    size += chunk.value.length; if (size > limit) { await reader.cancel(); throw new Error('Invalid request'); }
    chunks.push(chunk.value);
  }
  const joined = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)));
}
function session(request: Request) {
  return /(?:^|;\s*)pluto_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get('cookie') ?? '')?.[1] ?? '';
}
export function portalHandler(store: PortalStore, inbox: PortalInbox, enrollment: ProtocolEnrollment) {
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url), token = session(request);
      if (url.origin !== store.origin || (request.method !== 'GET' && request.headers.get('origin') !== store.origin)) return response({ error: { code: 'FORBIDDEN' } }, 403);
      if (request.method === 'GET' && url.pathname === '/api/auth/session') return response(store.sessionInfo(token));
      if (request.method === 'POST' && url.pathname === '/api/auth/challenges') {
        const input = await readJson(request); exact(input, ['wallet']);
        return response(store.challenge(hex(input.wallet, 20)), 201);
      }
      if (request.method === 'POST' && url.pathname === '/api/auth/sessions') {
        const input = await readJson(request); exact(input, ['id', 'signature']);
        const value = await store.authenticate(String(input.id), hex(input.signature, 65));
        return response({ authenticated: true }, 201, { 'Set-Cookie': `pluto_session=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600` });
      }
      if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
        store.logout(token); return response({ authenticated: false }, 200, { 'Set-Cookie': 'pluto_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0' });
      }
      if (request.method === 'POST' && url.pathname === '/api/enrollments') {
        const input = await readJson(request); exact(input, ['domain']); return response(enrollment.request(token, String(input.domain)), 201);
      }
      if (request.method === 'POST' && url.pathname === '/api/enrollments/confirm') {
        const input = await readJson(request); exact(input, ['id']); return response(await enrollment.confirm(token, String(input.id)));
      }
      const directory = /^\/api\/directory\/([a-z0-9.-]+)$/.exec(url.pathname);
      if (request.method === 'GET' && directory) return response(inbox.directory(directory[1]));
      const publicCopy = /^\/api\/public-notices\/(0x[a-fA-F0-9]{64})$/.exec(url.pathname);
      if (request.method === 'GET' && publicCopy) {
        const notice = inbox.publicCopy(publicCopy[1] as Hex); return notice ? response(notice) : response({ error: { code: 'NOT_FOUND' } }, 404);
      }
      if (request.method === 'POST' && url.pathname === '/api/notices') {
        const input = await readJson(request); exact(input, ['contactId', 'notice', ...(Object.hasOwn(input, 'attachment') ? ['attachment'] : [])]);
        await inbox.deliverNotice(String(input.contactId), input.notice, input.attachment); return response({ delivered: true }, 201);
      }
      const route = /^\/api\/protocols\/([a-z0-9.-]+)\/(account|notices|contacts|export|disabled|contact-confirmation|contact-rotation|rotation-confirmation)$/.exec(url.pathname);
      if (!route) return response({ error: { code: 'NOT_FOUND' } }, 404);
      const [, protocolId, resource] = route;
      store.authorize(token, protocolId); // Every scoped route, including unknown methods.
      if (request.method === 'GET') {
        if (resource === 'account') return response(store.account(token, protocolId));
        if (resource === 'notices') return response(inbox.list(token, protocolId, Number(url.searchParams.get('offset') ?? 0)));
        if (resource === 'contacts') return response(inbox.contacts(token, protocolId));
        if (resource === 'export') return response(inbox.export(token, protocolId));
      }
      if (request.method === 'POST') {
        const input = await readJson(request);
        if (resource === 'contacts') { exact(input, ['email', 'publicKey']); return response(inbox.requestContact(token, protocolId, { email: String(input.email), publicKey: hex(input.publicKey, 32) }), 201); }
        if (resource === 'contact-confirmation' || resource === 'rotation-confirmation') {
          exact(input, ['id', 'code']);
          (resource === 'contact-confirmation' ? inbox.confirmContact.bind(inbox) : inbox.confirmRotation.bind(inbox))(token, protocolId, String(input.id), String(input.code));
          return response({ verified: true });
        }
        if (resource === 'contact-rotation') { exact(input, ['id', 'publicKey']); return response(inbox.rotateContact(token, protocolId, String(input.id), hex(input.publicKey, 32)), 201); }
        if (resource === 'disabled') { exact(input, []); store.setEnabled(token, protocolId, false); return response({ disabled: true }); }
      }
      if (request.method === 'DELETE' && resource === 'notices') { inbox.removeNotice(token, protocolId, hex(url.searchParams.get('reportId'), 32)); return response({ deleted: true }); }
      return response({ error: { code: 'METHOD_NOT_ALLOWED' } }, 405);
    } catch (error) {
      const denied = error instanceof Error && ['Not authorized', 'Authentication failed'].includes(error.message);
      return response({ error: { code: denied ? 'FORBIDDEN' : 'INVALID_REQUEST' } }, denied ? 403 : 400);
    }
  };
}
