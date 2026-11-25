import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const talkback = 'com.google.android.marvin.talkback';
const chrome = 'com.android.chrome';
const capture = 'dev.openhoo.hoosaidthat.tts';
const component = talkback + '/com.google.android.marvin.talkback.TalkBackService';
const helpers = fileURLToPath(new URL('../../oracle/android-talkback/build/', import.meta.url));

// Called only for the read-only AVD instance launched by this process.
export async function prepareTalkBackEmulator(adb, options, { checkFile = access, wait = delay } = {}) {
  const shell = async (...args) => (await adb('shell', ...args)).toString().trim();
  const packages = async () => new Set((await shell('pm', 'list', 'packages')).split(/\r?\n/).map(s => s.replace(/^package:/, '')));
  const api = Number(await shell('getprop', 'ro.build.version.sdk'));
  if (!Number.isInteger(api) || api < 34) throw new Error('the TalkBack AVD requires an Android 14 (API 34) or newer system image');
  let installed = await packages();
  if (!installed.has(chrome)) throw new Error('Chrome is missing; choose a Google Play AVD with com.android.chrome installed');
  async function install(path, label) {
    try { await checkFile(path); } catch {
      throw new Error(label + ' not found: ' + path + (label.includes('helper') ? '; build both APKs with npm run talkback:android:build first' : ''));
    }
    try {
      const output = (await adb('install', '-r', path)).toString();
      if (!/^Success\s*$/m.test(output)) throw new Error('missing install acknowledgement');
    } catch (error) {
      throw new Error('could not install ' + label + ': ' + error.message + '; check its signature, Android version and ABI');
    }
  }
  if (options['talkback-apk']) {
    await install(resolve(options['talkback-apk']), 'TalkBack APK');
    installed = await packages();
  }
  if (!installed.has(talkback)) throw new Error('Google TalkBack is missing; install Android Accessibility Suite in the base AVD or provide --talkback-apk PATH');
  await install(resolve(helpers, 'hoosaidthat-capture.apk'), 'capture helper');
  await install(resolve(helpers, 'hoosaidthat-probe.apk'), 'probe helper');
  // Android 13+ TalkBack and Chrome request notification permission at first use.
  // Grant only that permission, if the installed reader actually declares it.
  for (const pkg of [talkback, chrome]) {
    const manifest = await shell('dumpsys', 'package', pkg);
    if (/^\s*android\.permission\.POST_NOTIFICATIONS\s*$/m.test(manifest)) {
      await shell('pm', 'grant', pkg, 'android.permission.POST_NOTIFICATIONS');
    }
  }
  const settings = (...args) => shell('settings', ...args);
  const existing = (await settings('get', 'secure', 'enabled_accessibility_services')).split(':').filter(v => v && v !== 'null');
  if (!existing.every(v => /^[\w.$]+\/[\w.$]+$/.test(v))) throw new Error('invalid accessibility service list in the AVD');
  // Preserve every other accessibility service in the disposable guest.
  await settings('put', 'secure', 'tts_default_synth', capture);
  if (!existing.includes(component)) await settings('put', 'secure', 'enabled_accessibility_services', [...existing, component].join(':'));
  await settings('put', 'secure', 'accessibility_enabled', '1');
  await shell('input', 'keyevent', 'KEYCODE_WAKEUP');
  await shell('wm', 'dismiss-keyguard');
  // Same first-run switch used by Playwright's Android Chrome launcher.
  await shell('am', 'set-debug-app', '--persistent', chrome);
  await shell('echo "_ --disable-fre --no-default-browser-check" > /data/local/tmp/chrome-command-line');
  await shell('am', 'force-stop', chrome);
  const openChrome = () => shell('am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'about:blank', chrome);
  await openChrome();
  let dismissedTutorial = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const top = (await shell('dumpsys', 'activity', 'activities')).split(/\r?\n/).find(line => /(?:topResumedActivity|mResumedActivity)\s*[:=]/.test(line)) || '';
    if (top.includes(talkback + '/') && top.includes('TrainingActivity') && !dismissedTutorial) {
      await shell('input', 'keyevent', 'KEYCODE_BACK');
      dismissedTutorial = true;
      await openChrome();
    } else if (top.includes(chrome + '/') && !/FirstRun|FreActivity/.test(top)) {
      const bound = await shell('dumpsys', 'accessibility');
      if (bound.includes('TalkBackService') && (await shell('cat', '/proc/net/unix')).includes('chrome_devtools_remote')) return;
    }
    await wait(500);
  }
  throw new Error('TalkBack and Chrome did not become ready; finish the TalkBack tutorial and Chrome first-run prompts in the base AVD, then retry');
}
