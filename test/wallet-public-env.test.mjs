import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { walletPublicEnv } from '../scripts/lib/wallet-public-env.mjs';

test('Next public wallet configuration exports PROJECT_ID without leaking private environment values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pluto-wallet-env-')), file = join(dir, '.env');
  try {
    await writeFile(file, `PROJECT_ID=${'a'.repeat(32)}\nAUTHOR_KEY=synthetic-secret\nRPC_URL=https://private.example\n`);
    assert.deepEqual(walletPublicEnv({}, file), { NEXT_PUBLIC_REOWN_PROJECT_ID: 'a'.repeat(32) });
    assert.deepEqual(walletPublicEnv({ PROJECT_ID: 'b'.repeat(32), AUTHOR_KEY: 'synthetic-secret' }, file), { NEXT_PUBLIC_REOWN_PROJECT_ID: 'b'.repeat(32) });
    assert.deepEqual(walletPublicEnv({ NEXT_PUBLIC_REOWN_PROJECT_ID: 'c'.repeat(32), PROJECT_ID: 'b'.repeat(32) }, file), { NEXT_PUBLIC_REOWN_PROJECT_ID: 'c'.repeat(32) });
    assert.deepEqual(walletPublicEnv({}, join(dir, 'absent')), { NEXT_PUBLIC_REOWN_PROJECT_ID: '' });
    assert.throws(() => walletPublicEnv({ PROJECT_ID: 'invalid' }, file), /public Reown/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
