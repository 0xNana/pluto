import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hexToBytes, keccak256, decodeEventLog, toHex } from 'viem';
import * as sdk from '@nillion/covenants-sdk';
import * as browser from '@nillion/covenants-sdk/browser';
import { compileDisclosureWindow, encodeDisclosurePayload } from '../src/shared/disclosure.mjs';
import { assertProbeLimits } from '../src/chain/feasibility.mjs';
import { compileContracts } from '../scripts/lib/contracts.mjs';
import { evmHarness } from './support/evm.mjs';

test('M0 SDK entry points exist at supported root and browser exports', () => {
  for (const name of ['resolveAddresses', 'selectCommittee', 'deriveLivePin', 'quoteEscrow',
    'postSealed', 'postSponsored', 'signPostAuthorization']) {
    assert.equal(typeof sdk[name], 'function', `root ${name}`);
    assert.equal(typeof browser[name], 'function', `browser ${name}`);
  }
  for (const name of ['triggerMarketAbi', 'protocolConfigAbi', 'nodeRegistryAbi', 'authVerifierAbi']) {
    assert.ok(Array.isArray(sdk[name]));
  }
});

test('M0 payload and committee obey live limits and SDK wire overhead', () => {
  const limits = { maxM: 3, maxPlaintextBytes: 96n, maxCiphertextBytes: 690n,
    layerOverheadPublicBytes: 134n, defaultHookGas: 250000, maxHookGas: 8000000 };
  assert.equal(assertProbeLimits(limits, { m: 3, k: 2 }), 230n);
  for (const changes of [{ maxM: 2 }, { maxPlaintextBytes: 95n }, { maxCiphertextBytes: 689n },
    { layerOverheadPublicBytes: 135n }, { defaultHookGas: 0 }, { defaultHookGas: 8000001 }]) {
    assert.throws(() => assertProbeLimits({ ...limits, ...changes }, { m: 3, k: 2 }));
  }
  for (const size of [{ m: 2, k: 2 }, { m: 3, k: 0 }, { m: 3.5, k: 2 }]) {
    assert.throws(() => assertProbeLimits(limits, size));
  }
});

test('M0 seals the 64-byte public-window payload and reconstructs with each k-subset', () => {
  const window = compileDisclosureWindow({ nowUnix: 1000n, t1: 1600n, t2: 5200n });
  const payload = encodeDisclosurePayload(new Uint8Array(32).fill(7), `0x${'08'.repeat(32)}`);
  // Synthetic node secrets are fixture data, never live committee keys.
  const secrets = [1, 2, 3].map(value => new Uint8Array(32).fill(value));
  const sealed = sdk.seal(payload, window.mode, window.conditionRecord, 2, secrets.map(sdk.mpkFromSecret));
  assert.deepEqual(sealed.publicCondition, window.conditionRecord);
  assert.equal(sdk.maxLayerLen(sealed.layers), 230n);
  const shares = sealed.layers.map((layer, index) => sdk.openLayer(layer, secrets[index], hexToBytes(sealed.commit), window.mode).share);
  for (const indexes of [[0, 1], [0, 2], [1, 2]]) {
    const plaintext = sdk.reconstruct(indexes.map(index => shares[index]));
    assert.equal(plaintext.length, 96);
    assert.deepEqual(plaintext.slice(0, 64), payload);
    assert.deepEqual(plaintext.slice(64), sealed.nonce);
    assert.equal(keccak256(plaintext), sealed.commit);
  }
});

test('T-11 local emitted market events decode through the installed SDK ABI', async () => {
  // Build the emitter from the ABI, including its full field order and indexing.
  const event = sdk.triggerMarketAbi.find(item => item.type === 'event' && item.name === 'TriggerPosted');
  const declaration = event.inputs.map(input => `${input.type}${input.indexed ? ' indexed' : ''} ${input.name}`).join(', ');
  const fixture = { content: `// SPDX-License-Identifier: MIT
    pragma solidity ^0.8.30;
    contract EventProbe {
      event TriggerPosted(${declaration});
      function emitPost() external {
        uint256[] memory ids = new uint256[](3); ids[0] = 11; ids[1] = 12; ids[2] = 13;
        bytes[] memory layers = new bytes[](3);
        emit TriggerPosted(9, msg.sender, 1, ids, 2, 5200, bytes32(uint256(42)), 90, 1600, 5200, hex"1234", layers);
      }
    }` };
  const artifacts = await compileContracts({ 'EventProbe.sol': fixture });
  const chain = await evmHarness();
  const emitter = await chain.deploy(artifacts.EventProbe);
  await chain.call(emitter, 'emitPost');
  const log = chain.result().execResult.logs[0];
  const decoded = decodeEventLog({ abi: sdk.triggerMarketAbi, topics: log[1].map(toHex), data: toHex(log[2]) });
  assert.equal(decoded.eventName, 'TriggerPosted');
  assert.equal(decoded.args.triggerId, 9n);
  assert.equal(decoded.args.author.toLowerCase(), chain.author);
  assert.deepEqual(decoded.args.keyIds, [11n, 12n, 13n]);
  assert.equal(decoded.args.t1, 1600n);
  assert.equal(decoded.args.t2, 5200n);
});
