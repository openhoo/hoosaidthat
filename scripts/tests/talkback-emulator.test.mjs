import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareTalkBackEmulator } from '../native/prepare-talkback-emulator.mjs';

const talkback = 'com.google.android.marvin.talkback';
const chrome = 'com.android.chrome';
function fixture({ packages = [chrome, talkback], top = [chrome + '/.Main'], sdk = 35, install = true } = {}) {
  const calls = [];
  const adb = async (...args) => {
    calls.push(args);
    const cmd = args.join(' ');
    if (cmd.includes('ro.build.version.sdk')) return String(sdk);
    if (cmd.includes('pm list packages')) return packages.map(name => 'package:' + name).join('\n');
    if (args[0] === 'install') {
      if (args.at(-1).endsWith('/reader.apk') && install) packages.push(talkback);
      return install ? 'Performing Streamed Install\r\nSuccess\r\n' : 'Failure';
    }
    if (cmd.includes('settings get secure enabled_accessibility_services')) return 'org.example/.Other';
    if (cmd.includes('dumpsys activity activities')) return ' topResumedActivity=ActivityRecord{1 u0 ' + (top.length > 1 ? top.shift() : top[0]) + ' t3}';
    if (cmd.includes('dumpsys accessibility')) return 'TalkBackService';
    if (cmd.includes('/proc/net/unix')) return '@chrome_devtools_remote';
    return '';
  };
  return { calls, run: (options = {}, deps = {}) => prepareTalkBackEmulator(adb, options, { checkFile: async () => {}, wait: async () => {}, ...deps }) };
}
test('a fresh guest installs helpers, selects capture before enabling TalkBack, and preserves other services', async () => {
  const { calls, run } = fixture({ packages: [chrome], top: [talkback + '/.TrainingActivity', chrome + '/.Main'] });
  await run({ 'talkback-apk': '/reader.apk' });
  assert.equal(calls.filter(args => args[0] === 'install').length, 3);
  const commands = calls.map(args => args.join(' '));
  const tts = commands.findIndex(c => c.includes('put secure tts_default_synth'));
  const enable = commands.findIndex(c => c.includes('put secure enabled_accessibility_services'));
  assert.ok(tts >= 0 && enable > tts);
  assert.match(commands[enable], /org\.example\/\.Other:com\.google\.android\.marvin\.talkback\//);
  assert.equal(commands.filter(c => c.endsWith('KEYCODE_BACK')).length, 1);
});
test('missing prerequisites stop before enabling accessibility or selecting a TTS engine', async () => {
  for (const [options, message] of [[{packages: [chrome]}, /Google TalkBack is missing/], [{packages: [talkback]}, /Chrome is missing/], [{sdk: 33}, /API 34/], [{install: false}, /could not install/]]) {
    const { calls, run } = fixture(options);
    await assert.rejects(run(), message);
    assert.ok(!calls.some(args => args.includes('put')));
  }
  await assert.rejects(fixture().run({}, {checkFile: async () => { throw new Error(); }}), /npm run talkback:android:build/);
});
test('a foreground first-run prompt cannot produce false readiness', async () => {
  await assert.rejects(fixture({top: [chrome + '/FirstRunActivity']}).run(), /first-run/);
});
