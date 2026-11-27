#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { access, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { androidScenario } from './mobile-scenario.mjs';

const local = path => fileURLToPath(new URL(path, import.meta.url));
const help = `Record a mobile feature with a real screen reader.

  hoosaidthat-record ios --manual --udid UUID --audio-device NAME [--duration SECONDS]
  hoosaidthat-record ios [--scenario feature.json] --audio-device NAME [--udid UUID]
  hoosaidthat-record android --avd NAME [--scenario feature.json]
  hoosaidthat-record android --avd NAME -- npx playwright test checkout.spec.ts

  --results DIR       parent for a new run directory (default: test-results/mobile-recordings)
  --manual            drive an already booted iPhone yourself; Enter or Ctrl-C saves the movie
  --duration SECONDS  stop a manual recording after 1–3600 seconds (required without a terminal)
  --scenario FILE     feature to exercise; omit for the packaged smoke test
  --audio-device NAME isolated simulator audio loopback input (iOS)
  --dedicated-mac-output  include whole-host output via that named virtual device (dedicated Mac only)
  --avd NAME          disposable copy of an existing Android Virtual Device with TalkBack
  --locale LOCALE     configured TalkBack locale: en-US or de-DE
  --tts-engine PACKAGE  installed Android speech engine (default: AVD preference)
  --reverse-port PORT   expose a host loopback service to a custom Android command
  --talkback-apk FILE optional trusted local APK to install in that disposable emulator

Requires a prepared simulator; see docs/mobile-recordings.md for prerequisites and examples.`;
export function parseRecording(args) {
  const split = args.indexOf('--');
  const own = split < 0 ? args : args.slice(0, split);
  if (!own.length || own.includes('--help') || own.includes('-h')) return { help: true };
  const [platform, ...flags] = own;
  if (!['android','ios'].includes(platform)) throw Error(help);
  const allowed = ['--results','--scenario', ...(platform === 'ios' ? ['--udid','--audio-device','--dedicated-mac-output','--manual','--duration'] : ['--avd','--locale','--talkback-apk','--tts-engine','--reverse-port'])];
  const options = Object.create(null);
  for (let i = 0; i < flags.length;) {
    const key = flags[i++];
    if (platform === 'ios' && ['--dedicated-mac-output','--manual'].includes(key) && !(key in options)) {
      options[key] = true;
      continue;
    }
    const value = flags[i++];
    if (!allowed.includes(key) || key in options || !value?.trim() || value.startsWith('--')) throw Error('Invalid or duplicate ' + key + '. See --help.');
    options[key] = value;
  }
  if (options['--dedicated-mac-output'] && !options['--audio-device']) throw Error('Name the virtual --audio-device when recording dedicated Mac output.');
  if (options['--manual'] && (!options['--udid'] || !options['--audio-device'] || options['--scenario'] || options['--dedicated-mac-output'])) {
    throw Error('--manual needs an explicit --udid and --audio-device, with a simulator-only audio route and no --scenario.');
  }
  if (options['--duration'] && (!options['--manual'] || !/^\d{1,4}$/.test(options['--duration']) || +options['--duration'] < 1 || +options['--duration'] > 3600))
    throw Error('--duration requires iOS --manual and a whole number from 1 to 3600 seconds.');
  const child = split < 0 ? [] : args.slice(split + 1);
  if (split >= 0 && (platform !== 'android' || !child.length || options['--scenario'])) throw Error('Use either --scenario or an Android -- command, and provide the command after --.');
  if (options['--reverse-port'] && (!child.length || !/^\d{1,5}$/.test(options['--reverse-port']) ||
      +options['--reverse-port'] < 1 || +options['--reverse-port'] > 65535)) throw Error('--reverse-port requires a port (1–65535) and an Android -- command.');
  if (platform === 'android' && !options['--avd']) throw Error('Select an Android emulator with --avd NAME.');
  return { platform, options, child };
}
async function invoke(args, env) {
  const child = spawn(process.execPath, args, { stdio: 'inherit', env });
  const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt).on('SIGTERM', terminate);
  try {
    const code = await new Promise((ok, fail) => {
      child.once('error', fail);
      child.once('close', (code, signal) => ok(code ?? (signal === 'SIGINT' ? 130 : 143)));
    });
    if (code !== 0) throw Object.assign(Error('Recorder command exited with status ' + code), { exitCode: code });
  } finally { process.off('SIGINT', interrupt).off('SIGTERM', terminate); }
}
export async function recordMobile(args) {
  const { help: showHelp, platform, options, child } = parseRecording(args);
  if (showHelp) { console.log(help); return; }
  const parent = resolve(options['--results'] ?? 'test-results/mobile-recordings');
  const scenario = options['--scenario'] && resolve(options['--scenario']);
  if (platform === 'ios' && options['--manual']) {
    const { recordManualIPhone } = await import('./native/ios-manual.mjs');
    return recordManualIPhone({ udid: options['--udid'], audioDevice: options['--audio-device'], parent, seconds: Number(options['--duration']) || undefined });
  }
  if (platform === 'ios') {
    const flags = Object.entries(options).filter(([k]) => k !== '--results').flatMap(([k,v]) => v === true ? [k] : [k,v]);
    return invoke([local('./voiceover-ios.mjs'), 'record', '--results', parent, ...flags], process.env);
  }
  const feature = scenario && androidScenario(JSON.parse(await readFile(scenario, 'utf8')));
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const run = await mkdtemp(join(parent, 'android-'));
  const privateDir = await mkdtemp(join(tmpdir(), 'hst-record-'));
  const movie = join(run, 'recording.mp4');
  console.log('TalkBack recording directory: ' + run);
  const env = { ...process.env, HST_TALKBACK_RESULTS: join(run,'playwright') };
  try {
    const helpers = env.HST_TALKBACK_HELPERS ?? local('../oracle/android-talkback/build/');
    try {
      await Promise.all(['capture','probe'].map(name => access(join(helpers, 'hoosaidthat-' + name + '.apk'))));
    } catch (error) {
      if (env.HST_TALKBACK_HELPERS || error.code !== 'ENOENT') throw error;
      env.HST_TALKBACK_HELPERS = join(privateDir, 'helpers');
      await invoke([local('./build-talkback.mjs')], env);
    }
    const flags = Object.entries(options).filter(([k]) => !['--results','--scenario'].includes(k)).flat();
    let command = child;
    if (feature) {
      // Preserve the original origin, including localhost's secure-context behavior.
      const url = new URL(feature.url);
      if (['localhost','127.0.0.1','[::1]'].includes(url.hostname)) flags.push('--reverse-port', url.port || (url.protocol === 'https:' ? '443' : '80'));
      env.HST_RECORD_SCENARIO = scenario;
      command = [process.execPath, createRequire(import.meta.url).resolve('@playwright/test/cli'), 'test', '--config', local('../oracle/android-talkback/record-feature.config.mjs')];
    }
    await invoke([local('./talkback-android.mjs'), 'run', ...flags, '--recording', movie, '--token-file', join(privateDir,'token'),
      ...(command.length ? ['--', ...command] : [])], env);
    await access(movie);
    console.log('TalkBack movie: ' + movie);
  } finally { await rm(privateDir, { recursive: true, force: true }); }
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => undefined) === fileURLToPath(import.meta.url)) {
  recordMobile(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = error.exitCode ?? 1; });
}
