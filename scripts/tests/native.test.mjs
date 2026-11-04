import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { HttpScreenReaderClient } from '../../dist/client.js';
import { startNativeServer } from '../native/server.mjs';
import { nativeCommands, KEY } from '../native/commands.mjs';
import { ATDriver } from '../native/at-driver.mjs';
import { VoiceOverDriver, voiceOverKeyScript } from '../native/voiceover.mjs';
import { assertNativePlatform, voiceOverCursorMembership } from '../native/platform.mjs';
import { loadControlToken, parseArguments } from '../native-screen-reader.mjs';

const token = 'test-only-native-token-000000000000';
async function fixture(t, reader, options = {}) {
  let speak;
  let failure;
  const delivered = [];
  const driver = {
    onSpeech(callback) { speak = callback; },
    assertReady() { if (failure) throw failure; },
    async press(chords) { delivered.push(chords); if (!options.silent) speak('Checkout summary heading level 2'); },
    close() {},
    ...(options.drainSpeech ? { async drain() { speak('Pending asynchronous output'); } } : {}),
  };
  let foreground = true;
  let probeFailure = false;
  const bridge = await startNativeServer({ screenReader: reader, token, driver,
    quietMs: 5, actionTimeoutMs: 50,
    probe: async () => {
      if (probeFailure) throw new Error('private native probe error');
      return { version: '26.6.2',
      browserWindowActive: foreground, webContentFocused: foreground,
      focus: foreground ? { id: 'native-document', role: 'document web', name: 'Checkout', location: null } : null };
    },
    browser: { name: 'chrome', version: '151.0', cdpPort: 9225 },
  });
  t.after(() => bridge.close());
  const client = new HttpScreenReaderClient({ controlEndpoint: bridge.endpoint, cdpEndpoint: 'http://127.0.0.1:9225', controlToken: token },
    reader, 1000, { profile: `${reader}-web`, locale: 'en-US', keyboardLayout: 'desktop' });
  const request = (path, body) => fetch(bridge.endpoint + path, { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  return { bridge, client, request, delivered,
    emit(text) { speak(text); }, fail() { failure = new Error('private host failure'); },
    failProbe() { probeFailure = true; },
    blur() { foreground = false; } };
}

for (const reader of ['voiceover', 'talkback']) {
  test(`${reader}: HTTP client round trip preserves native identity, actual driver speech and artifact integrity`, async t => {
    const f = await fixture(t, reader);
    const health = await f.client.health();
    assert.equal(health.screenReader.name, reader);
    assert.equal(health.profile, `${reader}-web`);
    assert.equal(health.platform, reader === 'talkback' ? 'android' : 'macos');
    assert.equal(health.screenReader.capture, reader === 'talkback' ? 'talkback-tts-output' : 'voiceover-speech-output');
    const caps = await f.client.capabilities();
    assert(caps.actions.some(({ action }) => action === 'nextHeading'));
    assert(!caps.actions.some(({ action }) => action === 'brailleRoute'));
    await f.client.beginSession('native-checkout', false);
    const state = await f.client.state();
    assert.equal(state.focus.webContentFocused, true);
    assert.equal(state.cursorMode, 'unknown');
    const action = await f.client.perform('nextHeading');
    assert.equal(action.delivery, 'emulated');
    assert.equal(action.timedOut, false);
    const speech = action.events.filter(event => event.kind === 'speech');
    assert.equal(speech[0].text, 'Checkout summary heading level 2');
    assert.equal(speech[0].command, 'nextHeading');
    assert.equal(speech[0].provenance, 'screenReaderOutput');
    assert.deepEqual(f.delivered, [nativeCommands(reader).nextHeading]);
    const cursor = await f.client.cursor();
    f.emit('A real asynchronous announcement');
    const observed = await f.client.readEvents(cursor, { timeoutMs: 50, quietMs: 5 });
    assert.equal(observed.events[0].text, 'A real asynchronous announcement');
    assert.equal(observed.events[0].command, 'event');
    await assert.rejects(() => f.client.presentationSettings(), /does not expose NVDA presentation settings/);
    const artifacts = await f.client.finishSession();
    assert.equal(artifacts.length, 1);
    const data = JSON.parse(Buffer.from(artifacts[0].body).toString('utf8'));
    assert.equal(data.screenReader, reader);
    assert.equal(data.fault, null);
    assert.equal(data.events.filter(event => event.kind === 'speech').length, 2);
    await f.client.beginSession('isolated-second-test', false);
    assert.equal((await f.client.state()).lastSequence, observed.lastSequence);
    await f.client.finishSession();
  });
}

test('native sessions reject overlap, mismatches, stale cursors and unsupported actions', async t => {
  const f = await fixture(t, 'voiceover');
  const bad = await f.request('/v2/sessions', { testId: 'bad', profile: 'nvda-web-2026.1.1', locale: 'en-US', keyboardLayout: 'desktop', recording: false });
  assert.equal(bad.status, 400);
  const session = await f.client.beginSession('one-desktop', false);
  assert.equal((await f.request('/v2/sessions', {})).status, 409);
  const unsupported = await f.request(`/v2/sessions/${session.id}/actions`, { command: 'brailleRoute' });
  assert.equal(unsupported.status, 400);
  assert.deepEqual(f.delivered, []);
  f.blur();
  await assert.rejects(() => f.client.perform('nextHeading'), /own native desktop focus/);
  assert.deepEqual(f.delivered, []);
  const first = await f.request(`/v2/sessions/${session.id}/finish`, {});
  const retry = await f.request(`/v2/sessions/${session.id}/finish`, {});
  assert.deepEqual(await first.json(), await retry.json());
});

test('missing speech times out and never manufactures successful reader output', async t => {
  const f = await fixture(t, 'voiceover', { silent: true });
  await f.client.beginSession('silent', false);
  const action = await f.client.perform('nextHeading');
  assert.equal(action.timedOut, true);
  assert.equal(action.events.filter(event => event.kind === 'speech').length, 0);
  await f.client.finishSession();
});

test('native disconnect fails closed but preserves completed evidence on finish', async t => {
  const f = await fixture(t, 'voiceover');
  await f.client.beginSession('disconnect', false);
  await f.client.perform('nextHeading');
  f.fail();
  await assert.rejects(() => f.client.health(), /native runtime failed/);
  const artifacts = await f.client.finishSession();
  const body = JSON.parse(Buffer.from(artifacts[0].body).toString());
  assert.equal(body.events.filter(event => event.kind === 'speech').length, 1);
  assert(body.fault);
});

test('native control requires authentication and hides secrets', async t => {
  const f = await fixture(t, 'voiceover');
  const response = await fetch(f.bridge.endpoint + '/v2/health');
  assert.equal(response.status, 401);
  assert(!JSON.stringify(await response.json()).includes(token));
});

test('TalkBack probe failure fails readiness and is retained with completed evidence', async t => {
  const f = await fixture(t, 'talkback');
  await f.client.beginSession('lost-android-focus-probe', false);
  await f.client.perform('nextHeading');
  f.failProbe();
  await assert.rejects(() => f.client.health(), /native runtime failed/);
  const artifacts = await f.client.finishSession();
  const data = JSON.parse(Buffer.from(artifacts[0].body).toString('utf8'));
  assert.match(data.fault, /identity or focus probe failed/);
  assert.equal(data.events.filter(event => event.kind === 'speech').length, 1);
  assert(!JSON.stringify(data).includes('private native probe error'));
});

test('native identities and capture boundaries cannot be confused with NVDA or HooVDA', async t => {
  const f = await fixture(t, 'voiceover');
  for (const reader of ['nvda', 'hoovda', 'talkback']) {
    const client = new HttpScreenReaderClient({ controlEndpoint: f.bridge.endpoint, controlToken: token, cdpEndpoint: 'http://127.0.0.1:9225' }, reader);
    await assert.rejects(() => client.health(), /invalid .* health response/);
  }
});

test('VoiceOver sends reader-specific shortcuts', () => {
  assert.deepEqual(nativeCommands('voiceover').nextHeading, [[KEY.control, KEY.alt, KEY.command, 'h']]);
  assert.equal(nativeCommands('voiceover').nextHeading1, undefined);
  assert.equal(nativeCommands('voiceover').nextLandmark, undefined);
  assert.match(voiceOverKeyScript(nativeCommands('voiceover').nextHeading[0]), /keystroke "h" using \{control down, option down, command down\}/);
  const align = voiceOverKeyScript(nativeCommands('voiceover').moveToFocusObject[0]);
  assert.match(align, /key down shift\ntry\nkey code 118 using \{control down, option down\}/);
  assert.equal((align.match(/key up shift/g) ?? []).length, 2);
  assert.throws(() => voiceOverKeyScript(['malicious script']), /unsupported VoiceOver key/);
});

test('native CLI validates host, ports, options and private token reuse', async t => {
  assert.throws(() => assertNativePlatform('voiceover', 'linux'), /macOS/);
  assertNativePlatform('voiceover', 'darwin');
  assert.throws(() => parseArguments(['--screen-reader', 'voiceover']), /token-file/);
  assert.throws(() => parseArguments(['--screen-reader', 'voiceover', '--token-file', 'x', '--cdp-port', '3003']), /ports must differ/);
  const directory = await mkdtemp(join(tmpdir(), 'hst-native-token-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'private', 'token');
  const secret = await loadControlToken(path);
  assert.equal(await loadControlToken(path), secret);
  assert.equal((await readFile(path, 'utf8')).trim(), secret);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
});

class FakeSocket extends EventTarget {
  static instance;
  sent = [];
  constructor() { super(); FakeSocket.instance = this; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
  send(raw) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    const result = message.method === 'session.new'
      ? { sessionId: 'upstream-session', capabilities: { atName: 'VoiceOver', atVersion: '10 (993)', platformName: 'macos' } } : {};
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: message.id, result }) })));
  }
  close() { this.dispatchEvent(new Event('close')); }
}

test('AT Driver negotiates native identity and forwards only captured speech events', async () => {
  const driver = await ATDriver.connect('ws://127.0.0.1:4382/session', 'voiceover', { WebSocketClass: FakeSocket });
  const phrases = [];
  driver.onSpeech(text => phrases.push(text));
  await driver.press(nativeCommands('voiceover').nextHeading);
  assert.equal(FakeSocket.instance.sent[0].method, 'session.new');
  assert.equal(FakeSocket.instance.sent[0].params.capabilities.alwaysMatch.atName, 'VoiceOver');
  assert.deepEqual(FakeSocket.instance.sent[1].params.keys, nativeCommands('voiceover').nextHeading[0]);
  FakeSocket.instance.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'interaction.capturedOutput', params: { data: 'Checkout' } }) }));
  assert.deepEqual(phrases, ['Checkout']);
  FakeSocket.instance.dispatchEvent(new MessageEvent('message', { data: '{}' }));
  assert.throws(() => driver.assertReady(), /unrecognized/);
  driver.close();
  await assert.rejects(() => ATDriver.connect('ws://untrusted.example/session', 'voiceover'), /loopback/);
});

test('VoiceOver samples actual last-phrase changes without replaying a stale caption', async () => {
  let caption = 'Old caption';
  const scripts = [];
  const driver = await VoiceOverDriver.connect({ runScript: async script => {
    scripts.push(script);
    if (script.includes('content of last phrase')) return caption;
    caption = 'Checkout summary';
    return '';
  } });
  const phrases = [];
  driver.onSpeech(text => phrases.push(text));
  await driver.press(nativeCommands('voiceover').nextHeading);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.deepEqual(phrases, ['Checkout summary']);
  await driver.press(nativeCommands('voiceover').nextHeading);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.deepEqual(phrases, ['Checkout summary']);
  assert(scripts.some(script => script.includes('System Events')));
  await driver.close();
});

test('VoiceOver web entry requires native cursor membership and fails closed without it', async () => {
  const scripts = [];
  const driver = await VoiceOverDriver.connect({ runScript: async script => { scripts.push(script); return ''; } });
  let probes = 0;
  await driver.focusWeb(async () => ({ browserWindowActive: true, readerCursorInDocument: ++probes > 3 }));
  assert(probes > 3);
  assert(scripts.some(script => script.includes('vo cursor to move right')));
  assert(scripts.some(script => script.includes('vo cursor to move into item')));
  await driver.close();
  const unverified = await VoiceOverDriver.connect({ runScript: async () => '' });
  await assert.rejects(() => unverified.focusWeb(async () => ({ browserWindowActive: true })), /cursor verification/);
  assert.throws(() => unverified.assertReady(), /cursor verification/);
  await unverified.close();
});

test('VoiceOver enters a web area whose outer cursor rectangle includes native scrollbars', async () => {
  let atDocument = false;
  let insideDocument = false;
  const driver = await VoiceOverDriver.connect({ runScript: async script => {
    if (script.includes('vo cursor to move right')) atDocument = true;
    if (atDocument && script.includes('vo cursor to move into item')) insideDocument = true;
    return '';
  } });
  await driver.focusWeb(async () => ({
    browserWindowActive: true, webContentFocused: true,
    focus: { id: 'owned-document' },
    readerCursorAtDocument: atDocument, readerCursorInDocument: insideDocument,
  }));
  assert(insideDocument, 'native interaction must precede accepting web-area membership');
  await driver.close();
});

test('pending sampled output is drained before attributing a new native command', async t => {
  const f = await fixture(t, 'voiceover', { drainSpeech: true });
  await f.client.beginSession('drain', false);
  const action = await f.client.perform('nextHeading');
  assert.deepEqual(action.events.filter(event => event.kind === 'speech').map(event => event.text), ['Checkout summary heading level 2']);
  const artifacts = await f.client.finishSession();
  const events = JSON.parse(Buffer.from(artifacts[0].body).toString()).events;
  assert.equal(events.find(event => event.text === 'Pending asynchronous output').causalCommand, 'event');
});

test('VoiceOver stops delivering entry gestures once its cursor belongs to the document', async () => {
  let insideDocument = false;
  let unexpectedEntry = false;
  const driver = await VoiceOverDriver.connect({ runScript: async script => {
    if (script.includes('vo cursor to move right')) insideDocument = true;
    if (insideDocument && script.includes('vo cursor to move into item')) {
      unexpectedEntry = true;
      insideDocument = false;
    }
    return '';
  } });
  try {
    await driver.focusWeb(async () => ({
      browserWindowActive: true, webContentFocused: true,
      focus: { id: 'owned-document' },
      readerCursorInDocument: insideDocument, readerCursorAtDocument: false,
    }));
    assert.equal(unexpectedEntry, false);
    assert.equal(insideDocument, true);
  } finally {
    await driver.close();
  }
});


test('VoiceOver distinguishes a selected web area from a cursor already inside it', () => {
  const encode = (a, b) => {
    const bytes = Buffer.alloc(16);
    bytes.writeDoubleLE(a, 0); bytes.writeDoubleLE(b, 8);
    return bytes.toString('base64');
  };
  const position = encode(0, 100), size = encode(1000, 700);
  const proven = { readerCursorInDocument: true, readerCursorAtDocument: true };
  assert.deepEqual(voiceOverCursorMembership([0, 100, 1000, 800], position, size, proven),
    { readerCursorInDocument: false, readerCursorAtDocument: true });
  assert.deepEqual(voiceOverCursorMembership([-2, 98, 1015, 802], position, size,
    { readerCursorInDocument: false, readerCursorAtDocument: true }),
    { readerCursorInDocument: false, readerCursorAtDocument: true });
  assert.deepEqual(voiceOverCursorMembership([8, 108, 300, 150], position, size, proven),
    { readerCursorInDocument: true, readerCursorAtDocument: false });
  assert.deepEqual(voiceOverCursorMembership([0, 100, 1000, 800], position, size,
    { readerCursorInDocument: false, readerCursorAtDocument: false }),
    { readerCursorInDocument: false, readerCursorAtDocument: false });
  assert.throws(() => voiceOverCursorMembership([0, 100, 1000, 800], null, size, proven), /native document geometry/);
});
