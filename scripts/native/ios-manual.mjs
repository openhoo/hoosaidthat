// Capture the user's actual gestures, app screen and routed simulator sound.
// No XCTest attaches to the app or requests/synthesizes speech in this mode.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { inventory, selectDevice, withIPhoneLock } from '../voiceover-ios.mjs';
import { encodeIPhoneMovie, launchCapture, mediaDuration, recordingTools, simulatorPorts, verifyAudioRoute } from './ios-recording.mjs';

const exec = promisify(execFile);
const xcrun = '/usr/bin/xcrun';

async function voiceOver(udid, enabled) {
  const args = enabled === undefined ? ['info', 'voiceover'] : ['settings', 'voiceover', enabled ? '--enable' : '--disable'];
  const { stdout } = await exec(xcrun, ['devicectl', 'device', ...args, '--device', udid, '--json-output', '-'], { timeout: 55_000 });
  // Query responses contain the enabled boolean. A mutation only needs to
  // succeed here; the surrounding session reads device state back separately.
  if (enabled !== undefined) return;
  const { result } = JSON.parse(stdout);
  if (result?.deviceIdentifier?.toLowerCase() !== udid.toLowerCase() || typeof result.enabled !== 'boolean')
    throw Error('Device Hub did not report the VoiceOver state for the selected simulator.');
  return result.enabled;
}

export async function withVoiceOver(udid, use, state = voiceOver) {
  const initial = await state(udid);
  let error, value;
  try {
    if (!initial) await state(udid, true);
    if (!await state(udid)) throw Error('VoiceOver is not enabled on the selected simulator.');
    value = await use(initial);
    if (!await state(udid)) throw Error('VoiceOver was switched off during the recording.');
  } catch (failure) { error = failure; }
  try {
    // A timed-out command can leave VoiceOver enabled. The user might
    // also have toggled it while recording. Restore only when needed.
    if (await state(udid) !== initial) {
      await state(udid, initial);
      if (await state(udid) !== initial) throw Error('Device Hub reports a different state after restoration.');
    }
  } catch (failure) {
    throw Error((error ? error.message + '\n' : '') + 'Could not restore the original VoiceOver state: ' + failure.message);
  }
  if (error) throw error;
  return value;
}

async function checkAudioRoute(udid, audioDevice) {
  const [name, ports] = await Promise.all([recordingTools(audioDevice), simulatorPorts(udid)]);
  // In isolated mode verifyAudioRoute requires an explicit match to the guest route.
  verifyAudioRoute(ports.stdout, name, {}, false);
}

export async function muxManualMovie(screen, rawAudio, output, offsetSeconds) {
  const duration = await mediaDuration(rawAudio);
  if (!(duration >= 0.5) || !Number.isFinite(duration) || !Number.isFinite(offsetSeconds) || offsetSeconds < 0)
    throw Error('The recording was too short or has invalid capture timing.');
  return encodeIPhoneMovie(screen, rawAudio, output, offsetSeconds, duration);
}

// SIGINT also goes to a terminal's foreground process group. Keep the two
// recorders in separate groups so we can stop and flush them exactly once.
async function capture({ udid, audioDevice, scratch, onReady, stop }) {
  const screen = join(scratch, 'screen.mp4'), rawAudio = join(scratch, 'audio.wav');
  const video = launchCapture(xcrun, ['simctl', 'io', udid, 'recordVideo', '--display=internal', '--codec=h264', screen], /Recording started/, { detached: true });
  let audio, closing;
  const close = incomplete => closing ??= Promise.allSettled([video.stop(incomplete), audio?.stop(incomplete)]).then(results => {
    const failure = results.find(result => result.status === 'rejected');
    if (failure && !incomplete) throw failure.reason;
  });
  const unexpected = (process, label) => process.closed.then(result => { throw result.error ?? Error(label + ' recorder exited before the recording was stopped.'); });
  try {
    const videoAt = await video.start();
    audio = launchCapture('ffmpeg', ['-nostdin', '-hide_banner', '-f', 'avfoundation', '-i', ':' + audioDevice,
      '-vn', '-c:a', 'pcm_s16le', '-stats_period', '0.05', '-progress', 'pipe:2', rawAudio], /out_time_us=[1-9]\d*/, { detached: true });
    const audioAt = await Promise.race([audio.start(), unexpected(video, 'Screen')]);
    onReady();
    const reason = await Promise.race([stop, unexpected(video, 'Screen'), unexpected(audio, 'Audio')]);
    await close(false);
    return { screen, rawAudio, reason, offsetSeconds: (audioAt - videoAt) / 1000 };
  } finally { await close(true).catch(() => {}); }
}

export function stopControl(seconds, input = process.stdin, signals = process) {
  let resolve, timer, stopped;
  const stop = new Promise(done => { resolve = done; });
  const finish = reason => { stopped ??= reason; resolve(stopped); };
  const enter = data => { if (/[\r\n]/.test(data.toString())) finish('Enter'); };
  const eof = () => finish('terminal closed');
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(name => [name, () => finish(name)]);
  for (const [name, handler] of handlers) signals.on(name, handler);
  return {
    stop, get stopped() { return stopped; },
    ready() {
      if (seconds) timer = setTimeout(() => finish('duration'), seconds * 1000);
      if (input.isTTY) { input.on('data', enter).once('end', eof); input.resume(); }
    },
    close() {
      clearTimeout(timer);
      if (input.isTTY) { input.off('data', enter).off('end', eof); input.pause(); }
      for (const [name, handler] of handlers) signals.off(name, handler);
    },
  };
}

export async function recordManualIPhone({ udid, audioDevice, parent, seconds }) {
  if (!process.stdin.isTTY && !seconds) throw Error('Provide --duration SECONDS when running --manual without an interactive terminal.');
  const control = stopControl(seconds);
  const checkCanceled = () => { if (control.stopped) throw Error('Recording stopped before it was ready (' + control.stopped + ').'); };
  try {
    const environment = await inventory();
    const device = selectDevice(environment.devices, environment.runtimes, udid);
    if (device.state !== 'Booted') throw Error('Open this iPhone in Device Hub and launch the feature you want to record before running --manual.');
    return await withIPhoneLock(device, async () => {
      checkCanceled();
      await checkAudioRoute(device.udid, audioDevice);
      checkCanceled();
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const output = await mkdtemp(join(parent, 'ios-manual-'));
      console.log('Manual iPhone recording directory: ' + output);
      const scratch = await mkdtemp(join(output, '.capture-'));
      try {
        let previousVoiceOver;
        const result = await withVoiceOver(device.udid, async initial => {
          previousVoiceOver = initial;
          checkCanceled();
          const captured = await capture({ udid: device.udid, audioDevice, scratch, stop: control.stop,
            onReady: () => {
              checkCanceled(); control.ready();
              console.log('Recording now. Drive the selected iPhone in Device Hub. Press Enter or Ctrl-C to save' + (seconds ? ', or wait ' + seconds + ' seconds.' : '.'));
            } });
          await checkAudioRoute(device.udid, audioDevice);
          return captured;
        });
        const file = join(scratch, 'recording.mp4');
        const media = await muxManualMovie(result.screen, result.rawAudio, file, result.offsetSeconds);
        const report = { mode: 'manual', screenReader: 'VoiceOver', device, xcode: environment.xcode, sdk: environment.sdk, stoppedBy: result.reason,
          voiceOver: { enabledBefore: previousVoiceOver, enabledAtStart: true, enabledAtEnd: true, restored: true },
          recording: { file: 'recording.mp4', videoSource: 'simctl selected simulator display', audioSource: 'simulator output via virtual loopback',
            audioDevice, screenOffsetSeconds: result.offsetSeconds, ...media },
          speechContent: 'Not checked. Listen to the movie to verify what VoiceOver said.' };
        await writeFile(join(scratch, 'report.json'), JSON.stringify(report, null, 2) + '\n');
        await rename(file, join(output, 'recording.mp4'));
        await rename(join(scratch, 'report.json'), join(output, 'report.json'));
        console.log('Manual VoiceOver movie: ' + join(output, 'recording.mp4'));
        return { outputDirectory: output, report };
      } finally { await rm(scratch, { recursive: true, force: true }); }
    });
  } finally { control.close(); }
}
