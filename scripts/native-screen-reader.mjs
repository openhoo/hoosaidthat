#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { ATDriver } from './native/at-driver.mjs';
import { VoiceOverDriver } from './native/voiceover.mjs';
import { assertNativePlatform, nativeProbe } from './native/platform.mjs';
import { nativeCommands } from './native/commands.mjs';
import { startNativeServer } from './native/server.mjs';
import { NATIVE_BOOTSTRAP_URL } from '../dist/bootstrap.js';

export function parseArguments(args) {
  const options = {};
  const allowed = new Set(['screen-reader', 'at-driver-endpoint', 'token-file', 'control-port', 'cdp-port', 'locale', 'browser-executable']);
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]?.slice(2);
    const value = args[index + 1];
    if (!args[index]?.startsWith('--') || !allowed.has(name) || typeof value !== 'string' || !value || value.startsWith('--') || name in options) {
      throw new Error('invalid or duplicate native bridge option; use --help');
    }
    options[name] = value;
  }
  if (!['voiceover'].includes(options['screen-reader'])) throw new Error('--screen-reader voiceover is required');
  if (!options['token-file']) throw new Error('--token-file is required (an existing token is reused; a new token is written privately)');
  for (const [key, fallback] of [['control-port', '3003'], ['cdp-port', '9225']]) {
    options[key] ??= fallback;
    if (!/^\d+$/.test(options[key]) || +options[key] < 1024 || +options[key] > 65535) throw new Error(`invalid --${key}`);
  }
  if (+options['control-port'] === +options['cdp-port']) throw new Error('control and CDP ports must differ');
  options.locale ??= 'en-US';
  if (!['en-US', 'de-DE'].includes(options.locale)) throw new Error('locale must be en-US or de-DE');
  return options;
}

export async function loadControlToken(path) {
  path = resolve(path);
  try {
    const token = (await readFile(path, 'utf8')).trim();
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error('invalid native control token file');
    return token;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const token = randomBytes(32).toString('base64url');
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${token}\n`, { flag: 'wx', mode: 0o600 });
    return token;
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: hoosaidthat-native --screen-reader voiceover --token-file PATH [options]

Run in an interactive macOS guest with VoiceOver already running and Chrome
installed. VoiceOver uses its native scripting API; --at-driver-endpoint selects
the experimental AT Driver transport.
Node.js 22+ is required for this host command. See docs/native-screen-readers.md.

  --at-driver-endpoint URL   default ws://127.0.0.1:4382/session
  --control-port PORT       default 3003 (loopback only)
  --cdp-port PORT           default 9225 (loopback only)
  --locale en-US|de-DE       must match the reader's configured language
  --browser-executable PATH optional Chrome/Chromium executable

The command starts a dedicated browser profile, verifies native reader identity,
AX focus and actual speech capture, then serves HooSaidThat protocol v2.
The token file is created privately when missing. Its contents are never printed.
Use one Playwright worker per native desktop. Ctrl+C closes the owned browser.`);
    return;
  }
  const screenReader = options['screen-reader'];
  assertNativePlatform(screenReader);
  if (typeof globalThis.WebSocket !== 'function') throw new Error('the native bridge requires Node.js 22 or later');
  const token = await loadControlToken(options['token-file']);
  const { chromium } = await import('@playwright/test');
  const directory = await mkdtemp(join(tmpdir(), `hoosaidthat-${screenReader}-`));
  let context, driver, bridge;
  try {
    context = await chromium.launchPersistentContext(directory, {
      headless: false, viewport: null, chromiumSandbox: true,
      ...(options['browser-executable'] ? { executablePath: options['browser-executable'] } : { channel: 'chrome' }),
      args: [`--remote-debugging-port=${options['cdp-port']}`, '--remote-debugging-address=127.0.0.1', '--force-renderer-accessibility'],
    });
    const browser = context.browser();
    const cdp = await browser.newBrowserCDPSession();
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    await cdp.detach();
    const browserPid = processInfo.find(item => item.type === 'browser')?.id;
    if (!Number.isSafeInteger(browserPid) || browserPid <= 0) throw new Error('CDP did not identify the native browser process');
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(NATIVE_BOOTSTRAP_URL);
    await page.bringToFront();
    const probe = () => nativeProbe(screenReader, browserPid, {
      voiceOverCursor: screenReader === 'voiceover' && !options['at-driver-endpoint'],
    });
    // VoiceOver may have no cursor until the first browser announcement.
    // Attest native identity first; cursor membership is required after entry.
    const state = await nativeProbe(screenReader, browserPid);
    if (!state.browserWindowActive) throw new Error('the owned browser must be foreground in the interactive desktop');
    driver = options['at-driver-endpoint']
      ? await ATDriver.connect(options['at-driver-endpoint'], screenReader)
      : await VoiceOverDriver.connect();
    // Establish actual web interaction before readiness. An AX-focused web
    // area alone can leave VoiceOver's cursor in Chrome's toolbar. Native Tab
    // enters our button and supplies a verifiable native announcement.
    let captured = false;
    driver.onSpeech(text => { if (/^screen reader ready\b/i.test(text.trim())) captured = true; });
    // Allow the reader's initial browser/window announcement to settle before
    // the first Tab. Twenty gestures also cover a full Chrome toolbar cycle.
    await new Promise(resolve => setTimeout(resolve, 1000));
    for (let attempt = 0; !captured && attempt < 20; attempt++) {
      await driver.press(nativeCommands(screenReader).nextFocusable);
      const deadline = Date.now() + 750;
      while (!captured && Date.now() < deadline) {
        driver.assertReady();
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    if (!captured) {
      throw new Error('the native reader did not announce the bootstrap web control; check scripting, keyboard navigation and the configured capture voice');
    }
    if (!(await probe()).webContentFocused) throw new Error('the native bootstrap announcement was captured but its web control no longer has native focus');
    bridge = await startNativeServer({ screenReader, token, driver, probe,
      port: +options['control-port'], locale: options.locale,
      browser: { name: 'chrome', version: browser.version(), cdpPort: +options['cdp-port'] } });
    console.log(JSON.stringify({ screenReader, version: state.version, profile: `${screenReader}-web`,
      controlEndpoint: bridge.endpoint, cdpEndpoint: `http://127.0.0.1:${options['cdp-port']}`,
      tokenFile: resolve(options['token-file']), keyboardLayout: 'desktop', locale: options.locale }));
    await new Promise(resolve => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
      context.once('close', resolve);
    });
  } finally {
    if (bridge) await bridge.close();
    else await driver?.close();
    await context?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Native screen reader bridge failed: ${error.message}`); process.exitCode = 1; });
}
