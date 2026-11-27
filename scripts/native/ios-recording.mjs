import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export function selectLoopback(profile, requested, dedicatedMac = false) {
  const devices = (profile.SPAudioDataType ?? []).flatMap(group => group._items ?? [])
    .filter(d => d.coreaudio_device_transport === 'coreaudio_device_type_virtual' && d.coreaudio_device_input > 0 && d.coreaudio_device_output > 0);
  const eligible = devices.filter(d => requested === undefined || d._name === requested);
  if (eligible.length !== 1 || !eligible[0]._name || eligible[0]._name.includes(':')) {
    throw new Error('Select a dedicated virtual loopback with --audio-device NAME and route Device Hub → Device → Sound → Sound Output to it. Available virtual input/output devices: ' + (devices.map(d => d._name).join(', ') || 'none'));
  }
  const device = eligible[0];
  if (!dedicatedMac && (device.coreaudio_default_audio_output_device === 'spaudio_yes' || device.coreaudio_default_audio_system_device === 'spaudio_yes')) {
    throw new Error('The selected loopback is the default Mac output. Keep Mac audio on a different output and route only the simulator to the loopback in Device Hub.');
  }
  return device._name;
}

export function verifyAudioRoute(ports, device, profile, dedicatedMac) {
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const uid = new RegExp('^\\s*([^\\s:]+): ' + escape(device) + ' \\(\\d+ In / \\d+ Out\\)', 'm').exec(ports)?.[1];
  const route = /Guest Audio Output -> ([^\n]+)/.exec(ports)?.[1]?.trim();
  if (uid && route === 'Host Audio Device #' + uid) return;
  if (dedicatedMac && uid && route === 'Default Host Audio Device' && (profile.SPAudioDataType ?? []).some(group =>
    (group._items ?? []).some(d => d._name === device && d.coreaudio_default_audio_output_device === 'spaudio_yes'))) return;
  throw new Error('The selected simulator is not routed to ' + device + '. In Device Hub select Device → Sound → Sound Output and choose that loopback. Simulator reports: ' + (route || 'unknown output') + '.');
}

export async function recordingTools(requested, dedicatedMac = false) {
  const [profile] = await Promise.all([
    exec('/usr/sbin/system_profiler', ['SPAudioDataType', '-json'], { timeout: 20_000 }),
    ...['ffmpeg', 'ffprobe'].map(tool => exec(tool, ['-version'], { timeout: 10_000 }).catch(() => { throw new Error('iPhone recording requires ffmpeg and ffprobe on PATH.'); })),
  ]);
  if (dedicatedMac && !requested) throw new Error('Recording a dedicated Mac output requires an explicit --audio-device NAME.');
  return selectLoopback(JSON.parse(profile.stdout), requested, dedicatedMac);
}

function launch(command, args, readyPattern) {
  const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'pipe'] });
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

// The XCTest calls this private loopback endpoint immediately before and after scenario steps.
// No build, startup probe, unrelated desktop pixels, or physical microphone enter the movie.
export async function createRecording(output, udid, audioDevice, dedicatedMac = false) {
  const [ports, profile] = await Promise.all([
    exec('/usr/bin/xcrun', ['simctl', 'io', udid, 'enumerate'], { timeout: 20_000 }),
    exec('/usr/sbin/system_profiler', ['SPAudioDataType', '-json'], { timeout: 20_000 }),
  ]);
  verifyAudioRoute(ports.stdout, audioDevice, JSON.parse(profile.stdout), dedicatedMac);
  const scratch = await mkdtemp(join(output, '.recording-'));
  const key = '/' + randomUUID();
  const rawVideo = join(scratch, 'screen.mp4'), rawAudio = join(scratch, 'route.wav');
  let video, audio, state = 'idle', videoAt, audioAt, fault, pending, stopPromise, closing;
  const stop = (incomplete = false) => stopPromise ??= Promise.allSettled([video?.stop(incomplete), audio?.stop(incomplete)]).then(results => {
    const failure = results.find(x => x.status === 'rejected');
    if (failure && !incomplete) throw failure.reason;
  });
  const server = createServer(async (request, response) => {
    const op = request.url;
    if (request.method !== 'POST' || ![key + '/start', key + '/stop'].includes(op)) { response.writeHead(404).end(); return; }
    try {
      if (op.endsWith('/start') && state === 'idle') {
        state = 'starting';
        audio = launch('ffmpeg', ['-hide_banner', '-nostdin', '-f', 'avfoundation', '-i', ':' + audioDevice,
          '-vn', '-c:a', 'pcm_s16le', '-stats_period', '0.05', '-progress', 'pipe:2', rawAudio], /out_time_us=[1-9]\d*/);
        video = launch('/usr/bin/xcrun', ['simctl', 'io', udid, 'recordVideo', '--codec=h264', rawVideo], /Recording started/i);
        pending = Promise.all([video.start(), audio.start()]);
        [videoAt, audioAt] = await pending;
        state = 'recording';
      } else if (op.endsWith('/stop') && state === 'recording') {
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
    async finalize() {
      if (fault) throw fault;
      if (state !== 'captured') throw new Error('XCTest did not complete the requested feature recording.');
      const file = join(scratch, 'recording.mp4');
      // Drop the lead-in of whichever capture started first. Re-encode the screen to allow a frame-accurate cut.
      const common = Math.max(videoAt, audioAt);
      const seconds = n => (n / 1000).toFixed(3);
      const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', rawAudio], {timeout: 20_000});
      const duration = Number(stdout.trim()) - (common - audioAt) / 1000;
      if (!Number.isFinite(duration) || duration < 0.5) throw new Error('Too little simulator audio was captured.');
      // simctl captures changed frames only; trim AFTER padding so a static final screen still covers the audio.
      const filter = 'tpad=stop_mode=clone:stop=-1,trim=start=' + seconds(common - videoAt) + ',setpts=PTS-STARTPTS,fps=24';
      await exec('ffmpeg', ['-nostdin', '-v', 'error', '-i', rawVideo, '-ss', seconds(common - audioAt), '-i', rawAudio,
        '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'veryfast', '-vf', filter,
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-t', duration.toFixed(3), '-movflags', '+faststart', file], {timeout: 10 * 60_000});
      const media = await inspectMovie(file);
      await rename(file, join(output, 'recording.mp4'));
      return { file: 'recording.mp4', audioSource: dedicatedMac ? 'dedicated Mac output via virtual loopback (includes host audio)' : 'simulator output via virtual loopback', audioDevice, ...media };
    },
    close() {
      return closing ??= (async () => {
        server.close(); server.closeAllConnections();
        await stop(true).catch(() => {}); await pending?.catch(() => {});
        await rm(scratch, { recursive: true, force: true });
      })();
    },
  };
}
