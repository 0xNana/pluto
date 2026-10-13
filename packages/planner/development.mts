import { type Hex, type PublicClient } from 'viem';
import { checkDeployment, type RegistryArtifact } from '../client/deployment.mts';
import { exact } from '../client/notice.mts';
import { encodeWire } from '../client/wire.mts';
import { readJson } from '../portal/http.mts';
import { createPlan } from './planner.mts';
import { policy } from '../../config/policy.mjs';

interface DevelopmentConfig {
  origin: string; publicRpcUrl: string; expectedMarket: Hex; registry: Hex;
  registryFirstBlock: bigint; writesEnabled: boolean; pub: PublicClient; artifact: RegistryArtifact;
}
export async function researcherDevelopmentHandler(config: DevelopmentConfig) {
  const origin = new URL(config.origin), rpc = new URL(config.publicRpcUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) || origin.origin !== config.origin
    || !['http:', 'https:'].includes(origin.protocol) || config.registryFirstBlock < 0n
    || rpc.protocol !== 'https:' || rpc.username || rpc.password || rpc.hash) throw new Error('Invalid local researcher configuration');
  await checkDeployment(config.pub, config.expectedMarket, config.registry, config.artifact);
  const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  let windowStarted = Date.now(), requests = 0;
  return async (request: Request): Promise<Response> => {
    if (Date.now() - windowStarted >= 60_000) { windowStarted = Date.now(); requests = 0; }
    if (++requests > 120) return reply({ error: { code: 'RATE_LIMITED' } }, 429);
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/api/runtime') return reply({ serviceMode: 'researcher', chainId: 11155111,
      publicRpcUrl: config.publicRpcUrl, expectedMarket: config.expectedMarket, registry: config.registry,
      registryFirstBlock: String(config.registryFirstBlock), writesEnabled: config.writesEnabled,
      privateRetentionDays: policy.privateRetentionDays, sponsorship: null });
    if (request.method !== 'POST' || path !== '/api/plan') return reply({ error: { code: 'NOT_FOUND' } }, 404);
    if (request.headers.get('origin') !== config.origin) return reply({ error: { code: 'FORBIDDEN' } }, 403);
    try {
      const input = await readJson(request, 512); exact(input, ['t1', 't2']);
      if (![input.t1, input.t2].every(value => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value))) return reply({ error: { code: 'INVALID_WINDOW' } }, 400);
      await checkDeployment(config.pub, config.expectedMarket, config.registry, config.artifact);
      const plan = await createPlan(config.pub, { expectedMarket: config.expectedMarket, registry: config.registry, t1: BigInt(String(input.t1)), t2: BigInt(String(input.t2)) });
      return new Response(encodeWire(plan), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    } catch { return reply({ error: { code: 'PLAN_UNAVAILABLE' } }, 503); }
  };
}
