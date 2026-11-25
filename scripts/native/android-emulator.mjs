import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { createAdb } from './talkback.mjs';

const execute = promisify(execFile);
export const validAvdName = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
function sdkTool(directory, name, override) {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  return override || (sdk ? join(sdk, directory, name + (process.platform === 'win32' ? '.exe' : '')) : name);
}

// The emulator selects both console/adb ports atomically and tells its launcher
// the console port. Never guess emulator-5554 or attach to the first adb device.
export async function listenForEmulatorConsole() {
  let accept, fail;
  const serial = new Promise((resolve, reject) => { accept = resolve; fail = reject; });
  serial.catch(() => {});
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    let data = '';
    socket.setEncoding('ascii').setTimeout(5000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', chunk => {
      data += chunk;
      if (!/^\d{0,5}$/.test(data)) socket.destroy();
    });
    socket.on('end', () => {
      const port = Number(data);
      if (/^\d{4,5}$/.test(data) && port >= 5554 && port <= 5682 && port % 2 === 0) accept(`emulator-${port}`);
      else fail(new Error('Android Emulator reported an invalid console port'));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { port: server.address().port, serial, close() { for (const socket of sockets) socket.destroy(); server.close(); } };
}

async function stopEmulator(child) {
  if (!child?.pid || child.exitCode != null || child.signalCode != null) return;
  if (process.platform === 'win32') {
    // The Windows emulator launcher can own a separate QEMU process.
    try { await execute('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }); }
    catch (error) { if (child.exitCode == null && child.signalCode == null) throw error; }
    return;
  }
  const killGroup = signal => { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  killGroup('SIGTERM');
  for (let i = 0; i < 50 && child.exitCode == null && child.signalCode == null; i++) await sleep(100);
  if (child.exitCode == null && child.signalCode == null) killGroup('SIGKILL');
}

export async function startTalkBackEmulator(avd, {
  signal, listen = listenForEmulatorConsole, stop = stopEmulator, pollMs = 750, bootTimeoutMs = 240000,
  gpu = process.env.HST_EMULATOR_GPU || 'software',
  emulator = sdkTool('emulator', 'emulator', process.env.HST_EMULATOR_BIN),
  listAvds = async () => (await execute(emulator, ['-list-avds'], { windowsHide: true, timeout: 15000 })).stdout.split(/\r?\n/).map(s => s.trim()),
  launch = args => spawn(emulator, args, { windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'] }),
  createDevice = serial => createAdb(serial, sdkTool('platform-tools', 'adb', process.env.HST_ADB_BIN)),
} = {}) {
  if (!validAvdName(avd)) throw new Error('invalid Android virtual device name');
  if (!['software', 'lavapipe', 'swiftshader', 'swangle', 'auto', 'host'].includes(gpu)) {
    throw new Error('HST_EMULATOR_GPU must be software, lavapipe, swiftshader, swangle, auto or host');
  }
  signal?.throwIfAborted();
  let names;
  try { names = await listAvds(); } catch (error) {
    throw new Error(`Cannot list Android virtual devices using ${emulator}; install the SDK emulator and set ANDROID_HOME or HST_EMULATOR_BIN`, { cause: error });
  }
  if (!names.includes(avd)) throw new Error(`Android virtual device ${avd} does not exist; create it first and check emulator -list-avds`);
  signal?.throwIfAborted();
  const report = await listen();
  let child, closed, timer, onAbort, startupError = '';
  const close = () => (closed ??= Promise.resolve().then(() => child && stop(child)));
  const interrupted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => reject(new Error(`Timed out booting AVD ${avd}; check emulator acceleration, disk space and adb`)), bootTimeoutMs);
  });
  try {
    signal?.throwIfAborted();
    child = launch(['-avd', avd, '-read-only', '-no-snapshot', '-no-window', '-no-audio', '-no-boot-anim', '-no-metrics', '-gpu', gpu,
      ...(gpu === 'lavapipe' ? ['-feature', '-Vulkan'] : []), '-report-console', `tcp:${report.port}`]);
    child.stderr?.on('data', chunk => { startupError = (startupError + chunk).slice(-2000); });
    const exited = new Promise((_, reject) => {
      child.once('error', error => reject(new Error(`Cannot launch Android emulator: ${error.message}`)));
      child.once('exit', (code, sig) => reject(new Error(`Android emulator exited (${sig || code})${startupError ? ': ' + startupError.trim() : ''}`)));
    });
    const wait = promise => Promise.race([promise, interrupted, exited]);
    const serial = await wait(report.serial);
    const adb = createDevice(serial);
    for (;;) {
      // ADB may see the transport before Android's framework has booted.
      const ready = await wait(adb('shell', 'getprop', 'sys.boot_completed').then(value => String(value).trim() === '1', () => false));
      if (ready) break;
      await wait(sleep(pollMs));
    }
    const identity = String(await wait(adb('emu', 'avd', 'name'))).trim().split(/\r?\n/);
    if (identity[0] !== avd) throw new Error(`Emulator ${serial} reported a different AVD; refusing to configure it`);
    return { serial, adb, close, exited };
  } catch (error) { await close(); throw error; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); report.close(); }
}
