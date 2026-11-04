import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nativeCommands } from './commands.mjs';

const execute = promisify(execFile);
const CAPTURE = 'dev.openhoo.hoosaidthat.tts';
const PROBE = 'dev.openhoo.hoosaidthat.probe/.Probe';
const MAX_CAPTURE = 2 * 1024 * 1024 + 65536;

export function createAdb(serial, executable = process.env.HST_ADB_BIN ?? 'adb') {
  if (typeof serial !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(serial)) {
    throw new Error('an explicit Android --serial is required');
  }
  return async (...args) => {
    try {
      const { stdout } = await execute(executable, ['-s', serial, ...args], {
        timeout: 10000, maxBuffer: MAX_CAPTURE, encoding: 'buffer', windowsHide: true,
      });
      return stdout;
    } catch {
      // adb errors may include private synthesis output. Do not reflect them.
      throw new Error('Android adb command failed; check the selected device, installed helper APKs and USB authorization');
    }
  };
}

export async function androidProbe(adb, action = 'state') {
  if (!['state', 'focusWeb', 'readCurrent'].includes(action)) throw new Error('unsupported Android probe action');
  await adb('shell', 'pidof', 'com.google.android.marvin.talkback');
  const output = (await adb('shell', 'am', 'instrument', '-w', '-r', '-e', 'action', action, PROBE)).toString('utf8');
  const match = /^INSTRUMENTATION_RESULT: hst=(.+)\r?$/m.exec(output);
  let value;
  try { value = JSON.parse(match?.[1] ?? ''); } catch { throw new Error('invalid Android native probe response; install the probe APK'); }
  if (value.ok !== true || typeof value.version !== 'string' || !value.version.trim() ||
      typeof value.browserVersion !== 'string' || !value.browserVersion.trim() ||
      typeof value.browserWindowActive !== 'boolean' || typeof value.webContentFocused !== 'boolean' ||
      (action !== 'state' && value.delivered !== true)) {
    throw new Error('Android native probe is not ready; enable TalkBack, select the capture TTS engine and foreground Chrome');
  }
  return value;
}

/** Loss-detecting cursor over private, append-only UTF-8 synthesis requests. */
export class TalkBackCapture {
  generation;
  uid;
  sequence = 0;
  offset = 0;
  header;

  read(bytes, emit = () => {}) {
    if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
    if (bytes.length > MAX_CAPTURE || bytes.length < this.offset) throw new Error('TalkBack capture was truncated or exceeded capacity');
    const firstEnd = bytes.indexOf(10);
    if (firstEnd < 0) throw new Error('TalkBack capture has no complete header');
    const headerBytes = bytes.subarray(0, firstEnd + 1);
    if (this.header && !this.header.equals(headerBytes)) throw new Error('TalkBack capture engine restarted; restart the bridge');
    if (!this.header) {
      const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(headerBytes));
      if (header.schemaVersion !== 1 || typeof header.generation !== 'string' ||
          !/^[a-f0-9-]{36}$/.test(header.generation) || !Number.isSafeInteger(header.talkbackUid) || header.talkbackUid <= 0) {
        throw new Error('invalid TalkBack capture header');
      }
      this.header = Buffer.from(headerBytes);
      this.generation = header.generation;
      this.uid = header.talkbackUid;
      this.offset = firstEnd + 1;
    }
    // Ignore only an incomplete final line; consume it after the writer finishes.
    const end = bytes.lastIndexOf(10) + 1;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(this.offset, end));
    for (const line of text.split('\n').filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.generation !== this.generation || event.sequence !== this.sequence + 1 || event.callerUid !== this.uid ||
          event.kind !== 'speech' || typeof event.text !== 'string' || Buffer.byteLength(event.text) > 16384 ||
          !Number.isSafeInteger(event.elapsedRealtimeMs) || event.elapsedRealtimeMs < 0) {
        throw new Error('invalid or lost TalkBack synthesis event; restart the bridge');
      }
      this.sequence = event.sequence;
      emit(event.text);
    }
    this.offset = end;
  }
}

export class TalkBackDriver {
  capture = 'talkback-tts-output';
  outputSource = 'android-TextToSpeechService.onSynthesizeText:talkback-uid';
  reader = new TalkBackCapture();
  listeners = new Set();
  fault;
  closed = false;
  pending;
  timer;

  static async connect(adb) {
    const driver = new TalkBackDriver(adb);
    await androidProbe(adb);
    // Validate existing history but never replay stale speech into a new session.
    driver.reader.read(await driver.history());
    driver.schedule();
    return driver;
  }
  constructor(adb) { this.adb = adb; }
  history() { return this.adb('exec-out', 'run-as', CAPTURE, 'cat', 'files/speech.jsonl'); }
  onSpeech(listener) { this.listeners.add(listener); }
  assertReady() {
    if (this.fault) throw this.fault;
    if (this.closed) throw new Error('TalkBack driver is closed');
  }
  schedule() {
    if (this.closed || this.fault) return;
    this.timer = setTimeout(() => this.drain().catch(() => {}).finally(() => this.schedule()), 100);
    this.timer.unref();
  }
  async drain() {
    this.assertReady();
    if (!this.pending) {
      this.pending = (async () => {
        try {
          this.reader.read(await this.history(), text => { for (const listener of this.listeners) listener(text); });
        } catch { this.fault = new Error('TalkBack speech capture failed or lost events; restart the bridge'); throw this.fault; }
      })().finally(() => { this.pending = undefined; });
    }
    await this.pending;
  }
  async press(command) {
    this.assertReady();
    if (command === 'focusWeb' || command === 'readCurrent') await androidProbe(this.adb, command);
    else {
      const allowed = Object.values(nativeCommands('talkback')).some(value => JSON.stringify(value) === JSON.stringify(command));
      if (!allowed) throw new Error('unsupported TalkBack key gesture');
      for (const chord of command) {
        await this.adb('shell', 'input', 'keyboard', chord.length === 1 ? 'keyevent' : 'keycombination',
          ...(chord.length === 1 ? [] : ['-t', '50']), ...chord.map(String));
      }
    }
    await this.drain();
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    await this.pending?.catch(() => {});
    this.listeners.clear();
  }
}
