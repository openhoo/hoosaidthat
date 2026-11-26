import { AT_DRIVER_REQUEST_TIMEOUT_MS } from '../../dist/native-timeouts.js';

// JAWS uses the W3C AT Driver userIntent command; the experimental VoiceOver
// transport predates that command. Both report real interaction.capturedOutput events.
export class ATDriver {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #failure;
  #onSpeech;
  #sessionId;
  capabilities;

  static async connect(endpoint, screenReader, { WebSocketClass = globalThis.WebSocket, timeoutMs = 10000 } = {}) {
    if (!['jaws', 'voiceover'].includes(screenReader)) throw new Error('AT Driver requires JAWS or VoiceOver');
    const url = new URL(endpoint);
    if ((url.protocol !== 'ws:' && url.protocol !== 'wss:') || url.username || url.password || url.hash || url.search ||
      (url.protocol === 'ws:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
      throw new Error('AT Driver must use loopback ws:// or secure wss:// without embedded credentials');
    }
    if (screenReader === 'jaws' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('JAWS AT Driver must run on the same Windows guest');
    if (!WebSocketClass) throw new Error('the native bridge requires Node.js 22 or later (WebSocket API)');
    const driver = new ATDriver(new WebSocketClass(url.href));
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('AT Driver connection timed out')), timeoutMs);
        driver.#socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
        driver.#socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('AT Driver connection failed')); }, { once: true });
      });
      const result = await driver.request('session.new', {
        // The JAWS Remote Command Server implements the ARIA-AT harness dialect.
        // Negotiate first, then verify the actual reader and platform it returned.
        capabilities: screenReader === 'jaws' ? {} : { alwaysMatch: { atName: 'VoiceOver', platformName: 'macos' } },
      });
      const caps = result?.capabilities;
      if (typeof result?.sessionId !== 'string' || !result.sessionId || !caps || typeof caps.atName !== 'string' ||
        typeof caps.atVersion !== 'string' || !caps.atVersion.trim() || typeof caps.platformName !== 'string' ||
        !(screenReader === 'jaws' ? ['windows', 'win32'] : ['macos', 'darwin']).includes(caps.platformName?.toLowerCase()) ||
        caps.atName.toLowerCase() !== screenReader) {
        throw new Error('AT Driver did not negotiate the requested screen reader and platform');
      }
      driver.#sessionId = result.sessionId;
      driver.capabilities = caps;
      if (screenReader === 'jaws') {
        // These are the settings the upstream ARIA-AT harness uses on its dedicated guest.
        await driver.request('settings.setSettings', { settings: [
          { name: 'jcf:default:HTML:SayAllOnDocumentLoad', value: '0' },
          { name: 'jcf:default:options:TypingEcho', value: '0' },
          { name: 'jcf:default:options:DisplayStartupWizard', value: '0' },
        ] });
      }
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
          if (message.params.sessionId !== undefined && message.params.sessionId !== this.#sessionId) return;
          // JAWS wraps synthesized control types and states in U+001D/U+001E.
          // Keep their words, omit the non-spoken formatting delimiters.
          const text = this.capabilities?.atName.toLowerCase() === 'jaws'
            ? message.params.data.replace(/[\u001d\u001e]/g, ' ').replace(/\s+/g, ' ').trim() : message.params.data;
          if (text.trim()) this.#onSpeech?.(text);
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
    for (const keys of chords) {
      if (this.capabilities.atName.toLowerCase() === 'jaws') await this.request('interaction.userIntent', { name: 'pressKeys', keys });
      else await this.request('interaction.pressKeys', { keys });
    }
  }
  request(method, params) {
    this.assertReady();
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(new Error('AT Driver command timed out; restart the bridge')), AT_DRIVER_REQUEST_TIMEOUT_MS);
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
