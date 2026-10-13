// Chromium's --remote-debugging-pipe uses NUL-delimited JSON on descriptors 3/4.
// No listening debug port, external page, or user browser profile is involved.
import { StringDecoder } from 'node:string_decoder';

export class DevToolsPipe {
  #input; #pending = new Map(); #next = 0; #closed = false;
  constructor(input, output, timeout = 15000) {
    this.#input = input; this.timeout = timeout;
    this.onEvent = () => {};
    const decoder = new StringDecoder('utf8'); let buffered = '';
    output.on('data', bytes => {
      buffered += decoder.write(bytes);
      if (buffered.length > 8_000_000) { this.close('DevTools frame too large'); return; }
      let end;
      while ((end = buffered.indexOf('\0')) !== -1) {
        const frame = buffered.slice(0, end); buffered = buffered.slice(end + 1);
        try {
          const response = JSON.parse(frame), pending = this.#pending.get(response.id);
          if (!pending) { if (response.method) this.onEvent(response.method, response.sessionId, response.params); continue; }
          this.#pending.delete(response.id); clearTimeout(pending.timer);
          if (response.error) pending.reject(new Error(`DevTools command failed: ${pending.method}`));
          else pending.resolve(response.result);
        } catch { this.close('Invalid DevTools frame'); return; }
      }
    });
    output.on('end', () => this.close());
    output.on('error', () => this.close('DevTools pipe failed'));
    input.on('error', () => this.close('DevTools pipe failed'));
  }
  send(method, params = {}, sessionId) {
    if (this.#closed) return Promise.reject(new Error('DevTools pipe closed'));
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`DevTools command timed out: ${method}`)); }, this.timeout);
      this.#pending.set(id, { resolve, reject, timer, method });
      this.#input.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
  }
  close(message = 'DevTools pipe closed') {
    this.#closed = true;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
    this.#pending.clear();
  }
}
