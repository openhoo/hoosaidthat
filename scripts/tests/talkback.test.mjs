import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import test from 'node:test';
import { TalkBackCapture, TalkBackDriver, androidProbe, createAdb } from '../native/talkback.mjs';
import { nativeCommands } from '../native/commands.mjs';
import { parseTalkBackArguments } from '../talkback-android.mjs';
import { startAndroidDevtools } from '../native/android-devtools.mjs';
import { HttpScreenReaderClient } from '../../dist/client.js';

const generation = '12345678-1234-1234-1234-123456789abc';
const header = JSON.stringify({ schemaVersion: 1, generation, talkbackUid: 10123 }) + '\n';
const event = (sequence, text, extra = {}) => JSON.stringify({ sequence, generation, callerUid: 10123,
  elapsedRealtimeMs: 123456789, kind: 'speech', text, ...extra }) + '\n';
const state = { ok: true, delivered: true, version: '16.0', browserVersion: '151.0',
  browserWindowActive: true, webContentFocused: true, focus: { role: 'web area', name: null, location: null } };

test('TalkBack capture preserves repeated UTF-8 utterances, newlines and partial writes', () => {
  const capture = new TalkBackCapture();
  const phrases = [];
  capture.read(Buffer.from(header + event(1, 'stale caption')));
  const complete = Buffer.from(header + event(1, 'stale caption') + event(2, 'Überprüfung\nready') + event(3, 'Überprüfung\nready'));
  const partial = complete.subarray(0, complete.lastIndexOf(Buffer.from('Überprüfung')) + 1);
  capture.read(partial, text => phrases.push(text));
  assert.deepEqual(phrases, ['Überprüfung\nready']);
  capture.read(complete, text => phrases.push(text));
  capture.read(complete, text => phrases.push(text));
  assert.deepEqual(phrases, ['Überprüfung\nready', 'Überprüfung\nready']);
  assert.equal(capture.sequence, 3);
});

test('TalkBack capture fails on gaps, other callers, engine restart, malformed data and capacity loss', () => {
  for (const next of [event(2, 'lost first event'), event(1, 'other app', { callerUid: 999 }),
    event(1, 'capacity', { kind: 'fault' }), event(1, 'x'.repeat(16385)), '{bad json}\n']) {
    const capture = new TalkBackCapture();
    capture.read(Buffer.from(header));
    assert.throws(() => capture.read(Buffer.from(header + next)));
  }
  const capture = new TalkBackCapture();
  capture.read(Buffer.from(header + event(1, 'first')));
  assert.throws(() => capture.read(Buffer.from(header)), /truncated/);
  assert.throws(() => capture.read(Buffer.from(header.replace(generation, 'abcdefab-1234-1234-1234-123456789abc') + event(1, 'first'))), /restarted/);
  assert.throws(() => new TalkBackCapture().read(Buffer.from(header + 'x'.repeat(3 * 1024 * 1024))), /capacity/);
});

test('TalkBack driver discards stale output and sends native Android gestures', async t => {
  let history = header + event(1, 'stale');
  const calls = [];
  const adb = async (...args) => {
    calls.push(args);
    if (args[0] === 'exec-out') return Buffer.from(history);
    if (args.includes('instrument')) return Buffer.from(`INSTRUMENTATION_RESULT: hst=${JSON.stringify(state)}\r\nINSTRUMENTATION_CODE: -1\n`);
    if (args.includes('input')) history += event(2, 'Checkout heading');
    return Buffer.from('1234\n');
  };
  const driver = await TalkBackDriver.connect(adb);
  t.after(() => driver.close());
  const phrases = [];
  driver.onSpeech(text => phrases.push(text));
  await driver.press(nativeCommands('talkback').nextHeading);
  assert.deepEqual(phrases, ['Checkout heading']);
  assert(calls.some(args => args.join(' ') === 'shell input keyboard keycombination -t 50 57 36'));
  await driver.press('readCurrent');
  assert(calls.some(args => args.includes('readCurrent') && args.includes('instrument')));
  await assert.rejects(() => driver.press([[57, 999]]), /unsupported/);
  history = header;
  await assert.rejects(() => driver.drain(), /lost events/);
  assert.throws(() => driver.assertReady(), /lost events/);
});

test('Android probe rejects disabled readers, failed focus and malformed instrumentation', async () => {
  for (const result of ['no instrumentation installed', JSON.stringify({ ...state, ok: false }), JSON.stringify({ ...state, delivered: false })]) {
    await assert.rejects(() => androidProbe(async () => Buffer.from(`INSTRUMENTATION_RESULT: hst=${result}\n`), 'focusWeb'), /probe/);
  }
  assert.throws(() => createAdb('emulator;unsafe'), /serial/);
  await assert.rejects(() => androidProbe(async () => { throw new Error('disconnected'); }), /disconnected/);
});

test('TalkBack uses its default Alt keymap and advertises no NVDA-only commands', () => {
  const commands = nativeCommands('talkback');
  assert.deepEqual(commands.nextHeading, [[57, 36]]);
  assert.deepEqual(commands.previousHeading, [[57, 59, 36]]);
  assert.deepEqual(commands.nextLandmark, [[57, 32]]);
  assert.deepEqual(commands.nextLink, [[57, 40]]);
  assert.deepEqual(commands.nextButton, [[57, 30]]);
  assert.deepEqual(commands.documentStart, [[57, 113, 21]]);
  assert.deepEqual(commands.sayAll, [[57, 113, 59, 66]]);
  for (const unsupported of ['nextHeading7', 'brailleRoute', 'toggleFocusMode', 'find', 'nextRadioButton']) {
    assert.equal(commands[unsupported], undefined);
  }
});

test('TalkBack CLI requires an explicit device and validates all options before adb', () => {
  const args = ['run', '--serial', 'emulator-5554', '--token-file', '/tmp/control'];
  assert.equal(parseTalkBackArguments(args)['cdp-port'], '9227');
  assert.deepEqual(parseTalkBackArguments([...args, '--', 'npm', 'test']).child, ['npm', 'test']);
  for (const invalid of [[], ['run'], [...args, '--serial', 'other'], [...args, '--unknown', 'x'],
    [...args, '--control-port', '9227'], [...args, '--locale', 'fr-FR'], [...args, '--cdp-port', '65536'],
    ['doctor', '--serial', 'emulator-5554', '--', 'npm', 'test']]) {
    assert.throws(() => parseTalkBackArguments(invalid));
  }
});

test('Android CDP discovery and WebSocket traffic use the owned local forward', async t => {
  const upstreamSockets = new Set();
  const upstream = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url === '/json/version' ? { Browser: 'Chrome/151.0' }
      : [{ webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/real' }]));
  });
  upstream.on('connection', socket => { upstreamSockets.add(socket); socket.on('close', () => upstreamSockets.delete(socket)); });
  upstream.on('upgrade', (request, socket) => {
    assert.equal(request.url, '/devtools/browser');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    socket.on('data', bytes => socket.write(bytes));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const bridge = await startAndroidDevtools({ upstreamPort: upstream.address().port });
  t.after(async () => {
    await bridge.close();
    for (const socket of upstreamSockets) socket.destroy();
    await new Promise(resolve => upstream.close(resolve));
  });
  const version = await (await fetch(bridge.endpoint + '/json/version')).json();
  assert.equal(version.webSocketDebuggerUrl, bridge.endpoint.replace('http:', 'ws:') + '/devtools/browser');
  const pages = await (await fetch(bridge.endpoint + '/json/list')).json();
  assert.equal(pages[0].webSocketDebuggerUrl, bridge.endpoint.replace('http:', 'ws:') + '/devtools/page/real');
  const port = +new URL(bridge.endpoint).port;
  const socket = connect({ host: '127.0.0.1', port });
  t.after(() => socket.destroy());
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('connect', () => socket.write('GET /devtools/browser HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'));
    socket.once('data', chunk => { assert.match(chunk.toString(), /101 Switching Protocols/); resolve(); });
  });
  socket.write('real protocol bytes');
  assert.equal(await new Promise(resolve => socket.once('data', chunk => resolve(chunk.toString()))), 'real protocol bytes');
  socket.destroy();
});

test('TalkBack health refuses wrong reader, capture boundary or operating system', async t => {
  let changes = {};
  const server = createServer((_request, response) => response.end(JSON.stringify({ protocolVersion: '2.0', status: 'ok',
    ready: true, screenReader: 'talkback', version: '16.0', profile: 'talkback-web', platform: 'android',
    capture: 'talkback-tts-output', locale: 'en-US', keyboardLayout: 'desktop', ...changes })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new HttpScreenReaderClient({ controlEndpoint: `http://127.0.0.1:${server.address().port}`,
    cdpEndpoint: 'http://127.0.0.1:9227', controlToken: 'test' }, 'talkback');
  assert.equal((await client.health()).platform, 'android');
  for (const invalid of [{ screenReader: 'nvda' }, { platform: 'linux' }, { capture: 'hoovda-structured-presentation' }, { profile: 'nvda-web-2026.1.1' }]) {
    changes = invalid;
    await assert.rejects(() => client.health(), /invalid TalkBack health/);
  }
});
