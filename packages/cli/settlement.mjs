import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { getAddress } from 'viem';
import { triggerMarketAbi } from '@nillion/covenants-sdk';
import { SEPOLIA_CONFIG, inspectSepolia, DeploymentError } from '../../src/chain/deployment.mjs';
import { verifyHookDeployment } from '../../src/chain/registry-verification.mjs';
import { compileContracts } from '../../scripts/lib/contracts.mjs';
import { openJournal } from '../../scripts/lib/researcher-files.mjs';
import { probeClient, publicFailure, json } from '../../scripts/lib/probe-runtime.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
const usage = 'Independent local settlement: npm run settlement -- <retry-hook|reconstruct> --id UINT256 --registry ADDRESS --report-id BYTES32 --journal NEW.jsonl\nSpends the dedicated AUTHOR_KEY signer’s Sepolia ETH. Never run on a Pluto server. No automatic repeat after an ambiguous attempt.';

// No shell, arbitrary flags, downloaded package, raw child output, or server
// reconstruction. Public SDK reconstruction is confined to this local CLI.
export async function invokeSdk(command, id, env) {
  const child = spawn('npx', ['--no-install', 'covenants', command, '--id', id], {
    cwd: project, shell: false, env: { ...env, CHAIN_ID: '11155111', CONFIG_ADDRESS: SEPOLIA_CONFIG, DEPLOYMENT_JSON: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return await new Promise((resolve, reject) => {
    let size = 0, stdout = '', finished = false;
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new DeploymentError('SDK settlement timed out; inspect chain and journal before another attempt')); }, 180_000);
    const consume = (bytes, capture) => {
      size += bytes.length;
      if (size > 65_536) { child.kill('SIGTERM'); reject(new DeploymentError('SDK output limit exceeded; inspect chain and journal before another attempt')); return; }
      if (capture) stdout += bytes.toString('utf8');
    };
    child.stdout.on('data', bytes => consume(bytes, true)); child.stderr.on('data', bytes => consume(bytes, false));
    child.once('error', () => { clearTimeout(timer); reject(new DeploymentError('Cannot launch installed SDK settlement CLI')); });
    child.once('close', code => {
      clearTimeout(timer); if (finished) return; finished = true;
      // Only hashes in the SDK's transaction output format are retained. A
      // missing hash is ambiguous, including an SDK crash after broadcast.
      const hashes = [...stdout.matchAll(/(?:\btx |— )(0x[a-fA-F0-9]{64})(?=\s|$)/g)].map(match => match[1]);
      resolve({ exitCode: code, hashes: [...new Set(hashes)] });
    });
  });
}

export async function runSettlement(argv, services = {}) {
  if (['help', '--help'].includes(argv[0])) return { help: usage };
  const operation = argv[0]; if (!['retry-hook', 'reconstruct'].includes(operation)) throw new DeploymentError(usage);
  let values;
  try { ({ values } = parseArgs({ args: argv.slice(1), strict: true, allowPositionals: false,
    options: { id: { type: 'string' }, registry: { type: 'string' }, 'report-id': { type: 'string' }, journal: { type: 'string' } } })); }
  catch { throw new DeploymentError('Invalid settlement arguments; use --help'); }
  if (!values.journal || !/^(0|[1-9][0-9]{0,77})$/.test(values.id ?? '') || BigInt(values.id) >= 1n << 256n || !/^0x[a-fA-F0-9]{64}$/.test(values['report-id'] ?? '')) throw new DeploymentError('A trigger, report ID and exclusive journal are required');
  const env = services.env ?? process.env;
  if (!env.RPC_URL || !env.EXPECTED_MARKET || !/^0x[a-fA-F0-9]{64}$/.test(env.AUTHOR_KEY ?? '')) throw new DeploymentError('Set RPC_URL, EXPECTED_MARKET and a dedicated AUTHOR_KEY');
  const pub = services.pub ?? probeClient(), registry = getAddress(values.registry), id = BigInt(values.id);
  const { addresses } = await inspectSepolia(pub, env.EXPECTED_MARKET);
  const artifact = (await (services.compile ?? compileContracts)()).DisclosureRegistry;
  await verifyHookDeployment(pub, registry, artifact, addresses.market);
  const binding = await pub.readContract({ address: registry, abi: artifact.abi, functionName: 'bindings', args: [id] });
  const record = await pub.readContract({ address: registry, abi: artifact.abi, functionName: 'statusOf', args: [values['report-id']] });
  const parties = await pub.readContract({ address: addresses.market, abi: triggerMarketAbi, functionName: 'postingParties', args: [id] });
  const hook = await pub.readContract({ address: addresses.market, abi: triggerMarketAbi, functionName: 'hookMeta', args: [id] });
  if (!binding[1] || binding[0].toLowerCase() !== values['report-id'].toLowerCase() || getAddress(parties[0]) !== getAddress(record.researcher) || getAddress(hook[0]) !== registry) throw new DeploymentError('Trigger is not bound to this authenticated registry report');
  const journal = await openJournal(values.journal);
  const state = { version: 1, chainId: 11155111, operation, registry, market: addresses.market, triggerId: values.id, reportId: values['report-id'], state: 'unknown', hashes: [] };
  try {
    await journal.save(state); // Durable ambiguity marker before spawning a writer.
    const result = await (services.invoke ?? invokeSdk)(operation === 'retry-hook' ? 'retry' : operation, values.id, env);
    state.hashes = result.hashes; state.exitCode = result.exitCode;
    await journal.save(state);
    const final = await pub.readContract({ address: registry, abi: artifact.abi, functionName: 'statusOf', args: [values['report-id']] });
    // SDK acknowledgement is not evidence of application acceptance.
    state.state = final.disclosed ? 'registry-disclosed' : 'acceptance-not-confirmed';
    await journal.save(state);
    return state;
  } finally { await journal.close(); }
}

if (import.meta.main) {
  try { const result = await runSettlement(process.argv.slice(2)); console.log(result.help ?? json(result)); }
  catch (error) { console.error(json({ status: 'failed', ...publicFailure(error) })); process.exitCode = 1; }
}
