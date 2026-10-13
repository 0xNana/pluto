import { policy } from '../../../../../config/policy.mjs';

// Public configuration for standalone Next preview only. The production portal
// serves its own live /api/runtime; this route is excluded from its asset manifest.
export const dynamic = 'force-static';
export function GET() {
  return Response.json({ serviceMode: 'preview', chainId: 11155111,
    publicRpcUrl: null, expectedMarket: null, registry: null, registryFirstBlock: null,
    writesEnabled: false, privateRetentionDays: policy.privateRetentionDays, sponsorship: null,
  }, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
