import assert from 'node:assert/strict';
import test from 'node:test';
import { ATDriver } from '../native/at-driver.mjs';
import { KEY, nativeCommands } from '../native/commands.mjs';

const endpoint = 'ws://127.0.0.1:9002/session';

// Shapes from the W3C ARIA-AT JAWS harness, including vendor output markers
// and speech arriving before the acknowledgement for the associated gesture.
function host(capabilities = { atName: 'JAWS', atVersion: '2027.2610.428.400', platformName: 'Windows' }) {
  return class extends EventTarget {
    static instance;
    requests = [];
    constructor() { super(); this.constructor.instance = this; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    emit(payload) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) })); }
    send(raw) {
      const { id, method, params } = JSON.parse(raw);
      this.requests.push({ method, params });
      queueMicrotask(() => {
        let result = {};
        if (method === 'session.new') result = { sessionId: 'jfw-1', capabilities };
        else if (method === 'interaction.userIntent') {
          this.emit({ method: 'interaction.capturedOutput', params: { sessionId: 'unrelated', data: 'other desktop' } });
          this.emit({ method: 'interaction.capturedOutput', params: { sessionId: 'jfw-1', data: ' Checkout \u001d heading level two\u001e  ' } });
          this.emit({ method: 'interaction.capturedOutput', params: { sessionId: 'jfw-1', data: ' \u001d \u001e ' } });
        }
        this.emit({ id, result });
      });
    }
    close() { this.dispatchEvent(new Event('close')); }
  };
}

test('JAWS receives native key intents and records only spoken text from the negotiated session', async () => {
  const Socket = host();
  const driver = await ATDriver.connect(endpoint, 'jaws', { WebSocketClass: Socket });
  try {
    const output = [];
    driver.onSpeech(text => output.push(text));
    await driver.press(nativeCommands('jaws').previousHeading2);
    assert.deepEqual(output, ['Checkout heading level two']);
    assert.deepEqual(Socket.instance.requests.map(({ method }) => method), ['session.new', 'settings.setSettings', 'interaction.userIntent']);
    assert.deepEqual(Socket.instance.requests.at(-1).params, { name: 'pressKeys', keys: [KEY.shift, '2'] });
  } finally { driver.close(); }
  assert.throws(() => driver.assertReady(), /disconnected|closed/);
});

test('JAWS rejects a mismatched reader, another platform, and a driver outside the guest', async () => {
  for (const capabilities of [
    { atName: 'NVDA', atVersion: '2026.1.1', platformName: 'Windows' },
    { atName: 'JAWS', atVersion: '2027', platformName: 'macos' },
    { atName: 'JAWS', atVersion: '', platformName: 'Windows' },
  ]) await assert.rejects(ATDriver.connect(endpoint, 'jaws', { WebSocketClass: host(capabilities) }), /did not negotiate/);
  await assert.rejects(ATDriver.connect('wss://other.invalid/session', 'jaws'), /same Windows guest/);
});

test('JAWS advertises desktop keys only when they implement that action', () => {
  const actions = nativeCommands('jaws');
  assert.deepEqual(actions.nextHeading, [['h']]);
  assert.deepEqual(actions.previousTableRow, [[KEY.control, KEY.alt, KEY.up]]);
  assert.deepEqual(actions.elementsList, [[KEY.insert, KEY.f3]]);
  for (const unsupported of ['nextLink', 'nextHeading7', 'nextCombobox', 'brailleRoute']) assert.equal(actions[unsupported], undefined);
});
