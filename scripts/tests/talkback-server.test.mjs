import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpScreenReaderClient } from '../../dist/client.js';
import { startNativeServer } from '../native/server.mjs';
import { nativeCommands } from '../native/commands.mjs';

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
      return { version: '16.0',
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

for (const reader of ['talkback']) {
  test(`${reader}: HTTP client round trip preserves native identity, actual driver speech and artifact integrity`, async t => {
    const f = await fixture(t, reader);
    const health = await f.client.health();
    assert.equal(health.screenReader.name, reader);
    assert.equal(health.profile, `${reader}-web`);
    assert.equal(health.platform, 'android');
    assert.equal(health.screenReader.capture, 'talkback-tts-output');
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
  const f = await fixture(t, 'talkback');
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
  const f = await fixture(t, 'talkback', { silent: true });
  await f.client.beginSession('silent', false);
  const action = await f.client.perform('nextHeading');
  assert.equal(action.timedOut, true);
  assert.equal(action.events.filter(event => event.kind === 'speech').length, 0);
  await f.client.finishSession();
});

test('native disconnect fails closed but preserves completed evidence on finish', async t => {
  const f = await fixture(t, 'talkback');
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
  const f = await fixture(t, 'talkback');
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
  const f = await fixture(t, 'talkback');
  for (const reader of ['nvda', 'hoovda']) {
    const client = new HttpScreenReaderClient({ controlEndpoint: f.bridge.endpoint, controlToken: token, cdpEndpoint: 'http://127.0.0.1:9225' }, reader);
    await assert.rejects(() => client.health(), /invalid .* health response/);
  }
});

