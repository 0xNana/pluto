import { parseArgs } from 'node:util';
import { createWalletClient, getAddress, hexToBytes, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { DeploymentError, resolveSepolia } from '../src/chain/deployment.mjs';
import { verifyHookDeployment } from '../src/chain/registry-verification.mjs';
import { bindReport, postReport, readReportStatus, verifyDisclosedReport } from '../src/chain/researcher-flow.mjs';
import { prepareReport, ReportError } from '../src/shared/report-crypto.mjs';
import { compileContracts } from './lib/contracts.mjs';
import { probeClient, publicFailure, receiptEvidence } from './lib/probe-runtime.mjs';
import { formatJson, openJournal, readBundle, readJournal, readLimited, writeExclusiveFiles } from './lib/researcher-files.mjs';

const commands = {
  prepare: ['report', 'researcher', 'out', 'ciphertext'],
  'deploy-registry': ['journal'],
  post: ['bundle', 'registry', 't1', 't2', 'journal'],
  retry: ['bundle', 'parent-journal', 't1', 't2', 'journal'],
  bind: ['bundle', 'journal'],
  status: ['registry', 'report-id'],
  verify: ['journal', 'ciphertext', 'out'],
};
const usage = `Researcher CLI (Node 24)
  prepare --report FILE --researcher ADDRESS --out RECOVERY.json --ciphertext REPORT.bin
  deploy-registry --journal DEPLOY.jsonl
  post --bundle RECOVERY.json --registry ADDRESS --t1 UNIX --t2 UNIX --journal REPORT.jsonl
  retry --bundle RECOVERY.json --parent-journal REPORT.jsonl --t1 UNIX --t2 UNIX --journal RETRY.jsonl
  bind --bundle RECOVERY.json --journal REPORT.jsonl
  status --registry ADDRESS --report-id BYTES32
  verify --journal REPORT.jsonl --ciphertext REPORT.bin --out DECRYPTED.bin
Writes use AUTHOR_KEY from the environment and spend Sepolia ETH/NIL.
RPC reads require RPC_URL and EXPECTED_MARKET. Prepare is offline.
Recovery files contain K: retain privately. Outputs are exclusive; existing files are refused.`;

function wallet() {
  if (!/^0x[0-9a-fA-F]{64}$/.test(process.env.AUTHOR_KEY ?? '')) {
    throw new DeploymentError('Set AUTHOR_KEY in the environment for transaction commands');
  }
  return createWalletClient({ account: privateKeyToAccount(process.env.AUTHOR_KEY), chain: sepolia,
    transport: http(process.env.RPC_URL, { timeout: 10000, retryCount: 0 }) });
}

function seconds(value) {
  if (!/^[0-9]{1,20}$/.test(value)) throw new DeploymentError('Window values must be unsigned Unix seconds');
  return BigInt(value);
}

export async function runResearcher(args, print = console.log) {
  const command = args[0];
  if (command === '--help' || command === 'help') { print(usage); return; }
  if (!commands[command]) throw new DeploymentError(usage);
  let values;
  try {
    ({ values } = parseArgs({ args: args.slice(1), strict: true,
      options: Object.fromEntries(commands[command].map(name => [name, { type: 'string' }])) }));
  } catch { throw new DeploymentError('Unsupported command options; run researcher --help'); }
  if (commands[command].some(name => !values[name])) throw new DeploymentError(usage);
  if (command === 'prepare') {
    const bundle = await prepareReport(await readLimited(values.report), getAddress(values.researcher));
    await writeExclusiveFiles([[values.out, formatJson(bundle) + '\n'], [values.ciphertext, hexToBytes(bundle.ciphertext)]]);
    print(formatJson({ recoveryFile: values.out, ciphertextFile: values.ciphertext,
      researcher: bundle.researcher, reportId: bundle.reportId, cipherHash: bundle.cipherHash, keyCommit: bundle.keyCommit }));
    return;
  }
  const pub = probeClient();
  const expectedMarket = process.env.EXPECTED_MARKET;
  const artifacts = await compileContracts();
  const registryAt = address => ({ address: getAddress(address), abi: artifacts.DisclosureRegistry.abi });
  if (command === 'status') {
    print(formatJson(await readReportStatus({ pub, registry: registryAt(values.registry),
      expectedMarket, reportId: values['report-id'] })));
    return;
  }
  if (command === 'verify') {
    const state = await readJournal(values.journal);
    const result = await verifyDisclosedReport({ pub, registry: registryAt(state.registry), expectedMarket,
      reportId: state.reportId, fromBlock: state.registrationBlock,
      ciphertext: await readLimited(values.ciphertext, 1048610) });
    await writeExclusiveFiles([[values.out, result.plaintext]]);
    print(formatJson({ reportId: result.reportId, triggerId: result.triggerId,
      disclosureBlock: result.block, decryptedFile: values.out, bytes: result.plaintext.length }));
    return;
  }
  const signer = wallet();
  if (command === 'deploy-registry') {
    const addresses = await resolveSepolia(pub, expectedMarket);
    const journal = await openJournal(values.journal);
    const state = { version: 1, chainId: sepolia.id, market: addresses.market, transactions: [] };
    try {
      const hash = await signer.deployContract({ abi: artifacts.DisclosureRegistry.abi,
        bytecode: artifacts.DisclosureRegistry.bytecode, args: [addresses.market] });
      state.transactions.push({ call: 'deploy', hash });
      await journal.save(state);
      const receipt = await pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success' || !receipt.contractAddress) {
        throw new DeploymentError('Registry deployment failed; inspect the saved transaction hash');
      }
      Object.assign(state, { registry: receipt.contractAddress, receipt: receiptEvidence(receipt) });
      await journal.save(state);
      const verification = await verifyHookDeployment(pub, receipt.contractAddress, artifacts.DisclosureRegistry, addresses.market);
      print(formatJson({ ...state, deploymentVerification: verification }));
    } finally { await journal.close(); }
    return;
  }
  const bundle = await readBundle(values.bundle);
  const state = command === 'bind' ? await readJournal(values.journal) : undefined;
  const parentJournal = command === 'retry' ? await readJournal(values['parent-journal']) : undefined;
  const registry = registryAt(state?.registry ?? parentJournal?.registry ?? values.registry);
  const journal = await openJournal(values.journal, { resume: command === 'bind' });
  try {
    const options = { pub, wallet: signer, registry, expectedMarket, bundle, onProgress: journal.save };
    const result = command === 'post' || command === 'retry'
      ? await postReport({ ...options, parentJournal, t1: seconds(values.t1), t2: seconds(values.t2) })
      : await bindReport({ ...options, journal: state });
    print(formatJson(result));
  } finally { await journal.close(); }
}

if (import.meta.main) await runResearcher(process.argv.slice(2)).catch(error => {
  // Never print raw filesystem/RPC exceptions, bundle contents, key arguments or calldata.
  const failure = error instanceof ReportError ? { detail: error.message }
    : error.code === 'EEXIST' ? { detail: 'Output already exists; use bind to recover a submitted post, or choose fresh preparation outputs' }
    : publicFailure(error);
  console.error(formatJson({ status: 'failed', ...failure }));
  process.exitCode = 1;
});
