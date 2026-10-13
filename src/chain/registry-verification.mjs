import { getAddress, hexToBytes, keccak256, padHex, parseEventLogs, toHex } from 'viem';
import { DeploymentError } from '../shared/errors.mjs';

// solc leaves immutable placeholders in its runtime template. Mask only the
// compiler-declared offsets; the getter independently verifies their market value.
export async function verifyHookDeployment(pub, hook, artifact, market) {
  const code = await pub.getBytecode({ address: hook });
  if (!code || code === '0x' || code.length !== artifact.runtimeBytecode.length || !artifact.immutableReferences) {
    throw new DeploymentError('Deployed hook runtime does not match the compiled artifact');
  }
  const actual = hexToBytes(code);
  const template = hexToBytes(artifact.runtimeBytecode);
  if (Object.keys(artifact.immutableReferences).length !== 1) throw new DeploymentError('Hook artifact must have only the immutable market');
  for (const reference of Object.values(artifact.immutableReferences).flat()) {
    if (!Number.isSafeInteger(reference.start) || reference.start < 0 || reference.length !== 32
        || reference.start + reference.length > actual.length) throw new DeploymentError('Invalid immutable runtime reference');
    if (toHex(actual.slice(reference.start, reference.start + reference.length)) !== padHex(market.toLowerCase(), { size: 32 })) {
      throw new DeploymentError('Deployed hook immutable market differs from C0');
    }
    actual.fill(0, reference.start, reference.start + reference.length);
    template.fill(0, reference.start, reference.start + reference.length);
  }
  if (toHex(actual) !== toHex(template)) throw new DeploymentError('Deployed hook runtime does not match the compiled artifact');
  const recorded = await pub.readContract({ address: hook, abi: artifact.abi, functionName: 'market' });
  if (getAddress(recorded) !== getAddress(market)) throw new DeploymentError('Deployed hook immutable market differs from C0');
  return { runtimeMatches: true, runtimeHash: keccak256(code), market: getAddress(recorded), compiler: artifact.compiler };
}

const equalHex = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

export function verifyRegistryReceipt(receipt, hook, abi, eventName, expected) {
  if (receipt.status !== 'success') throw new DeploymentError('Registry receipt reverted');
  const logs = parseEventLogs({ abi, eventName, strict: true,
    logs: receipt.logs.filter(log => equalHex(log.address, hook)) });
  if (logs.length !== 1) throw new DeploymentError('Registry receipt must contain exactly one matching event');
  const args = logs[0].args;
  const matches = equalHex(args.reportId, expected.reportId) && (eventName === 'Registered'
    ? equalHex(args.researcher, expected.researcher) && equalHex(args.cipherHash, expected.cipherHash)
      && equalHex(args.keyCommit, expected.keyCommit) && args.t1 === BigInt(expected.window.t1) && args.t2 === BigInt(expected.window.t2)
    : eventName === 'Bound' && args.triggerId === BigInt(expected.triggerId));
  if (!matches) throw new DeploymentError('Registry event differs from the authorized report');
  return { event: eventName, reportId: args.reportId, ...(eventName === 'Bound' ? { triggerId: args.triggerId } : {}) };
}

export async function verifyRegistryBinding(pub, hook, abi, expected) {
  const [record, binding] = await Promise.all([
    pub.readContract({ address: hook, abi, functionName: 'statusOf', args: [expected.reportId] }),
    pub.readContract({ address: hook, abi, functionName: 'bindings', args: [BigInt(expected.triggerId)] }),
  ]);
  if (!equalHex(record.researcher, expected.researcher) || !equalHex(record.cipherHash, expected.cipherHash)
      || !equalHex(record.keyCommit, expected.keyCommit) || record.t1 !== BigInt(expected.window.t1)
      || record.t2 !== BigInt(expected.window.t2) || !binding[1] || !equalHex(binding[0], expected.reportId)) {
    throw new DeploymentError('On-chain registry does not match the authorized report and binding');
  }
  return { bound: true, reportId: expected.reportId, triggerId: BigInt(expected.triggerId),
    registeredAt: record.registeredAt, bindTime: record.bindTime };
}
