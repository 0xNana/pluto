import { encodeWire, decodeWire } from '../client/wire.mts';
import { exact, hex } from '../client/notice.mts';
import { uint } from '../client/sponsor-wire.mts';
import { SponsorRequests } from '../relayer/requests.mts';
import { SponsorFunding } from '../relayer/funding.mts';
import { readJson } from './http.mts';
import { getAddress } from 'viem';

function reply(value: unknown, status = 200) {
  return new Response(encodeWire(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
}
export function sponsorHandler(requests: SponsorRequests, funding?: SponsorFunding) {
  if (funding && (funding.store !== requests.store || getAddress(funding.payer) !== getAddress(requests.service.wallet.account.address)
    || getAddress(funding.market) !== getAddress(requests.service.config.expectedMarket))) throw new Error('Funding service context mismatch');
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/sponsorship/') && !/^\/api\/protocols\/[a-z0-9.-]+\/(?:funding|sponsorship)(?:\/|$)/.test(url.pathname)) return null;
    if (url.origin !== requests.store.origin || (request.method !== 'GET' && request.headers.get('origin') !== requests.store.origin)) return reply({ error: { code: 'FORBIDDEN' } }, 403);
    const session = /(?:^|;\s*)pluto_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get('cookie') ?? '')?.[1] ?? '';
    try {
      const read = async () => decodeWire(JSON.stringify(await readJson(request, 200_000)));
      if (request.method === 'POST' && url.pathname === '/api/sponsorship/quote') return reply(await requests.quote(await read()));
      if (request.method === 'POST' && url.pathname === '/api/sponsorship/requests') return reply(await requests.create(await read()), 201);
      const authorRoute = /^\/api\/sponsorship\/requests\/(0x[a-fA-F0-9]{64})\/(status|withdraw|binding)$/.exec(url.pathname);
      if (authorRoute && request.method === 'POST') {
        const id = hex(authorRoute[1], 32), raw = await read();
        if (authorRoute[2] === 'status') return reply(await requests.status(id, raw));
        if (authorRoute[2] === 'withdraw') return reply(await requests.withdraw(id, raw));
        const value = raw as Record<string, unknown>; exact(value, ['proof', 'grant', 'gasWei']);
        return reply(await requests.bind(id, value.proof, value.grant, value.gasWei));
      }
      const customerRoute = /^\/api\/protocols\/([a-z0-9.-]+)\/(funding(?:\/(deposits|limits))?|sponsorship\/requests(?:\/(0x[a-fA-F0-9]{64})\/(quote|approve|status))?)$/.exec(url.pathname);
      if (!customerRoute) return reply({ error: { code: 'NOT_FOUND' } }, 404);
      const [, protocolId, resource, fundingAction, requestId, action] = customerRoute;
      requests.store.authorize(session, protocolId); // Includes unsupported methods.
      if (resource === 'funding' && request.method === 'GET') {
        if (!funding) return reply({ error: { code: 'FUNDING_NOT_CONFIGURED' } }, 503);
        return reply({ ...funding.summary(session, protocolId), budget: requests.service.summary(session, protocolId) ?? null });
      }
      if (fundingAction && request.method === 'POST') {
        if (!funding) return reply({ error: { code: 'FUNDING_NOT_CONFIGURED' } }, 503);
        const value = await read() as Record<string, unknown>;
        if (fundingAction === 'deposits') { exact(value, ['hash']); return reply(await funding.credit(session, protocolId, hex(value.hash, 32))); }
        exact(value, ['ethWei', 'nilUnits', 'perPostWei', 'perPostNil']);
        requests.service.configure(session, protocolId, { ethWei: uint(value.ethWei), nilUnits: uint(value.nilUnits), perPostWei: uint(value.perPostWei), perPostNil: uint(value.perPostNil) }, () => funding.available(protocolId));
        return reply({ configured: true });
      }
      if (!requestId && resource === 'sponsorship/requests' && request.method === 'GET') return reply(requests.list(session, protocolId, Number(url.searchParams.get('offset') ?? 0)));
      if (requestId) {
        const id = hex(requestId, 32);
        if (action === 'status' && request.method === 'GET') return reply(await requests.customerStatus(session, protocolId, id));
        if (action === 'quote' && request.method === 'POST') { const value = await read() as Record<string, unknown>; exact(value, []); return reply(await requests.customerQuote(session, protocolId, id)); }
        if (action === 'approve' && request.method === 'POST') return reply(await requests.approve(session, protocolId, id, await read()));
      }
      return reply({ error: { code: 'METHOD_NOT_ALLOWED' } }, 405);
    } catch (error) {
      const denied = error instanceof Error && error.message === 'Not authorized';
      const disabled = error instanceof Error && error.message.includes('disabled until release approval');
      return reply({ error: { code: denied ? 'FORBIDDEN' : disabled ? 'LIVE_WRITES_DISABLED' : 'INVALID_REQUEST' } }, denied ? 403 : disabled ? 503 : 400);
    }
  };
}
