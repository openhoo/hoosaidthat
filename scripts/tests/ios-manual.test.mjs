import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { promisify } from 'node:util';
import { parseRecording } from '../record-mobile.mjs';
import { muxManualMovie, stopControl, withVoiceOver } from '../native/ios-manual.mjs';
const exec = promisify(execFile);

test('manual mode requires one named simulator, isolated audio and a bounded optional duration', () => {
  const flags = ['ios','--manual','--udid','a','--audio-device','BlackHole 2ch'];
  assert.equal(parseRecording([...flags,'--duration','3600']).options['--manual'], true);
  for (const extra of [['--duration','0'],['--duration','3601'],['--duration','1.5'],['--scenario','s'],['--dedicated-mac-output'],['--manual'],['--','npm','test']]) {
    assert.throws(() => parseRecording([...flags,...extra]));
  }
  for (const invalid of [['ios','--manual','--udid','a'],['ios','--manual','--audio-device','Virtual'],['ios','--duration','2'],['android','--avd','a','--manual']]) {
    assert.throws(() => parseRecording(invalid));
  }
});

test('manual recording restores a disabled reader even after a failed capture, and preserves an enabled reader', async () => {
  for (const initial of [false, true]) {
    let enabled = initial;
    const changes = [];
    const state = async (_id, newState) => {
      if (typeof newState === 'boolean') { enabled = newState; changes.push(enabled); }
      return enabled;
    };
    await assert.rejects(withVoiceOver('sim', async () => { assert.equal(enabled,true); throw Error('capture failed'); }, state), /capture failed/);
    assert.equal(enabled, initial);
    assert.deepEqual(changes, initial ? [] : [true,false]);
  }
});

test('a manual capture fails if the reader was turned off during recording and restores its original state', async () => {
  let enabled = true;
  const state = async (_id, value) => value === undefined ? enabled : (enabled = value);
  await assert.rejects(withVoiceOver('sim', async () => { enabled = false; }, state), /switched off/);
  assert.equal(enabled, true);
});

test('manual stop waits for a newline, finalizes on SIGINT or timer, and detaches input and signal handlers', async () => {
  for (const expected of ['Enter','SIGINT','duration']) {
    const signals = new EventEmitter(), input = new PassThrough(); input.isTTY = expected === 'Enter';
    const ctrl = stopControl(expected === 'duration' ? 0.01 : undefined, input, signals);
    try {
      ctrl.ready();
      if (expected === 'Enter') { input.write('text'); assert.equal(ctrl.stopped,undefined); input.write('\n'); }
      else if (expected === 'SIGINT') signals.emit('SIGINT');
      assert.equal(await ctrl.stop, expected);
      signals.emit('SIGINT');
      assert.equal(ctrl.stopped, expected);
    } finally { ctrl.close(); input.destroy(); }
    assert.equal(signals.listenerCount('SIGINT'), 0);
    assert.equal(input.listenerCount('data'), 0);
  }
});

test('manual mux holds the last screen frame through speech and rejects silence', async t => {
  try { await Promise.all(['ffmpeg','ffprobe'].map(cmd => exec(cmd,['-version']))); }
  catch { t.skip('requires FFmpeg and ffprobe'); return; }
  const dir = await mkdtemp(join(tmpdir(),'hst-manual-mux-'));
  const screen = join(dir,'screen.mp4'), sound = join(dir,'sound.wav'), silent = join(dir,'silent.wav');
  const gen = args => exec('ffmpeg',['-nostdin','-v','error',...args]);
  try {
    await Promise.all([
      gen(['-f','lavfi','-i','color=red:size=64x48:duration=0.25','-c:v','libx264',screen]),
      gen(['-f','lavfi','-i','sine=frequency=400:duration=1.5',sound]),
      gen(['-f','lavfi','-i','anullsrc=channel_layout=mono:duration=1',silent]),
    ]);
    const media = await muxManualMovie(screen,sound,join(dir,'movie.mp4'),0.35,1.5);
    await assert.rejects(muxManualMovie(screen,sound,join(dir,'truncated.mp4'),0,39), /Incomplete simulator audio/);
    assert.equal(media.width,64); assert.ok(media.durationSeconds > 1.4); assert.ok(media.peakDb > -55);
    await assert.rejects(muxManualMovie(screen,silent,join(dir,'silent.mp4'),0,1), /No usable simulator audio/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
