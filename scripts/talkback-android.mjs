#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createAdb, androidProbe, TalkBackDriver } from './native/talkback.mjs';
import { startAndroidDevtools } from './native/android-devtools.mjs';
import { startNativeServer } from './native/server.mjs';
import { loadControlToken } from './native/token.mjs';
import { NATIVE_BOOTSTRAP_URL } from '../dist/bootstrap.js';

export function parseTalkBackArguments(args) {
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  const command = args[0] ?? 'help';
  if (!['doctor', 'start', 'run'].includes(command)) throw new Error('use doctor, start, or run; see --help');
  const split = args.indexOf('--');
  const options = { command, child: split < 0 ? [] : args.slice(split + 1) };
  const flags = split < 0 ? args.slice(1) : args.slice(1, split);
  const allowed = new Set(['serial', 'token-file', 'control-port', 'cdp-port', 'locale']);
  for (let index = 0; index < flags.length; index += 2) {
    const name = flags[index]?.slice(2), value = flags[index + 1];
    if (!flags[index]?.startsWith('--') || !allowed.has(name) || typeof value !== 'string' || !value || value.startsWith('--') || name in options) {
      throw new Error('invalid or duplicate TalkBack option; use --help');
    }
    options[name] = value;
  }
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(options.serial ?? '')) throw new Error('--serial must identify one authorized Android device');
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

async function main() {
  const options = parseTalkBackArguments(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: hoosaidthat-talkback-android doctor|start|run --serial SERIAL [options] [-- command args...]

Connect a dedicated Android 14+ device or emulator running real TalkBack and
Chrome. Install both helper APKs and select the capture TTS engine first.
The helper captures text synthesis requests and produces silent PCM.

  --serial SERIAL           required; never selects an arbitrary device
  --token-file PATH         required for start/run; privately created or reused
  --control-port PORT       default 3005, host loopback only
  --cdp-port PORT           default 9227, host loopback only
  --locale en-US|de-DE      must match TalkBack's configured language

doctor verifies the prepared device. start serves the adapter until Ctrl+C.
run serves the adapter while running a child command; without a child it runs
the packaged TalkBack smoke tests. It sets HOOSAIDTHAT_TALKBACK_* and
SCREEN_READER=talkback for the child. Only owned adb forwarding is removed.
See oracle/android-talkback/README.md for setup and qualification limits.`);
    return;
  }
  const adb = createAdb(options.serial);
  if ((await adb('get-state')).toString().trim() !== 'device') throw new Error('Android device is not authorized');
  const api = Number((await adb('shell', 'getprop', 'ro.build.version.sdk')).toString().trim());
  if (!Number.isInteger(api) || api < 34) throw new Error('TalkBack adapter requires Android 14 (API 34) or later');
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
  let forwardPort, devtools, driver, bridge, browser, bootstrap;
  try {
    const forwarded = (await adb('forward', '--no-rebind', 'tcp:0', 'localabstract:chrome_devtools_remote')).toString().trim();
    if (!/^\d+$/.test(forwarded) || +forwarded < 1 || +forwarded > 65535) throw new Error('adb did not allocate a Chrome debugging forward');
    forwardPort = forwarded;
    devtools = await startAndroidDevtools({ upstreamPort: +forwarded, port: +options['cdp-port'] });
    const { chromium } = await import('@playwright/test');
    browser = await chromium.connectOverCDP(devtools.endpoint);
    const context = browser.contexts()[0];
    if (!context) throw new Error('Android Chrome did not expose its persistent context');
    bootstrap = await context.newPage();
    await bootstrap.goto(NATIVE_BOOTSTRAP_URL);
    await bootstrap.bringToFront();
    await androidProbe(adb, 'focusWeb');
    driver = await TalkBackDriver.connect(adb);
    let captured = false;
    driver.onSpeech(text => { if (text.trim()) captured = true; });
    await driver.press('readCurrent');
    const deadline = Date.now() + 10000;
    while (!captured && Date.now() < deadline) { await driver.drain(); await new Promise(resolve => setTimeout(resolve, 50)); }
    if (!captured) throw new Error('TalkBack produced no captured speech; check its TTS engine and native focus');
    bridge = await startNativeServer({ screenReader: 'talkback', token, driver,
      probe: () => androidProbe(adb), port: +options['control-port'], locale: options.locale,
      browser: { name: 'chrome', version: browser.version(), cdpPort: +options['cdp-port'] } });
    console.log(JSON.stringify({ screenReader: 'talkback', version: state.version, profile: 'talkback-web',
      controlEndpoint: bridge.endpoint, cdpEndpoint: devtools.endpoint, tokenFile: resolve(options['token-file']),
      capture: driver.capture, locale: options.locale, keyboardLayout: 'desktop' }));
    if (options.command === 'start') {
      await new Promise(resolve => {
        const stop = () => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); resolve(); };
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
      });
    } else {
      const command = options.child.length ? options.child : [process.execPath, createRequire(import.meta.url).resolve('@playwright/test/cli'),
        'test', '--config', fileURLToPath(new URL('../oracle/android-talkback/playwright.config.mjs', import.meta.url))];
      const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: { ...process.env,
        SCREEN_READER: 'talkback', SCREEN_READER_LOCALE: options.locale,
        HOOSAIDTHAT_TALKBACK_CONTROL_ENDPOINT: bridge.endpoint, HOOSAIDTHAT_TALKBACK_CDP_ENDPOINT: devtools.endpoint,
        HOOSAIDTHAT_TALKBACK_CONTROL_TOKEN: token } });
      const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM');
      process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
      try {
        process.exitCode = await new Promise((resolve, reject) => {
          child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
        });
      } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); }
    }
  } finally {
    try {
      if (bridge) await bridge.close(); else await driver?.close();
    } finally {
      // The prepared device and its Chrome profile remain operator owned.
      await bootstrap?.close().catch(() => {});
      await browser?.close().catch(() => {});
      await devtools?.close();
      if (forwardPort) await adb('forward', '--remove', `tcp:${forwardPort}`).catch(() => {});
      await rm(lease, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`TalkBack Android bridge failed: ${error.message}`); process.exitCode = 1; });
}
