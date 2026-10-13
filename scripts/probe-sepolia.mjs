import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import sdkPackage from '@nillion/covenants-sdk/package.json' with { type: 'json' };
import { DeploymentError } from '../src/chain/deployment.mjs';
import { runDeploymentProbe } from '../src/chain/deployment-probe.mjs';
import { json, probeClient, publicFailure } from './lib/probe-runtime.mjs';

const usage = 'Usage: probe:sepolia -- [--out EVIDENCE.json] [--event-tx CURRENT_MARKET_TX_HASH]';

// Dependency injection keeps command/file/error paths testable without submitting transactions.
export async function runProbeCommand(args, { client = probeClient, expectedMarket = process.env.EXPECTED_MARKET,
  print = console.log, diagnostic = console.error } = {}) {
  let evidence = { status: 'failed', chainId: 11155111, sdkVersion: sdkPackage.version, failedStage: 'configuration' };
  let outputPath;
  let ownsOutput = false;
  const save = async snapshot => {
    evidence = snapshot;
    await writeFile(outputPath, json(evidence) + '\n', { mode: 0o600 });
  };
  try {
    let values;
    try { ({ values } = parseArgs({ args, strict: true, options: {
      out: { type: 'string' }, 'event-tx': { type: 'string' }, help: { type: 'boolean' },
    } })); } catch { throw new DeploymentError(usage); }
    if (values.help) { print(usage); return 0; }
    if (values['event-tx'] !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(values['event-tx'])) {
      throw new DeploymentError('Event transaction must be a bytes32 hash');
    }
    outputPath = resolve(values.out ?? `artifacts/p02/probe-${randomUUID()}.json`);
    await mkdir(dirname(outputPath), { recursive: true });
    // Refuse an existing path, including .env or earlier evidence; subsequent writes update this run only.
    await writeFile(outputPath, json(evidence) + '\n', { mode: 0o600, flag: 'wx' });
    ownsOutput = true;
    const result = await runDeploymentProbe(client(), expectedMarket, {
      eventTx: values['event-tx'], onProgress: async snapshot => {
        await save(snapshot);
        diagnostic(`Sepolia probe: ${snapshot.stage}`);
      },
    });
    await save(result);
    print(json({ evidenceFile: outputPath, ...result }));
    if (result.status === 'incomplete') diagnostic('Event acceptance is pending; supply --event-tx for a current-market receipt. No transaction was sent.');
    return result.status === 'passed' ? 0 : 2;
  } catch (error) {
    const failure = error.code === 'EEXIST' ? { detail: 'Evidence output already exists; choose a fresh --out path', codes: ['EEXIST'] }
      : publicFailure(error.cause ?? error);
    const failed = { ...(error.evidence ?? evidence), status: 'failed',
      failedStage: error.evidence?.failedStage ?? evidence.stage ?? 'configuration', failure };
    // A storage error must still produce sanitized diagnostics rather than an unhandled exception.
    let evidenceSaved = false;
    if (ownsOutput) {
      try { await save(failed); evidenceSaved = true; } catch { failed.evidenceWriteFailed = true; }
    }
    print(json({ evidenceFile: evidenceSaved ? outputPath : undefined, ...failed }));
    diagnostic(`Sepolia probe failed at ${failed.failedStage}: ${failure.detail}. No transaction was sent.`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runProbeCommand(process.argv.slice(2));
