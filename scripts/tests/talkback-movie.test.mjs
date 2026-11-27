import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hasVoicedRequest, startTalkBackMovie, validateTalkBackMovie } from '../native/talkback-movie.mjs';
import { parseTalkBackArguments } from '../talkback-android.mjs';

test('movie capture requires a disposable AVD and scopes adb reverse / voice configuration to that device', () => {
  const run = ['run','--avd','Pixel','--token-file','/tmp/unused','--recording','x.mp4'];
  assert.equal(parseTalkBackArguments([...run,'--reverse-port','8080','--tts-engine','com.google.android.tts'])['reverse-port'], '8080');
  for (const args of [['run','--serial','emulator-5554','--token-file','k','--recording','x.mp4'],
    [...run,'--reverse-port','65536'], [...run,'--tts-engine','com.ex;am'], ['start',...run.slice(1)]]) assert.throws(() => parseTalkBackArguments(args));
});
test('a receipt from a different engine generation or utterance is not evidence for this movie', () => {
  const events = [{ generation:'new', sequence:4 }];
  const receipts = JSON.stringify({generation:'old', sequence:4}) + '\n' + JSON.stringify({generation:'new', sequence:2});
  assert.equal(hasVoicedRequest(events, receipts), false);
  assert.equal(hasVoicedRequest(events, receipts + '\n' + JSON.stringify(events[0])), true);
});
test('a pre-existing transcript is preserved without starting any recorder', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hst-movie-collision-')); t.after(() => rm(dir, { recursive:true, force:true }));
  const output = join(dir,'evidence.mp4'), transcript = output + '.talkback.jsonl';
  await writeFile(transcript, 'previous evidence');
  await assert.rejects(startTalkBackMovie({output}), /already exists/);
  assert.equal(await readFile(transcript,'utf8'), 'previous evidence');
});
test('the movie validator decodes frames and rejects an AAC track containing only silence', async t => {
  try { execFileSync('ffmpeg', ['-version'], {stdio:'ignore'}); } catch { t.skip('FFmpeg unavailable'); return; }
  const dir = await mkdtemp(join(tmpdir(), 'hst-movie-audio-')); t.after(() => rm(dir, { recursive:true, force:true }));
  for (const [name, source] of [['silent','anullsrc'], ['audible','sine=frequency=330']]) {
    const path = join(dir, name + '.mp4');
    execFileSync('ffmpeg',['-loglevel','error','-f','lavfi','-i','color=c=blue:s=32x32:r=12','-f','lavfi','-i',source,'-t','0.5',
      '-c:v','mpeg4','-c:a','aac', path]);
    const check = validateTalkBackMovie('ffmpeg', path);
    if (name === 'silent') await assert.rejects(check, /audible guest output/); else await check;
  }
});
