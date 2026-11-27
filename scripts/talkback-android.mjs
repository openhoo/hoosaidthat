#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { createHash, randomInt } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createAdb, androidProbe, TalkBackCaptureError, TalkBackDriver } from './native/talkback.mjs';
import { startTalkBackEmulator, validAvdName } from './native/android-emulator.mjs';
import { startTalkBackMovie } from './native/talkback-movie.mjs';
import { prepareTalkBackEmulator } from './native/prepare-talkback-emulator.mjs';
import { startAndroidDevtools } from './native/android-devtools.mjs';
import { startNativeServer } from './native/server.mjs';
import { loadControlToken } from './native/token.mjs';
import { TALKBACK_QUIET_MS } from '../dist/types.js';
import { NATIVE_BOOTSTRAP_URL } from '../dist/bootstrap.js';

export function parseTalkBackArguments(args) {
  const split = args.indexOf('--');
  const own = split < 0 ? args : args.slice(0, split);
  if (own.includes('--help') || own.includes('-h')) return { help: true };
  const command = args[0] ?? 'help';
  if (!['doctor', 'start', 'run'].includes(command)) throw new Error('use doctor, start, or run; see --help');
  const options = { command, child: split < 0 ? [] : args.slice(split + 1) };
  const flags = split < 0 ? args.slice(1) : args.slice(1, split);
  const allowed = new Set(['serial', 'avd', 'talkback-apk', 'token-file', 'control-port', 'cdp-port', 'locale', 'recording', 'tts-engine', 'reverse-port']);
  for (let index = 0; index < flags.length; index += 2) {
    const name = flags[index]?.slice(2), value = flags[index + 1];
    if (!flags[index]?.startsWith('--') || !allowed.has(name) || typeof value !== 'string' || !value || value.startsWith('--') || name in options) {
      throw new Error('invalid or duplicate TalkBack option; use --help');
    }
    options[name] = value;
  }
  if (Boolean(options.serial) === Boolean(options.avd)) throw new Error('select exactly one device using --serial SERIAL or --avd NAME');
  if (options.serial && !/^[A-Za-z0-9_.:-]{1,200}$/.test(options.serial)) throw new Error('--serial must identify one authorized Android device');
  if (options.avd && !validAvdName(options.avd)) throw new Error('invalid --avd name');
  if (options.avd && command === 'doctor') throw new Error('doctor inspects an existing device; use --serial SERIAL');
  if (options['talkback-apk'] && !options.avd) throw new Error('--talkback-apk is only supported with --avd');
  if (options.recording && (command !== 'run' || !options.avd || !/\.mp4$/i.test(options.recording))) throw new Error('--recording requires run --avd NAME and an MP4 output path');
  if (options['tts-engine'] && (!options.recording || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(options['tts-engine']))) throw new Error('--tts-engine requires a recording and an installed Android TTS package name');
  if (options['reverse-port'] && (command !== 'run' || !options.avd || !/^\d{1,5}$/.test(options['reverse-port']) || +options['reverse-port'] < 1 || +options['reverse-port'] > 65535)) throw new Error('--reverse-port requires run --avd NAME and a valid TCP port');
  if (command !== 'doctor' && !options['token-file']) throw new Error('--token-file is required');
  if (command !== 'run' && options.child.length) throw new Error('only run accepts a child command');
  for (const [name, fallback] of [['control-port', '3005'], ['cdp-port', '9227']]) {
    options[name] ??= fallback;
    if (!/^\d+$/.test(options[name]) || +options[name] < 1024 || +options[name] > 65535) throw new Error(`invalid --${name}`);
  }
  if (+options['control-port'] === +options['cdp-port']) throw new Error('control and CDP ports must differ');
  options.locale ??= 'en-US';
  if (!['en-US', 'de-DE'].includes(options.locale)) throw new Error('locale must be en-US or de-DE');
  return options;
}

// A command such as `npx playwright test` can leave workers running after its
// wrapper exits. Keep its whole process group separate from the bridge and AVD.
export async function runTalkBackConsumer(command, { env, signal, graceMs = 5000 }) {
  signal.throwIfAborted();
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', detached: true, windowsHide: true, env });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, sig) => resolve(code ?? (sig ? 1 : 0)));
  });
  async function stopTree() {
    if (!child.pid) return;
    if (process.platform === 'win32') {
      // Stop descendants before killing their parent; Windows does not provide
      // POSIX process-group signals. Killing the parent alone loses that tree.
      await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
      return;
    }
    const group = sig => {
      try { process.kill(-child.pid, sig); return true; }
      catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    };
    if (!group(signal.reason?.signal ?? 'SIGTERM')) return;
    const deadline = Date.now() + graceMs;
    while (group(0) && Date.now() < deadline) await delay(Math.min(100, deadline - Date.now()));
    // Continue escalation even if the npm wrapper has already exited.
    group('SIGKILL');
  }
  let cleanup;
  let finishCancel, failCancel;
  const cancelled = new Promise((resolve, reject) => { finishCancel = resolve; failCancel = reject; });
  const onAbort = () => {
    cleanup = stopTree();
    cleanup.then(finishCancel, failCancel);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await Promise.race([exited, cancelled]);
    if (!cleanup) return await exited;
    await cleanup;
    await exited;
    return signal.reason?.signal === 'SIGINT' ? 130 : 143;
  } finally { signal.removeEventListener('abort', onAbort); }
}

async function main() {
  const options = parseTalkBackArguments(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: hoosaidthat-talkback-android doctor|start|run (--serial SERIAL | --avd NAME) [options] [-- command args...]

Connect a dedicated Android 14+ device or emulator running real TalkBack and
Chrome. With --serial install both helper APKs and select the capture TTS engine first.
With --avd build the helper APKs first; a disposable headless emulator is started from that AVD.
The helper captures TalkBack's text. Movie mode plays it through an installed Android voice.

  --reverse-port PORT       expose the host's loopback TCP port inside the disposable AVD
  --recording FILE.mp4      run --avd only: record the screen, guest sound and TalkBack transcript
  --tts-engine PACKAGE      installed Android voice for the movie (default: the AVD's preferred voice)
  --serial SERIAL           connect to a prepared device; leave its settings unchanged
  --avd NAME                start/run with a read-only copy of an existing Android virtual device
  --talkback-apk PATH       trusted TalkBack APK to install only in the disposable emulator
  --token-file PATH         required for start/run; privately created or reused
  --control-port PORT       default 3005, host loopback only
  --cdp-port PORT           default 9227, host loopback only
  --locale en-US|de-DE      must match TalkBack's configured language

doctor verifies the prepared device. start serves the adapter until Ctrl+C.
run serves the adapter while running a child command; without a child it runs
the packaged TalkBack smoke tests. It sets HOOSAIDTHAT_TALKBACK_* and
SCREEN_READER=talkback for the child. Managed emulators stop when the command exits.
See oracle/android-talkback/README.md for setup and qualification limits.`);
    return;
  }
  const controller = new AbortController();
  const { signal } = controller;
  const interrupt = () => controller.abort(Object.assign(new Error('TalkBack interrupted'), { signal: 'SIGINT' }));
  const terminate = () => controller.abort(Object.assign(new Error('TalkBack terminated'), { signal: 'SIGTERM' }));
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  let emulator;
  try {
    if (options.avd) {
      console.error(`Starting Android virtual device ${options.avd}…`);
      emulator = await startTalkBackEmulator(options.avd, { signal });
      emulator.exited.catch(error => controller.abort(error));
      options.serial = emulator.serial;
      console.error(`Preparing TalkBack on ${options.serial}…`);
    }
    const adb = emulator?.adb ?? createAdb(options.serial);
    await runOnDevice(options, adb, signal);
    if (signal.aborted && !signal.reason.signal) throw signal.reason;
  } finally {
    try { await emulator?.close(); }
    finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
  }
}

// Only pre-session setup may discard a capture generation. Each attempt starts
// at the end of the new engine's history and must prove fresh speech again.
export async function verifyTalkBackBootstrap({ connect, navigate, focus, signal,
  wait = ms => delay(ms, undefined, { signal }), now = Date.now }) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    signal.throwIfAborted();
    let candidate, unsubscribe;
    try {
      candidate = await connect();
      const challenge = `HooSaidThat native bootstrap ${randomInt(10000000, 100000000)} ${attempt}`;
      let captured = false;
      unsubscribe = candidate.onSpeech(text => { if (text.includes(challenge)) captured = true; });
      await navigate(`data:text/html,${encodeURIComponent(`<html lang="en"><title>${challenge}</title><button>${challenge}</button></html>`)}`);
      const deadline = now() + 10000;
      while (!captured && now() < deadline) {
        signal.throwIfAborted();
        await candidate.drain();
        if (!captured) await wait(50);
      }
      if (!captured) throw new TalkBackCaptureError('TalkBack did not announce the fresh bootstrap title');
      // Fixtures use this canonical URL to identify the bridge-owned tab. Check
      // capture once more after native focus settles, on the same generation.
      await navigate(NATIVE_BOOTSTRAP_URL);
      await focus();
      await candidate.drain();
      signal.throwIfAborted();
      return candidate;
    } catch (error) {
      await candidate?.close();
      signal.throwIfAborted();
      if (!(error instanceof TalkBackCaptureError)) throw error;
      if (attempt === 3) throw new Error('TalkBack could not verify fresh, uninterrupted bootstrap speech after 3 attempts; check its TTS engine and native focus');
      await wait(250 * attempt);
    } finally { unsubscribe?.(); }
  }
}

async function runOnDevice(options, adb, signal) {
  signal.throwIfAborted();
  if ((await adb('get-state')).toString().trim() !== 'device') throw new Error('Android device is not authorized');
  const api = Number((await adb('shell', 'getprop', 'ro.build.version.sdk')).toString().trim());
  if (!Number.isInteger(api) || api < 34) throw new Error('TalkBack adapter requires Android 14 (API 34) or later');
  if (options.avd) {
    options.voiceEngine = await prepareTalkBackEmulator((...args) => { signal.throwIfAborted(); return adb(...args); }, options);
  }
  signal.throwIfAborted();
  const state = await androidProbe(adb);
  if (!state.browserWindowActive) throw new Error('foreground Chrome on the selected Android device');
  if (options.command === 'doctor') {
    console.log(JSON.stringify({ screenReader: 'talkback', version: state.version, browserVersion: state.browserVersion,
      androidApi: api, nativeProbe: 'ready', captureEngine: 'configured', speechCapture: 'not-tested' }));
    return;
  }
  const token = await loadControlToken(options['token-file']);
  const lease = join(tmpdir(), `hoosaidthat-talkback-${createHash('sha256').update(options.serial).digest('hex').slice(0, 24)}.lease`);
  try { await mkdir(lease, { mode: 0o700 }); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Android device lease is held; stop its bridge first. After a crash, remove ${lease}`);
    throw error;
  }
  let reversePort, forwardPort, devtools, driver, bridge, browser, bootstrap;
  try {
    if (options['reverse-port']) {
      const port = 'tcp:' + Number(options['reverse-port']);
      await adb('reverse', '--no-rebind', port, port);
      reversePort = port;
    }
    const forwarded = (await adb('forward', '--no-rebind', 'tcp:0', 'localabstract:chrome_devtools_remote')).toString().trim();
    if (!/^\d+$/.test(forwarded) || +forwarded < 1 || +forwarded > 65535) throw new Error('adb did not allocate a Chrome debugging forward');
    forwardPort = forwarded;
    devtools = await startAndroidDevtools({ upstreamPort: +forwarded, port: +options['cdp-port'] });
    const { chromium } = await import('@playwright/test');
    browser = await chromium.connectOverCDP(devtools.endpoint);
    const context = browser.contexts()[0];
    if (!context) throw new Error('Android Chrome did not expose its persistent context');
    bootstrap = await context.newPage();
    await bootstrap.bringToFront();
    driver = await verifyTalkBackBootstrap({
      connect: () => TalkBackDriver.connect(adb, { emulatorKeyboard: /^emulator-\d+$/.test(options.serial) }),
      navigate: url => bootstrap.goto(url, { timeout: 10000 }),
      focus: () => androidProbe(adb, 'focusWeb'), signal,
    });
    bridge = await startNativeServer({ screenReader: 'talkback', token, driver,
      probe: () => androidProbe(adb), quietMs: TALKBACK_QUIET_MS, port: +options['control-port'], locale: options.locale,
      browser: { name: 'chrome', version: browser.version(), cdpPort: +options['cdp-port'] } });
    console.log(JSON.stringify({ screenReader: 'talkback', version: state.version, profile: 'talkback-web',
      controlEndpoint: bridge.endpoint, cdpEndpoint: devtools.endpoint, tokenFile: resolve(options['token-file']),
      capture: driver.capture, locale: options.locale, keyboardLayout: 'desktop' }));
    signal.throwIfAborted();
    if (options.command === 'start') {
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    } else {
      const command = options.child.length ? options.child : [process.execPath, createRequire(import.meta.url).resolve('@playwright/test/cli'),
        'test', '--config', fileURLToPath(new URL('../oracle/android-talkback/playwright.config.mjs', import.meta.url))];
      const movie = options.recording ? await startTalkBackMovie({ output: options.recording, serial: options.serial,
        adb, driver, engine: options.voiceEngine, version: state.version, signal }) : undefined;
      try {
        process.exitCode = await runTalkBackConsumer(command, { signal, env: { ...process.env, ANDROID_SERIAL: options.serial,
        SCREEN_READER: 'talkback', SCREEN_READER_LOCALE: options.locale,
        HOOSAIDTHAT_TALKBACK_CONTROL_ENDPOINT: bridge.endpoint, HOOSAIDTHAT_TALKBACK_CDP_ENDPOINT: devtools.endpoint,
        HOOSAIDTHAT_TALKBACK_CONTROL_TOKEN: token } });
        await movie?.finish();
      } catch (error) {
        if (signal.aborted && signal.reason?.signal) {
          process.exitCode = signal.reason.signal === 'SIGINT' ? 130 : 143;
        } else throw error;
      } finally { await movie?.close(); }
    }
  } finally {
    try {
      if (bridge) await bridge.close(); else await driver?.close();
    } finally {
      // Remove only the tab/forward this bridge created, including on external devices.
      await bootstrap?.close().catch(() => {});
      await browser?.close().catch(() => {});
      await devtools?.close();
      if (reversePort) await adb('reverse', '--remove', reversePort).catch(() => {});
      if (forwardPort) await adb('forward', '--remove', `tcp:${forwardPort}`).catch(() => {});
      await rm(lease, { recursive: true, force: true });
    }
  }
}

// npm links the installed POSIX bin to this module. Older Node versions
// lack import.meta.main, so compare the actual file behind that link.
const entry = process.argv[1];
if (import.meta.main ?? (entry && existsSync(entry) && pathToFileURL(realpathSync(entry)).href === import.meta.url)) {
  main().catch(error => { console.error(`TalkBack Android bridge failed: ${error.message}`); process.exitCode = 1; });
}
