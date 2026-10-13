import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sepoliaSubmissionsEnabled, developmentConnection } from '../scripts/lib/submission-settings.mjs';
import { developmentApiRewrites } from '../scripts/lib/development-rewrites.mjs';

test('Sepolia submission requires explicit opt-in and complete public browser configuration', () => {
  assert.equal(sepoliaSubmissionsEnabled({}), false);
  assert.equal(sepoliaSubmissionsEnabled({ SEPOLIA_SUBMISSIONS: 'false' }), false);
  assert.equal(sepoliaSubmissionsEnabled({ SEPOLIA_SUBMISSIONS: 'true' }), true);
  for (const value of ['1', 'yes', 'TRUE']) assert.throws(() => sepoliaSubmissionsEnabled({ SEPOLIA_SUBMISSIONS: value }));
  assert.equal(developmentConnection({ RPC_URL: 'https://private.example/secret' }), undefined);
  assert.throws(() => developmentConnection({ DEV_ORIGIN: 'http://other.example:3000' }), /loopback/);
  assert.throws(() => developmentConnection({ DEV_ORIGIN: 'https://localhost:3000' }), /HTTP/);
  assert.throws(() => developmentConnection({ SEPOLIA_SUBMISSIONS: 'true', RPC_URL: 'https://private.example/secret' }), /PUBLIC_RPC_URL|configured/);
  const environment = { SEPOLIA_SUBMISSIONS: 'true', RPC_URL: 'https://private.example/secret', PUBLIC_RPC_URL: 'https://public.example', EXPECTED_MARKET: '0x' + '12'.repeat(20), REGISTRY_ADDRESS: '0x' + '34'.repeat(20), REGISTRY_FIRST_BLOCK: '0', RELAYER_KEY: 'private sentinel' };
  const connection = developmentConnection(environment);
  assert.equal(connection.origin, 'http://localhost:3000');
  assert.equal(connection.writesEnabled, true);
  assert.equal(connection.registryFirstBlock, 0n);
  assert.equal(Object.hasOwn(connection, 'RELAYER_KEY'), false);
  assert.throws(() => developmentConnection({ ...environment, DEV_ORIGIN: 'http://other.example:3000' }), /loopback/);
  assert.throws(() => developmentConnection({ ...environment, PUBLIC_RPC_URL: 'https://user:secret@rpc.example' }), /public HTTPS/);
});

test('Next development proxies only runtime and planning to an explicit loopback backend', () => {
  assert.deepEqual(developmentApiRewrites('phase-production-build', { PLUTO_DEV_API_ORIGIN: 'http://127.0.0.1:4567' }), { beforeFiles: [] });
  assert.deepEqual(developmentApiRewrites('phase-development-server', {}), { beforeFiles: [] });
  const result = developmentApiRewrites('phase-development-server', { PLUTO_DEV_API_ORIGIN: 'http://127.0.0.1:4567' });
  assert.deepEqual(result.beforeFiles.map(rule => rule.source), ['/api/runtime', '/api/plan']);
  assert.equal(result.beforeFiles[1].destination, 'http://127.0.0.1:4567/api/plan');
  assert.throws(() => developmentApiRewrites('phase-development-server', { PLUTO_DEV_API_ORIGIN: 'https://foreign.example' }), /loopback/);
});
