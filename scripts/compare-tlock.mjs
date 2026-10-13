import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { open, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareTlockComparison, observeTlockComparison, quicknet } from '../src/chain/tlock-comparison.mjs';
import { DeploymentError } from '../src/chain/deployment.mjs';
import { json, publicFailure } from './lib/probe-runtime.mjs';
import { readBundle, readJournal, readLimited, writeExclusiveFiles } from './lib/researcher-files.mjs';

const usage = `P-09 official tlock comparison (same recovery report and bound journal)
  seal --bundle RECOVERY.json --journal REPORT.jsonl --out TLOCK.json
  observe --evidence TLOCK.json --ciphertext REPORT.bin --out OBSERVATION.json [--plaintext LOCAL.bin]
Install the isolated prototype dependency first; see internal-docs/g1-comparison.md.
No chain writes. Plaintext and K stay local. Outputs are exclusive, mode 600.
Observation latency is an upper bound at the invocation time. This command never passes G1.`;

async function loadSdk() {
  const require = createRequire(new URL('../prototypes/tlock/package.json', import.meta.url));
  try {
    const manifest = require('tlock-js/package.json');
    if (manifest.version !== '0.9.0') throw new Error('version mismatch');
    const module = await import(pathToFileURL(require.resolve('tlock-js')).href);
    const sdk = module.default ?? module;
    // 0.9.0 uses the v1 drand API; avoid a relay's v2 response/redirect.
    return { ...sdk, mainnetClient() {
      const options = { disableBeaconVerification: false, noCache: false,
        chainVerificationParams: { chainHash: quicknet.hash, publicKey: quicknet.public_key } };
      const chain = new sdk.HttpCachingChain(`https://drand.cloudflare.com/${quicknet.hash}`, options);
      return new sdk.HttpChainClient(chain, options);
    } };
  } catch {
    throw new DeploymentError('Official tlock-js@0.9.0 is unavailable; install the isolated prototypes/tlock dependency');
  }
}

export async function runTlockCommand(args, services = {}) {
  const print = services.print ?? console.log;
  let output;
  let file;
  try {
    if (['help', '--help'].includes(args[0])) { print(usage); return 0; }
    const command = args[0];
    if (!['seal', 'observe'].includes(command)) throw new DeploymentError(usage);
    const names = command === 'seal' ? ['bundle', 'journal', 'out'] : ['evidence', 'ciphertext', 'out', 'plaintext'];
    let values;
    try {
      ({ values } = parseArgs({ args: args.slice(1), strict: true,
        options: Object.fromEntries(names.map(name => [name, { type: 'string' }])) }));
    } catch { throw new DeploymentError('Unsupported comparison options; run compare:tlock --help'); }
    if (names.filter(name => name !== 'plaintext').some(name => !values[name])) throw new DeploymentError(usage);
    // Reserve evidence before loading the library or performing network reads.
    await mkdir(dirname(values.out), { recursive: true, mode: 0o700 });
    file = await open(values.out, 'wx', 0o600);
    const sdk = await (services.loadSdk ?? loadSdk)();
    const context = { ...services, sdk };
    if (command === 'seal') {
      output = await prepareTlockComparison({ bundle: await readBundle(values.bundle),
        journal: await readJournal(values.journal) }, context);
    } else {
      const observed = await observeTlockComparison({
        evidence: JSON.parse(new TextDecoder().decode(await readLimited(values.evidence, 16384))),
        ciphertext: await readLimited(values.ciphertext, 1048610),
      }, context);
      output = observed.evidence;
      if (observed.plaintext && values.plaintext) await writeExclusiveFiles([[values.plaintext, observed.plaintext]]);
    }
    await file.writeFile(json(output) + '\n');
    await file.sync();
    print(json({ status: output.status, reportId: output.reportId, triggerId: output.triggerId,
      round: output.round, roundTimeUnix: output.roundTimeUnix, observation: output.observation, g1Decision: 'pending' }));
    return output.status === 'pending' ? 2 : 0;
  } catch (error) {
    const failure = error.code === 'EEXIST' ? { detail: 'Output already exists; choose a fresh evidence or plaintext path' }
      : publicFailure(error);
    const evidence = { version: 1, status: 'failed', g1Decision: 'pending', failure };
    if (file) { await file.writeFile(json(evidence) + '\n'); await file.sync(); }
    print(json(evidence));
    return 1;
  } finally { await file?.close(); }
}

if (import.meta.main) process.exitCode = await runTlockCommand(process.argv.slice(2));
