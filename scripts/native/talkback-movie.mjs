import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, chmod, link, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const execute = promisify(execFile);

export function hasVoicedRequest(events, receipts) {
  const ids = new Set(receipts.trim().split('\n').filter(Boolean).map(line => {
    const r = JSON.parse(line);
    return r.generation + ':' + r.sequence;
  }));
  return events.some(e => ids.has(e.generation + ':' + e.sequence));
}

export async function validateTalkBackMovie(ffmpeg, movie) {
  const { stderr } = await execute(ffmpeg, ['-nostdin', '-hide_banner', '-nostats', '-xerror', '-i', movie, '-map', '0:v:0', '-map', '0:a:0',
    '-vf', 'scale=16:16', '-af', 'volumedetect', '-f', 'null', '-'], { timeout: 300000, maxBuffer: 1024 * 1024 });
  const peak = /max_volume:\s*([-\d.]+) dB/.exec(stderr);
  if (!peak || Number(peak[1]) <= -90 || !/frame=\s*[1-9]/.test(stderr)) throw new Error('Android movie contains no decodable video frames or audible guest output');
}

export async function startTalkBackMovie({ output, serial, adb, driver, engine, version, signal }) {
  output = resolve(output);
  const transcript = output + '.talkback.jsonl';
  for (const file of [output, transcript]) {
    try { await access(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error('Recording output already exists: ' + file);
  }
  if (process.platform === 'win32') throw new Error('Use WSL, Linux or macOS to stop the Android movie recorder cleanly');
  const scrcpy = process.env.HST_SCRCPY_BIN || 'scrcpy';
  const ffmpeg = process.env.HST_FFMPEG_BIN || 'ffmpeg';
  try { await execute(ffmpeg, ['-version'], { timeout: 5000 }); }
  catch { throw new Error('Install FFmpeg to validate the Android movie, or set HST_FFMPEG_BIN'); }
  await mkdir(dirname(output), { recursive: true });
  const stage = await mkdtemp(join(dirname(output), '.hoosaidthat-movie-'));
  const movie = join(stage, 'capture.mp4'), sidecar = join(stage, 'speech.jsonl');
  let child, exited, unsubscribe, finished = false, stopping, startTime, failReady, readyTimer, pollReady;
  const events = [];
  async function stop() {
    if (!child?.pid || child.exitCode != null || child.signalCode != null) return;
    if (!stopping) stopping = (async () => {
      child.kill('SIGINT');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
      try { await exited; } finally { clearTimeout(timer); }
    })();
    await stopping;
  }
  const onAbort = () => { failReady?.(signal.reason); stop().catch(() => {}); };
  async function close() {
    signal.removeEventListener('abort', onAbort);
    unsubscribe?.(); clearTimeout(readyTimer); clearInterval(pollReady);
    try { await stop(); } finally { await rm(stage, { recursive: true, force: true }); }
  }
  try {
    signal.throwIfAborted();
    const env = { ...process.env };
    if (env.HST_ADB_BIN) env.ADB = env.HST_ADB_BIN;
    else if (env.ANDROID_HOME || env.ANDROID_SDK_ROOT) env.ADB = join(env.ANDROID_HOME || env.ANDROID_SDK_ROOT, 'platform-tools', 'adb');
    child = spawn(scrcpy, ['--serial', serial, '--no-playback', '--no-window', '--no-control', '--require-audio',
      '--audio-source=output', '--audio-codec=aac', '--video-codec=h264', '--record', movie],
    { stdio: ['ignore', 'pipe', 'pipe'], env });
    exited = new Promise((res, rej) => { child.once('error', rej); child.once('exit', (code, sig) => res({ code, sig })); });
    exited.catch(() => {});
    let logs = '';
    const ready = new Promise((res, rej) => {
      failReady = rej;
      const read = chunk => {
        logs = (logs + chunk).slice(-12000);
        if (/Recording started to mp4 file:/i.test(logs)) res();
      };
      child.stdout.on('data', read); child.stderr.on('data', read);
      // Some scrcpy builds fully buffer console output in a pipe. The fresh
      // MP4 file header is also definitive evidence the muxer actually opened.
      pollReady = setInterval(async () => {
        let fd;
        try {
          fd = await open(movie, 'r');
          const h = Buffer.alloc(8);
          if ((await fd.read(h, 0, h.length, 0)).bytesRead === 8 && h.toString('ascii', 4) === 'ftyp') res();
        } catch { /* The recorder may not have opened the file yet. */ }
        finally { await fd?.close().catch(() => {}); }
      }, 100);
      readyTimer = setTimeout(() => rej(new Error('scrcpy did not start recording within 30 seconds')), 30000);
    });
    signal.addEventListener('abort', onAbort, { once: true });
    signal.throwIfAborted();
    await Promise.race([ready, exited.then(() => { throw new Error('scrcpy could not record emulator audio/video: ' + logs.trim().slice(-1200)); })]);
    clearTimeout(readyTimer); clearInterval(pollReady);
    startTime = performance.now();
    await driver.drain();
    unsubscribe = driver.onSpeech((text, event) => events.push({ kind: 'speech', sequence: event.sequence,
      generation: event.generation, elapsedRealtimeMs: event.elapsedRealtimeMs, observedMs: Math.round(performance.now() - startTime), text }));
    // Keep the startup challenge and its queued playback out of feature films.
    // The helper was silent during bootstrap; only new requests can be audible.
    await adb('shell', 'run-as', 'dev.openhoo.hoosaidthat.tts', 'touch', 'files/recording-live');
    return { close, async finish() {
      if (finished) return;
      signal.throwIfAborted();
      // Let an utterance already requested reach the emulator audio stream.
      // Wait for its synthesis receipt, then allow the device mixer to drain.
      await driver.drain();
      let receipts = '';
      for (let i = 0; i < 20; i++) {
        signal.throwIfAborted();
        receipts = String(await adb('exec-out', 'run-as', 'dev.openhoo.hoosaidthat.tts', 'cat', 'files/voiced.jsonl'));
        if (events.length && hasVoicedRequest([events.at(-1)], receipts)) break;
        await delay(150, undefined, { signal }); await driver.drain();
      }
      await delay(1000, undefined, { signal }); await driver.drain();
      unsubscribe(); unsubscribe = undefined;
      if (!hasVoicedRequest(events, receipts)) throw new Error('No TalkBack request produced audible Android speech during the feature; check the target, voice data and --tts-engine');
      if (child.exitCode != null || child.signalCode != null) throw new Error('scrcpy stopped before the feature finished');
      await stop();
      const { code, sig } = await exited;
      if (code !== 0 && sig !== 'SIGINT') throw new Error('scrcpy could not finalize the Android movie');
      await validateTalkBackMovie(ffmpeg, movie);
      await chmod(movie, 0o600);
      const metadata = { kind: 'recording', schemaVersion: 1, reader: 'talkback', readerVersion: version, voiceEngine: engine,
        audio: 'Android guest output (including TalkBack and app sounds)', transcript: 'TalkBack UID synthesis requests; interruptions may be audible' };
      await writeFile(sidecar, [metadata, ...events].map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
      await link(sidecar, transcript);
      try { await link(movie, output); } catch (error) { await rm(transcript, { force: true }); throw error; }
      finished = true;
      console.log('TalkBack movie: ' + output + '\nTalkBack transcript: ' + transcript);
    } };
  } catch (error) {
    await close();
    if (error.code === 'ENOENT') throw new Error('Install scrcpy for Android movie capture, or set HST_SCRCPY_BIN');
    throw error;
  }
}
