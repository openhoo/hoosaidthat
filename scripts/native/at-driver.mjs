// Client for the W3C AT Driver draft: session.new, interaction.pressKeys,
// and interaction.capturedOutput. No keyboard or speech is synthesized by HST.
export class ATDriver {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #failure;
  #onSpeech;
  capabilities;

  static async connect(endpoint, screenReader, { WebSocketClass = globalThis.WebSocket, timeoutMs = 10000 } = {}) {
    if (screenReader !== 'voiceover') throw new Error('AT Driver currently supports VoiceOver only');
    const url = new URL(endpoint);
    if ((url.protocol !== 'ws:' && url.protocol !== 'wss:') || url.username || url.password || url.hash || url.search ||
      (url.protocol === 'ws:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
      throw new Error('AT Driver must use loopback ws:// or secure wss:// without embedded credentials');
    }
    if (!WebSocketClass) throw new Error('the native bridge requires Node.js 22 or later (WebSocket API)');
    const driver = new ATDriver(new WebSocketClass(url.href));
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('AT Driver connection timed out')), timeoutMs);
        driver.#socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
        driver.#socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('AT Driver connection failed')); }, { once: true });
      });
      const result = await driver.request('session.new', {
        capabilities: { alwaysMatch: { atName: 'VoiceOver', platformName: 'macos' } },
      });
      const caps = result?.capabilities;
      if (!result?.sessionId || !caps || typeof caps.atName !== 'string' || typeof caps.atVersion !== 'string' ||
        !['macos', 'darwin'].includes(caps.platformName) ||
        caps.atName.toLowerCase() !== screenReader) {
        throw new Error('AT Driver did not negotiate the requested screen reader and platform');
      }
      driver.capabilities = caps;
      return driver;
    } catch (error) {
      driver.close();
      throw error;
    }
  }

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', event => {
      try {
        if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 65536) throw new Error('invalid or oversized AT Driver message');
        const message = JSON.parse(event.data);
        if (message.method === 'interaction.capturedOutput') {
          if (typeof message.params?.data !== 'string' || Buffer.byteLength(message.params.data) > 16384) throw new Error('invalid AT Driver speech event');
          this.#onSpeech?.(message.params.data);
        } else if (Number.isSafeInteger(message.id)) {
          const pending = this.#pending.get(message.id);
          if (!pending) return;
          this.#pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(`AT Driver: ${message.error}`));
          else if (!message.result || typeof message.result !== 'object') pending.reject(new Error('invalid AT Driver response'));
          else pending.resolve(message.result);
        } else throw new Error('unrecognized AT Driver message');
      } catch (error) { this.#fail(error); }
    });
    socket.addEventListener('close', () => this.#fail(new Error('AT Driver disconnected')));
    socket.addEventListener('error', () => this.#fail(new Error('AT Driver connection failed')));
  }

  onSpeech(callback) { this.#onSpeech = callback; }
  assertReady() { if (this.#failure) throw this.#failure; }
  async press(chords) {
    for (const keys of chords) await this.request('interaction.pressKeys', { keys });
  }
  request(method, params) {
    this.assertReady();
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(new Error('AT Driver command timed out; restart the bridge')), 10000);
      this.#pending.set(id, { resolve, reject, timer });
      try { this.#socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { this.#fail(error); }
    });
  }
  close() { this.#socket.close(); this.#fail(new Error('AT Driver closed')); }
  #fail(error) {
    this.#failure ??= error;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.#failure);
    }
    this.#pending.clear();
  }
}
