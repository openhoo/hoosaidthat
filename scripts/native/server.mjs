import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SCREEN_READER_ACTIONS } from '../../dist/types.js';
import { nativeCommands } from './commands.mjs';

const MAX_EVENTS = 20000;
const MAX_EVENT_BYTES = 8 * 1024 * 1024;

// The driver and probe are native host boundaries. The HTTP/recording layer is
// platform independent and can be regression-tested in a Linux container.
export async function startNativeServer({ screenReader, token, driver, probe,
  port = 0, locale = 'en-US', keyboardLayout = 'desktop', quietMs = 300,
  actionTimeoutMs = 15000, browser }) {
  if (!['voiceover', 'talkback'].includes(screenReader)) throw new Error('native reader must be voiceover or talkback');
  if (typeof token !== 'string' || Buffer.byteLength(token) < 16 || Buffer.byteLength(token) > 4096 || /[\u0000-\u0020\u007f]/.test(token)) {
    throw new Error('native control token must contain 16 to 4096 bytes without whitespace or control characters');
  }
  if (!['en-US', 'de-DE'].includes(locale)) throw new Error('unsupported native locale');
  if (keyboardLayout !== 'desktop') throw new Error('native adapters currently require keyboardLayout desktop');
  if (!Number.isInteger(quietMs) || quietMs < 1 || quietMs > 5000 ||
      !Number.isInteger(actionTimeoutMs) || actionTimeoutMs <= quietMs || actionTimeoutMs > 30000) throw new Error('invalid native settling deadlines');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid native control port');
  const initialState = await probe();
  const version = initialState.version;
  if (typeof version !== 'string' || !version.trim()) throw new Error('native version attestation is required');
  const profile = `${screenReader}-web`;
  const platform = screenReader === 'talkback' ? 'android' : 'macos';
  const capture = screenReader === 'talkback' ? 'talkback-tts-output'
    : driver.capture === 'voiceover-last-phrase' ? 'voiceover-last-phrase' : 'voiceover-speech-output';
  const commands = nativeCommands(screenReader);
  const secret = Buffer.from(`Bearer ${token}`);
  let active;
  let sequence = 0;
  let busy = false;
  let fault;
  let currentCommand = 'event';
  const origin = process.hrtime.bigint();
  const finished = new Map();

  function ready() {
    if (fault) throw new HttpError(503, fault.message);
    driver.assertReady();
  }
  function append(kind, text, provenance = 'adapterLifecycle') {
    if (!active) return;
    const event = { sequence: ++sequence, monotonicNs: Number(process.hrtime.bigint() - origin),
      kind, causalCommand: currentCommand, text, provenance };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (active.events.length >= MAX_EVENTS || active.bytes + bytes > MAX_EVENT_BYTES) {
      fault = new Error('native event history capacity exceeded; finish and restart the bridge');
      return;
    }
    active.events.push(event);
    active.bytes += bytes;
    active.lastEventAt = Date.now();
  }
  driver.onSpeech(text => {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 16384) { fault = new Error('invalid native speech output'); return; }
    if (text.trim()) append('speech', text, 'screenReaderOutput');
  });

  async function nativeState() {
    ready();
    let state;
    try {
      state = await probe();
      if (state.version !== version) throw new HttpError(503, 'native screen reader version changed; restart the bridge');
    } catch (error) {
      fault ??= new Error('native identity or focus probe failed; restart the bridge');
      throw error;
    }
    return { ...state, lastSequence: sequence, cursor: { mode: 'unknown' },
      cursorInDocument: false };
  }
  async function settle(after, timeoutMs, requestedQuietMs, requireOutput) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      ready();
      const events = active.events.filter(event => event.sequence > after);
      const hasSpeech = events.some(event => event.kind === 'speech');
      if ((!requireOutput || hasSpeech) && Date.now() - Math.max(started, active.lastEventAt) >= requestedQuietMs) {
        return { events, cursor: sequence, timedOut: false };
      }
      await delay(Math.min(25, requestedQuietMs));
    }
    ready();
    return { events: active.events.filter(event => event.sequence > after), cursor: sequence, timedOut: true };
  }
  function send(response, status, body) {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
      'content-length': bytes.length, 'cache-control': 'no-store' });
    response.end(bytes);
  }
  const server = createServer(async (request, response) => {
    try {
      const auth = Buffer.from(request.headers.authorization ?? '');
      if (auth.length !== secret.length || !timingSafeEqual(auth, secret)) throw new HttpError(401, 'unauthorized');
      const url = new URL(request.url, 'http://127.0.0.1');
      const path = url.pathname;
      const method = request.method;
      if (method === 'GET' && path === '/v2/health') {
        await nativeState();
        return send(response, 200, { protocolVersion: '2.0', status: 'ok', ready: true,
          screenReader, version, profile, locale, keyboardLayout, browser,
          platform,
          capture,
          identitySource: screenReader === 'talkback' ? 'android-accessibility-service' : 'native-process', localeSource: 'operator-configured',
          outputSource: driver.outputSource ?? 'at-driver-interaction.capturedOutput' });
      }
      if (method === 'GET' && path === '/v2/actions') {
        ready();
        return send(response, 200, { commands: Object.keys(commands).map(id => ({ id, label: SCREEN_READER_ACTIONS[id] })) });
      }
      if (method === 'POST' && path === '/v2/sessions') {
        if (busy || active) throw new HttpError(409, 'native desktop already has an active session');
        // Reserve before reading the request so simultaneous creates cannot both win.
        busy = true;
        try {
          ready();
          const body = await jsonBody(request);
          if (typeof body.testId !== 'string' || !body.testId.trim() || Buffer.byteLength(body.testId) > 500 ||
            typeof body.recording !== 'boolean' || body.profile !== profile || body.locale !== locale || body.keyboardLayout !== keyboardLayout) {
            throw new HttpError(400, 'session requires matching profile, locale, keyboard layout, testId, and recording');
          }
          await nativeState();
          active = { id: randomUUID(), testId: body.testId, events: [], bytes: 0, startSequence: sequence, lastEventAt: Date.now() };
          return send(response, 201, { id: active.id, startSequence: active.startSequence });
        } finally { busy = false; }
      }
      const match = /^\/v2\/sessions\/([A-Za-z0-9._~-]+)\/(state|actions|events|finish|artifacts\/screenreader-events)$/.exec(path);
      if (!match) throw new HttpError(404, 'unknown native runtime endpoint');
      const [, id, operation] = match;
      if (operation === 'finish' && method === 'POST' && finished.has(id)) return send(response, 200, finished.get(id).manifest);
      if (operation === 'artifacts/screenreader-events' && method === 'GET' && finished.has(id)) return send(response, 200, finished.get(id).body);
      if (!active || id !== active.id) throw new HttpError(404, 'unknown native session');
      if (busy) throw new HttpError(409, 'another session operation is active');
      busy = true;
      try {
        if (operation === 'finish' && method === 'POST') {
          await jsonBody(request);
          // Preserve completed evidence even if the driver disconnected. The fault
          // is recorded, and subsequent health checks still fail closed.
          try { await settle(sequence, quietMs * 2, quietMs, false); } catch (error) { fault ??= error; }
          const body = Buffer.from(JSON.stringify({ schemaVersion: 1, screenReader, version, profile,
            capture, locale, keyboardLayout, browser,
            platform,
            outputSource: driver.outputSource ?? 'at-driver-interaction.capturedOutput',
            testId: active.testId, events: active.events, fault: fault?.message ?? null }));
          const manifest = { sessionId: id, artifacts: [{ name: 'screenreader-events', contentType: 'application/json',
            bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') }] };
          finished.set(id, { body, manifest });
          while (finished.size > 8) finished.delete(finished.keys().next().value);
          active = undefined;
          currentCommand = 'event';
          return send(response, 200, manifest);
        }
        ready();
        if (operation === 'state' && method === 'GET') return send(response, 200, await nativeState());
        if (operation === 'events' && method === 'GET') {
          const after = integerQuery(url, 'after', 0, sequence);
          if (after < active.startSequence) throw new HttpError(409, 'event cursor predates this session');
          const timeout = integerQuery(url, 'timeoutMs', 1, 30000);
          const quiet = integerQuery(url, 'quietMs', 1, 5000);
          return send(response, 200, await settle(after, timeout, quiet, true));
        }
        if (operation === 'actions' && method === 'POST') {
          const body = await jsonBody(request);
          const command = body.command;
          if (typeof command !== 'string' || !Object.hasOwn(commands, command) || Object.keys(body).some(key => key !== 'command')) {
            throw new HttpError(400, 'unsupported native command or argument');
          }
          // Foreground app identity comes from AX/UIA and the connected CDP browser PID.
          const state = await nativeState();
          if (!state.browserWindowActive) throw new HttpError(409, 'the connected browser must own native desktop focus');
          // Drain sampled output while it still belongs to asynchronous events.
          await driver.drain?.();
          const beforeSequence = sequence;
          currentCommand = command;
          append('commandStarted', command);
          try {
            if (screenReader === 'voiceover' && driver.focusWeb && command === 'moveToFocusObject') {
              await driver.focusWeb(probe);
            } else {
              await driver.press(commands[command]);
              if (screenReader === 'voiceover' && driver.focusWeb && command === 'returnToPage') await driver.focusWeb(probe);
            }
            const result = await settle(beforeSequence, actionTimeoutMs, quietMs, !['stopSpeech','escape','returnToPage','moveToFocusObject'].includes(command));
            append('commandSettled', result.timedOut ? 'timed-out' : 'settled');
            return send(response, 200, { command, beforeSequence, cursor: sequence,
              events: active.events.filter(event => event.sequence > beforeSequence), timedOut: result.timedOut, delivery: 'emulated' });
          } catch (error) {
            const code = typeof error.nativeFaultCode === 'string' && /^VOICEOVER_[A-Z_]{1,70}$/.test(error.nativeFaultCode) ? error.nativeFaultCode : null;
            fault ??= new Error(`native action failed${code ? ` (${code})` : ''}; restart the bridge`);
            if (code) console.error(`Native action ${command} failed: ${code}`);
            throw error;
          } finally { currentCommand = 'event'; }
        }
        throw new HttpError(405, 'method not allowed');
      } finally { busy = false; }
    } catch (error) {
      if (screenReader === 'voiceover' && /^VOICEOVER_[A-Z_]{1,70}$/.test(error.nativeFaultCode ?? '')) {
        console.error(JSON.stringify({ nativeFaultCode: error.nativeFaultCode,
          ...(Number.isSafeInteger(error.nativeScriptNumber) ? { scriptNumber: error.nativeScriptNumber } : {}) }));
      }
      // Do not reflect request bodies, upstream errors, URLs, or bearer tokens.
      send(response, error instanceof HttpError ? error.status : 503,
        { error: error instanceof HttpError ? error.message : 'native runtime failed; inspect the host and restart the bridge' });
    }
  });
  server.requestTimeout = 35000;
  server.headersTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { server, endpoint: `http://127.0.0.1:${server.address().port}`,
    async close() {
      try { await driver.close(); }
      finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    } };
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function integerQuery(url, key, minimum, maximum) {
  const text = url.searchParams.get(key);
  if (!text || !/^\d+$/.test(text)) throw new HttpError(400, `invalid ${key}`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new HttpError(400, `invalid ${key}`);
  return value;
}
async function jsonBody(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'application/json is required');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16384) throw new HttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new HttpError(400, 'invalid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'expected a JSON object');
  return value;
}
