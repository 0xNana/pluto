import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { DevToolsPipe } from '../scripts/lib/devtools-pipe.mjs';

test('DevTools pipe correlates fragmented UTF-8 replies and flattened target sessions', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const client = new DevToolsPipe(input, output, 1000);
  const events = [];
  client.onEvent = (method, session) => events.push({ method, session });
  let sent = '';
  input.on('data', chunk => { sent += chunk.toString(); });
  const first = client.send('Runtime.evaluate', { expression: 'true' }, 'tab-1');
  const second = client.send('Browser.getVersion');
  const commands = sent.split('\0').filter(Boolean).map(JSON.parse);
  assert.equal(commands[0].sessionId, 'tab-1');
  const bytes = Buffer.from(JSON.stringify({ id: commands[0].id, result: { value: '✓' } }) + '\0');
  const split = bytes.indexOf(Buffer.from('✓')) + 1;
  output.write(bytes.subarray(0, split));
  output.write(Buffer.concat([bytes.subarray(split), Buffer.from(JSON.stringify({ id: commands[1].id, result: { product: 'fixture' } }) + '\0')]));
  assert.deepEqual(await first, { value: '✓' });
  assert.deepEqual(await second, { product: 'fixture' });
  output.write(JSON.stringify({ method: 'Runtime.exceptionThrown', sessionId: 'tab-1', params: { private: 'fixture' } }) + '\0');
  assert.deepEqual(events, [{ method: 'Runtime.exceptionThrown', session: 'tab-1' }]);
  client.close();
});

test('DevTools failure rejects outstanding commands without leaking remote error text', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const client = new DevToolsPipe(input, output, 1000);
  const denied = client.send('Runtime.evaluate');
  output.write(JSON.stringify({ id: 1, error: { message: 'private fixture material' } }) + '\0');
  await assert.rejects(denied, error => error.message === 'DevTools command failed: Runtime.evaluate');
  const interrupted = client.send('Page.navigate');
  output.end();
  await assert.rejects(interrupted, /DevTools pipe closed/);
  await assert.rejects(client.send('Browser.getVersion'), /closed/);
  client.close();
});

test('DevTools malformed frames and deadlines fail explicitly without hanging', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const client = new DevToolsPipe(input, output, 20);
  await assert.rejects(client.send('Browser.getVersion'), /timed out/);
  const pending = client.send('Page.enable');
  output.write('invalid-json\0');
  await assert.rejects(pending, /Invalid DevTools frame/);
  client.close();
});
