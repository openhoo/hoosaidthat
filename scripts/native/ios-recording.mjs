import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export function selectLoopback(profile, requested, dedicatedMac = false) {
  const inputs = (profile.SPAudioDataType ?? []).flatMap(group => group._items ?? []).filter(d => d.coreaudio_device_input > 0);
  const devices = inputs.filter(d => d.coreaudio_device_transport === 'coreaudio_device_type_virtual' && d.coreaudio_device_input > 0 && d.coreaudio_device_output > 0);
  const eligible = devices.filter(d => requested === undefined || d._name === requested);
  if (eligible.length !== 1 || !eligible[0]._name || eligible[0]._name.includes(':')) {
    throw new Error('Select a dedicated virtual loopback with --audio-device NAME and route Device Hub → Device → Sound → Sound Output to it. Available virtual input/output devices: ' + (devices.map(d => d._name).join(', ') || 'none'));
  }
  const device = eligible[0];
  if (/^(?:default$|[+-]?\d)/i.test(device._name) || inputs.some(d => d !== device && d._name?.startsWith(device._name))) {
    throw new Error('Choose a unique loopback name that cannot select another AVFoundation input by index, default, or prefix.');
  }
  if (!dedicatedMac && (device.coreaudio_default_audio_output_device === 'spaudio_yes' || device.coreaudio_default_audio_system_device === 'spaudio_yes')) {
    throw new Error('The selected loopback is the default Mac output. Keep Mac audio on a different output and route only the simulator to the loopback in Device Hub.');
  }
  return device._name;
}

export function verifyAudioRoute(ports, device, profile, dedicatedMac) {
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const uid = new RegExp('^\\s*([^\\s:]+): ' + escape(device) + ' \\(\\d+ In / \\d+ Out\\)', 'm').exec(ports)?.[1];
  const route = /Guest Audio Output -> ([^\n]+)/.exec(ports)?.[1]?.trim();
  if (uid && route === 'Host Audio Device #' + uid) return uid;
  if (dedicatedMac && uid && route === 'Default Host Audio Device' && (profile.SPAudioDataType ?? []).some(group =>
    (group._items ?? []).some(d => d._name === device && d.coreaudio_default_audio_output_device === 'spaudio_yes'))) return uid;
  throw new Error('The selected simulator is not routed to ' + device + '. In Device Hub select Device → Sound → Sound Output and choose that loopback. Simulator reports: ' + (route || 'unknown output') + '.');
}

export async function recordingTools(requested, dedicatedMac = false) {
  const [profile] = await Promise.all([
    audioProfile(),
    ...['ffmpeg', 'ffprobe'].map(tool => exec(tool, ['-version'], { timeout: 10_000 }).catch(() => { throw new Error('iPhone recording requires ffmpeg and ffprobe on PATH.'); })),
  ]);
  if (dedicatedMac && !requested) throw new Error('Recording a dedicated Mac output requires an explicit --audio-device NAME.');
  return selectLoopback(JSON.parse(profile.stdout), requested, dedicatedMac);
}

export function launchCapture(command, args, readyPattern, { detached = false } = {}) {
  const child = spawn(command, args, { detached, stdio: ['pipe', 'ignore', 'pipe'] });
  child.stdin.on('error', () => {}); // The process may exit while we ask it to stop.
  let log = '', first, notify, readyAt;
  const ready = new Promise(resolve => { notify = resolve; });
  child.stderr.on('data', chunk => {
    log = (log + chunk.toString()).slice(-5000);
    if (!readyAt && readyPattern.test(log)) { readyAt = performance.now(); notify(readyAt); }
  });
  const closed = new Promise(resolve => {
    child.once('error', error => resolve({ error }));
    child.once('close', (status, signal) => resolve({ status, signal }));
  });
  const exited = () => new Error('Recorder stopped: ' + command + ': ' + log.trim());
  return {
    closed,
    async start() {
      let timer;
      try {
        first = await Promise.race([ready, closed.then(x => { throw x.error ?? exited(); }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out starting ' + command + ': ' + log.trim())), 20_000); })]);
        return first;
      } finally { clearTimeout(timer); }
    },
    async stop(allowIncomplete = false) {
      const wasRunning = child.exitCode === null && child.signalCode === null && child.pid;
      if (wasRunning) child.kill('SIGINT');
      const force = setTimeout(() => child.kill('SIGKILL'), 10_000);
      let result;
      try { result = await closed; } finally { clearTimeout(force); }
      if (!allowIncomplete && (!wasRunning || result.error || result.signal === 'SIGKILL' || ![0, 255, null].includes(result.status))) throw result.error ?? exited();
    },
  };
}

// Compile for the user's host architecture with the same Xcode used by the
// simulator. The executable stays in the private per-recording scratch folder.
export async function prepareLoopback(scratch) {
  const helper = join(scratch, 'capture-loopback');
  const source = fileURLToPath(new URL('./ios-loopback.c', import.meta.url));
  await exec('/usr/bin/xcrun', ['--sdk', 'macosx', 'clang', '-std=c11', '-O2', source,
    '-framework', 'AudioToolbox', '-framework', 'CoreAudio', '-framework', 'CoreFoundation', '-o', helper], { timeout: 90_000 });
  return (uid, wav, options) => launchCapture(helper, [uid, wav], /HST loopback received PCM/, options);
}

export function verifyCaptureInterval(rawAudioSeconds, captureWallSeconds) {
  // The first/last hardware buffers straddle our process notifications. Allow
  // that startup/stop jitter plus a small amount of device clock drift.
  const tolerance = Math.min(2.5, 0.65 + 0.001 * captureWallSeconds);
  if (!(captureWallSeconds >= 0.5) || !Number.isFinite(captureWallSeconds) ||
      !(rawAudioSeconds >= 0.5) || !Number.isFinite(rawAudioSeconds) ||
      Math.abs(rawAudioSeconds - captureWallSeconds) > tolerance) {
    throw Error('Incomplete simulator audio: received ' + Number(rawAudioSeconds).toFixed(3) +
      ' s of PCM during ' + Number(captureWallSeconds).toFixed(3) + ' s of recording. Check the simulator sound route and host load.');
  }
}

export async function inspectMovie(file) {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,duration', '-of', 'json', file], { timeout: 30_000 });
  const streams = JSON.parse(stdout).streams ?? [];
  const video = streams.find(s => s.codec_type === 'video');
  const audio = streams.find(s => s.codec_type === 'audio');
  if (streams.length !== 2 || video?.codec_name !== 'h264' || audio?.codec_name !== 'aac' || !video.width || !video.height ||
      !(Number(video.duration) >= 0.5) || !(Number(audio.duration) >= 0.5) || Math.abs(Number(video.duration) - Number(audio.duration)) > 0.6) {
    throw new Error('Expected one H.264 screen track and one synchronized AAC audio track in the recording.');
  }
  const { stderr } = await exec('ffmpeg', ['-nostdin', '-hide_banner', '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { timeout: 120_000 });
  const peakDb = Number(/max_volume:\s*(-?[\d.]+) dB/.exec(stderr)?.[1]);
  if (!(peakDb > -55)) throw new Error('No usable simulator audio in the movie. Check Device Hub sound output, VoiceOver volume and the selected loopback; a silent movie cannot pass.');
  return { durationSeconds: Number(video.duration), width: video.width, height: video.height, peakDb };
}

export async function mediaDuration(file) {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 30_000 });
  return Number(stdout.trim());
}

export async function encodeIPhoneMovie(screen, rawAudio, output, offset, duration) {
  // Simulator screen captures can stop on the last changed frame. Hold that
  // frame until the end of the real audio without generating any sound.
  // Apple can emit two frames with the same presentation time. Ignore decode
  // timestamps: otherwise FFmpeg can shift later screen changes several seconds
  // early. Expand sparse frames before cutting so the initial held image survives.
  const filter = 'fps=24:start_time=0,tpad=stop_mode=clone:stop=-1,trim=start=' + offset.toFixed(3) + ',setpts=PTS-STARTPTS';
  await exec('ffmpeg', ['-nostdin', '-v', 'error', '-fflags', '+igndts', '-i', screen, '-i', rawAudio, '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-vf', filter, '-c:a', 'aac', '-b:a', '128k',
    '-t', duration.toFixed(3), '-movflags', '+faststart', output], { timeout: Math.max(600_000, duration * 3000) });
  return inspectMovie(output);
}

// Both CoreAudio discovery calls can take more than 20s on a freshly booted Mac.
// They only inspect routes; a timeout can safely be retried once.
async function inspectRoute(description, command, args) {
  for (let attempt = 0; ; attempt++) {
    try { return await exec(command, args, { timeout: 90_000 }); }
    catch (error) {
      if (attempt === 0 && error.killed) continue;
      throw new Error('Could not inspect ' + description + ': ' + (error.killed ? 'timed out twice after 90 seconds.' : error.stderr?.trim() || error.message));
    }
  }
}

export const simulatorPorts = udid => inspectRoute('the simulator audio route', '/usr/bin/xcrun', ['simctl', 'io', udid, 'enumerate']);
const audioProfile = () => inspectRoute('Mac audio devices', '/usr/sbin/system_profiler', ['SPAudioDataType', '-json']);

// The XCTest calls this private loopback endpoint immediately before and after scenario steps.
export async function createRecording(output, udid, audioDevice, dedicatedMac = false) {
  const [ports, profile] = await Promise.all([
    simulatorPorts(udid),
    audioProfile(),
  ]);
  const uid = verifyAudioRoute(ports.stdout, audioDevice, JSON.parse(profile.stdout), dedicatedMac);
  const scratch = await mkdtemp(join(output, '.recording-'));
  const key = '/' + randomUUID();
  const rawAudio = join(scratch, 'route.wav');
  let openLoopback;
  try { openLoopback = await prepareLoopback(scratch); }
  catch (error) { await rm(scratch, { recursive: true, force: true }); throw error; }
  let finalized = false;
  let audio, state = 'idle', audioAt, audioClock, captureWallSeconds, fault, pending, stopPromise, closing;
  const stop = (incomplete = false) => stopPromise ??= Promise.allSettled([audio?.stop(incomplete)]).then(results => {
    const failure = results.find(x => x.status === 'rejected');
    if (failure && !incomplete) throw failure.reason;
  });
  const server = createServer(async (request, response) => {
    const op = request.url;
    if (request.method !== 'POST' || ![key + '/start', key + '/stop'].includes(op)) { response.writeHead(404).end(); return; }
    try {
      if (op.endsWith('/start') && state === 'idle') {
        state = 'starting';
        audio = openLoopback(uid, rawAudio);
        pending = audio.start();
        audioClock = await pending;
        // The clock used by xcresulttool attachment timestamps is Unix wall time.
        audioAt = Date.now() / 1000;
        state = 'recording';
      } else if (op.endsWith('/stop') && state === 'recording') {
        captureWallSeconds = (performance.now() - audioClock) / 1000;
        state = 'stopping'; await stop(); state = 'captured';
      } else { response.writeHead(409).end(); return; }
      response.writeHead(200).end();
    } catch (error) { fault = error; state = 'failed'; await stop(true).catch(() => {}); response.writeHead(500).end(error.message.slice(-1000)); }
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  } catch (error) { await rm(scratch, { recursive: true, force: true }); throw error; }
  return {
    endpoint: 'http://127.0.0.1:' + server.address().port + key,
    async finalize(screen) {
      if (fault) throw fault;
      if (state !== 'captured') throw new Error('XCTest did not complete the requested feature recording.');
      if (!screen || !Number.isFinite(screen.timestamp)) throw new Error('XCTest did not attach a screen movie for the selected simulator.');
      const file = join(scratch, 'recording.mp4');
      const [duration, screenDuration] = await Promise.all([mediaDuration(rawAudio), mediaDuration(screen.file)]);
      verifyCaptureInterval(duration, captureWallSeconds);
      const offset = audioAt - screen.timestamp;
      if (!Number.isFinite(duration) || duration < 0.5 || !(offset >= -0.5 && offset < screenDuration))
        throw new Error('The XCTest screen attachment does not overlap the recorded feature audio.');
      const media = await encodeIPhoneMovie(screen.file, rawAudio, file, Math.max(0, offset), duration);
      verifyCaptureInterval(media.durationSeconds, captureWallSeconds);
      await rename(file, join(output, 'recording.mp4'));
      finalized = true;
      return { file: 'recording.mp4', videoSource: 'XCTest device screen recording', screenOffsetSeconds: Math.max(0, offset), audioSource: dedicatedMac ? 'dedicated Mac output via virtual loopback (includes host audio)' : 'simulator output via virtual loopback', audioDevice, captureWallSeconds, rawAudioSeconds: duration, sourceVideoSeconds: screenDuration, ...media };
    },
    close() {
      return closing ??= (async () => {
        server.close(); server.closeAllConnections();
        await stop(true).catch(() => {}); await pending?.catch(() => {});
        if (!finalized && process.env.CI === 'true' && process.env.HST_IOS_KEEP_FAILED_AUDIO === '1') {
          try { await rename(rawAudio, join(output, 'failed-scenario-audio.wav')); }
          catch (error) { if (error.code !== 'ENOENT') console.error('Could not retain failed scenario audio: ' + error.message); }
        }
        await rm(scratch, { recursive: true, force: true });
      })();
    },
  };
}
