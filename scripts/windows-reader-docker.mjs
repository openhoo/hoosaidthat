#!/usr/bin/env node
// WinHoo owns the Windows VM and its disk. HooSaidThat owns the reader OEM and
// readiness checks. Run inside the local Linux distribution on a Windows host.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveWinhooRuntime } from '../oracle/windows-nvda/winhoo-image.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = fileURLToPath(import.meta.url);
const names = new Set(['nvda', 'jaws']);
const usage =
  'Usage: hoosaidthat-windows-reader <nvda|jaws> <doctor|init|up|status|wait|sync|run -- COMMAND [ARG...]|down>';
const help =
  usage +
  '\n\nRun inside Linux or WSL2 with a local Docker engine and the WinHoo desktop image.\n' +
  'doctor checks the host; init prepares a private runtime; up boots Windows; wait checks real reader readiness.\n' +
  'run starts a test with the reader endpoints and token and stops any VM it started. A manual up stays running.\n' +
  'sync updates the installed reader bridge on a running guest. down stops the desktop and retains its disk.';

function run(file, args, options = {}) {
  const p = spawnSync(file, args, { encoding: 'utf8', timeout: 15000, ...options });
  // Never format argv; the child environment and Docker's inspect output may contain secrets.
  if (p.error || p.status !== 0)
    throw new Error(
      `${file} failed: ${String(p.error?.message || p.stderr || 'exit ' + p.status)
        .trim()
        .slice(-700)}`,
    );
  return p.stdout?.trim();
}
function json(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}
function secret(path, value) {
  try {
    writeFileSync(path, value, { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
}
function atomic(path, content) {
  const tmp = path + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}
function usableDevice(path) {
  try {
    accessSync(path, constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
function folder(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}
function localDocker() {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch))
    throw new Error(
      'Run the Docker desktop controller inside Linux (including WSL2), using its local Docker engine.',
    );
  const endpoint =
    process.env.DOCKER_CONTEXT || !process.env.DOCKER_HOST
      ? run('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])
      : process.env.DOCKER_HOST;
  if (!endpoint.startsWith('unix://'))
    throw new Error(
      'WinHoo requires a local Docker Unix socket; remote engine contexts cannot use these private guest paths.',
    );
  run('docker', ['compose', 'version']);
  const info = JSON.parse(run('docker', ['info', '--format', '{{json .}}']));
  const arch = process.arch === 'x64' ? 'amd64' : 'arm64';
  if (
    info.OSType !== 'linux' ||
    !(arch === 'amd64' ? ['amd64', 'x86_64'] : ['arm64', 'aarch64']).includes(info.Architecture)
  )
    throw new Error('WinHoo needs a Linux engine matching the controller architecture.');
  if (typeof info.ID !== 'string' || !info.ID)
    throw new Error('Docker did not report an engine identity.');
  return { arch, id: info.ID };
}
function verifyEngine(root, id) {
  const pin = join(root, 'winhoo-docker.engine.json');
  if (!existsSync(pin)) return;
  const bound = json(pin);
  if (bound.engine !== 'docker' || bound.identity !== id)
    throw new Error('The local Docker engine identity changed; refusing to access this guest.');
}
function volumeExists(name) {
  return run('docker', ['volume', 'ls', '--filter', 'name=^' + name + '$', '--format', '{{.Name}}'])
    .split(/\r?\n/)
    .includes(name);
}
function resources(root, config, retained) {
  const fs = statfsSync(root);
  const hostFree = Number(fs.bavail) * Number(fs.bsize);
  // This probe mounts no guest data, uses the exact installed image and exits
  // without starting Windows. A separate Docker filesystem may be much fuller.
  const out = run('docker', [
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--entrypoint',
    'df',
    config.image,
    '-Pk',
    '/',
  ]);
  const m = /^\S+\s+\d+\s+\d+\s+(\d+)\s+\d+%\s+\/$/m.exec(out);
  if (!m) throw new Error('Docker storage probe failed: no filesystem capacity returned.');
  const engineFree = Number(m[1]) * 1024;
  const min = retained ? 8 : config.name.includes('nvda') ? 40 : 35;
  if (Math.min(hostFree, engineFree) < min * 2 ** 30)
    throw new Error(
      'WinHoo needs ' +
        min +
        ' GiB free; controller ' +
        (hostFree / 2 ** 30).toFixed(1) +
        ' GiB, Docker ' +
        (engineFree / 2 ** 30).toFixed(1) +
        ' GiB.',
    );
  return {
    hostFreeGiB: Math.floor(hostFree / 2 ** 30),
    dockerFreeGiB: Math.floor(engineFree / 2 ** 30),
  };
}
const sockets = { nvda: 39972, jaws: 39973 };
async function lease(reader) {
  const server = createServer((s) => s.destroy());
  await new Promise((ok, fail) => {
    server.once('error', (e) => fail(new Error(`${reader} desktop lease unavailable: ${e.code}`)));
    server.listen(sockets[reader], '127.0.0.1', ok);
  });
  return () => new Promise((ok) => server.close(ok));
}
export function readerConfig(
  reader,
  { root, arch, acceleration, image, cloned, sparseBackup = false },
) {
  if (!names.has(reader)) throw new Error('Unsupported Windows reader');
  const nvda = reader === 'nvda',
    name = 'hoosaidthat-' + reader;
  const net = nvda
    ? [
        [8008, 8006],
        [3392, 3389],
        [2224, 22],
        [3002, 3000],
        [9224, 9222],
      ]
    : [
        [8009, 8006],
        [3393, 3389],
        [3004, 3000],
        [9226, 9222],
      ];
  const ports = net.map(([host, guest]) => ({ host, guest, protocol: 'tcp' }));
  ports.push({ host: nvda ? 3392 : 3393, guest: 3389, protocol: 'udp' });
  return {
    schema: 'winhoo.desktop/1',
    name: name + '-oracle',
    project: name,
    hostname: nvda ? 'HST-NVDA-ORACLE' : 'HST-JAWS-ORACLE',
    engine: 'docker',
    architecture: arch,
    acceleration,
    image,
    buildImage: false,
    volume: name + '-' + createHash('sha256').update(root).digest('hex').slice(0, 16),
    storage: join(root, 'state'),
    shared: join(root, 'shared'),
    oem: join(root, 'oem'),
    environmentFile: join(root, '.env'),
    legacyBind: cloned,
    adoptLegacy: false,
    ownerGeneration: null,
    ports,
    ...(sparseBackup ? { diskBackup: 'sparse' } : {}),
    environment: {
      HOST: nvda ? 'HST-NVDA-ORACLE' : 'HST-JAWS-ORACLE',
      VERSION: '11',
      CPU_CORES: acceleration === 'kvm' ? '4' : '2',
      RAM_SIZE: nvda ? '8G' : '4G',
      DISK_SIZE: '64G',
      WIDTH: '1920',
      HEIGHT: '1080',
      AUDIO: 'Y',
      LANGUAGE: 'English',
      REGION: 'en-US',
      KEYBOARD: 'en-US',
      USERNAME: nvda ? 'HstOracle' : 'HstJaws',
      VERIFY: 'Y',
      USER_PORTS: nvda ? '22,3000,9222' : '3000,9222',
    },
  };
}
function state(root, config, expected) {
  const result = run('docker', [
    'ps',
    '--all',
    '--no-trunc',
    '--filter',
    'name=^/' + config.name + '$',
    '--format',
    '{{.ID}}',
  ]);
  if (!result) {
    if (expected) throw new Error('Owned Docker container disappeared during this run.');
    return null;
  }
  if (!/^[a-f0-9]{64}$/.test(result) || (expected && expected !== result))
    throw new Error('Owned Docker container identity changed.');
  const [record] = JSON.parse(run('docker', ['container', 'inspect', result]));
  verifyReaderContainer(root, config, result, record);
  return { id: result, running: record.State.Running, status: record.State.Status };
}
export function verifyReaderContainer(root, config, result, record) {
  const owner = createHash('sha256').update(join(root, 'winhoo-docker.json')).digest('hex');
  const mounts = Object.fromEntries(record.Mounts.map((m) => [m.Destination, m]));
  const bindings = record.HostConfig?.PortBindings ?? {};
  const expectedPorts = config.ports.every(({ host, guest, protocol }) => {
    const published = bindings[guest + '/' + protocol];
    return (
      published?.length === 1 &&
      published[0].HostIp === '127.0.0.1' &&
      published[0].HostPort === String(host)
    );
  });
  if (
    !expectedPorts ||
    Object.keys(bindings).length !== config.ports.length ||
    record.Id !== result ||
    record.Name !== '/' + config.name ||
    record.Image !== config.image ||
    record.Config.Labels?.['io.openhoo.winhoo.desktop'] !== owner ||
    mounts['/shared']?.Type !== 'bind' ||
    mounts['/shared'].Source !== config.shared ||
    mounts['/oem']?.Type !== 'bind' ||
    mounts['/oem'].Source !== config.oem ||
    mounts['/oem'].RW !== false ||
    (config.legacyBind
      ? mounts['/storage']?.Type !== 'bind' || mounts['/storage'].Source !== config.storage
      : mounts['/storage']?.Type !== 'volume' || mounts['/storage'].Name !== config.volume)
  )
    throw new Error(
      'The named Docker container does not match this reader’s WinHoo image, owner and mounted storage.',
    );
}
export function ownedDockerGuest(reader, root, expected) {
  const { id } = localDocker();
  root = realpathSync(root);
  verifyEngine(root, id);
  const config = json(join(root, 'winhoo-docker.json'));
  if (config.name !== 'hoosaidthat-' + reader + '-oracle' || config.shared !== join(root, 'shared'))
    throw new Error('Saved Docker configuration does not belong to this reader.');
  const current = state(root, config, expected);
  if (!current?.running) throw new Error('The owned WinHoo desktop is not running.');
  return current.id;
}
function phase(root, reader) {
  const path = join(
    root,
    'shared',
    'bootstrap',
    reader === 'jaws' ? 'status.json' : 'oem-status.json',
  );
  if (!existsSync(path)) return null;
  if (lstatSync(path).size > 65536) throw new Error('Oversized guest provisioning receipt');
  let p;
  try {
    p = json(path);
  } catch (e) {
    if (e instanceof SyntaxError) return null;
    throw e;
  }
  if (p.phase === 'failed' || p.status === 'failed')
    throw new Error('Guest provisioning failed: ' + String(p.error || p.phase).slice(0, 500));
  return String(p.phase ?? p.status).slice(0, 120);
}
function stageInputs(reader, root) {
  const oracle = join(project, 'oracle', 'windows-' + reader),
    oem = join(root, 'oem');
  folder(oem);
  cpSync(join(oracle, 'oem'), oem, { recursive: true });
  if (reader === 'nvda') {
    run(process.execPath, [join(project, 'scripts/nvda-windows.mjs'), 'docker-prepare-oem'], {
      stdio: 'inherit',
      env: { ...process.env, HST_NVDA_ENGINE: 'docker', HST_NVDA_RUNTIME_ROOT: root },
    });
    return;
  }
  secret(join(root, '.env'), 'WINDOWS_PASSWORD=' + randomBytes(24).toString('base64url') + '\n');
  secret(join(root, 'shared/secrets/control-token'), randomBytes(48).toString('base64url') + '\n');
  cpSync(join(oracle, 'runtime-lock.json'), join(oem, 'runtime-lock.json'));
  packJaws(oem, root);
}
function packJaws(oem, root) {
  const tmp = mkdtempSync(join(root, '.pack-'));
  try {
    // Installed consumers must give us the actual package, including its built bridge.
    if (!existsSync(join(project, 'dist/index.js')))
      throw new Error('Build HooSaidThat before staging the JAWS OEM (npm ci && npm run build).');
    const [{ filename }] = JSON.parse(
      run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', tmp], {
        cwd: project,
        timeout: 120000,
        maxBuffer: 32 * 1024 * 1024,
      }),
    );
    if (!/^[\w.@-]+\.tgz$/.test(filename)) throw new Error('Unexpected npm pack result');
    renameSync(join(tmp, filename), join(oem, 'hoosaidthat.tgz'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
function refreshJaws(root, controller, configPath, config, containerId) {
  const oracle = join(project, 'oracle/windows-jaws');
  const parent = join(root, 'shared/updates');
  folder(parent);
  const stage = mkdtempSync(join(parent, '.stage-'));
  let script;
  try {
    packJaws(stage, root);
    const names = ['hoosaidthat.tgz', 'runtime-lock.json', 'start-runtime.ps1', 'run-check.ps1'];
    for (const name of names.slice(1))
      cpSync(
        name === 'runtime-lock.json' ? join(oracle, name) : join(oracle, 'oem', name),
        join(stage, name),
      );
    const hashes = names.map((n) =>
      createHash('sha256')
        .update(readFileSync(join(stage, n)))
        .digest('hex'),
    );
    const digest = createHash('sha256').update(hashes.join(':')).digest('hex');
    const out = join(parent, digest);
    if (!existsSync(out)) renameSync(stage, out);
    script = join(root, 'refresh-' + randomBytes(12).toString('hex') + '.ps1');
    writeFileSync(
      script,
      readFileSync(join(oracle, 'refresh-runtime.ps1'), 'utf8').replaceAll(
        '__HST_UPDATE_SHA256__',
        digest,
      ),
      { mode: 0o600, flag: 'wx' },
    );
    const pendingPath = join(root, 'pending-jaws-update.json');
    const pending = existsSync(pendingPath) ? json(pendingPath) : null;
    if (
      pending &&
      (pending.container !== containerId ||
        !/^[a-f0-9]{64}$/.test(pending.digest) ||
        !Number.isSafeInteger(pending.pid) ||
        pending.pid < 1)
    )
      throw new Error(
        'A previous JAWS refresh has an unresolved guest process. Keep its saved receipt and finish that update before installing different bytes.',
      );
    const expectedDigest = pending?.digest ?? digest;
    let pid = pending?.pid;
    const scriptSha = createHash('sha256').update(readFileSync(script)).digest('hex');
    const deadline = Date.now() + 10 * 60_000;
    do {
      if (!state(root, config, containerId).running)
        throw new Error('The JAWS guest changed during the update.');
      const op = pid ? 'guest-process' : 'guest-exec';
      const params = pid ? ['--pid', String(pid)] : ['--script', script];
      const r = spawnSync(
        'python3',
        [controller, '--config', configPath, op, ...params, '--timeout', '20'],
        { encoding: 'utf8', timeout: 220_000, maxBuffer: 65536 },
      );
      let response;
      try {
        response = JSON.parse(r.stdout);
      } catch {}
      if (!response || response.schema !== 'winhoo.guest-result/1')
        throw new Error(
          'Cannot inspect the JAWS update via the WinHoo guest agent. Check guest-status before retrying.',
        );
      if (
        r.status === 124 &&
        response.status === 'running' &&
        Number.isSafeInteger(response.pid) &&
        response.pid > 0 &&
        (pid ? response.pid === pid : response.scriptSha256 === scriptSha)
      ) {
        pid = response.pid;
        atomic(
          pendingPath,
          JSON.stringify({ container: containerId, digest: expectedDigest, pid }) + '\n',
        );
        continue;
      }
      const result = response.result;
      if (
        !result?.exited ||
        (!pid && result.scriptSha256 !== scriptSha) ||
        (pid && result.pid !== pid)
      ) {
        throw new Error(
          'WinHoo could not attest the guest update: ' +
            String(response.error ?? response.status ?? r.status).slice(0, 300),
        );
      }
      rmSync(pendingPath, { force: true });
      if (r.status !== 0 || result.exitcode !== 0)
        throw new Error(
          'JAWS refresh failed: ' +
            String(result.err || 'guest exit ' + result.exitcode).slice(0, 450),
        );
      if (!String(result.out).includes('Installed reader update ' + expectedDigest))
        throw new Error('The guest did not confirm the requested package digest.');
      pid = null;
      break;
    } while (Date.now() < deadline);
    if (pid)
      throw new Error(
        'JAWS refresh is still running. Rerun sync with the same package to follow the saved guest process.',
      );
    console.log('Installed JAWS bridge update ' + expectedDigest);
    if (expectedDigest !== digest)
      throw new Error(
        'The previous JAWS update completed. Rerun sync to install the newly staged package.',
      );
  } finally {
    if (script) rmSync(script, { force: true });
    rmSync(stage, { recursive: true, force: true });
  }
}
export function jawsReady(health, chrome, lock) {
  return (
    health?.ready === true &&
    health.protocolVersion === '2.0' &&
    health.status === 'ok' &&
    health.screenReader === 'jaws' &&
    health.platform === 'windows' &&
    health.profile === 'jaws-web' &&
    health.capture === 'jaws-speech-output' &&
    health.version === lock.jaws.version &&
    health.browser?.version === lock.chrome.version &&
    chrome?.Browser === 'Chrome/' + lock.chrome.version &&
    /^wss?:\/\//.test(chrome.webSocketDebuggerUrl ?? '')
  );
}
async function jsonEndpoint(url, headers, signal) {
  const response = await fetch(url, { headers, signal, redirect: 'error' });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('HTTP ' + response.status);
  }
  let count = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    count += chunk.length;
    if (count > 65536) throw new Error('Oversized guest readiness response');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function child(file, args, env, signal) {
  signal.throwIfAborted();
  const p = spawn(file, args, { stdio: 'inherit', env, detached: true });
  let timer;
  function kill(groupSignal) {
    if (!p.pid) return;
    try {
      process.kill(-p.pid, groupSignal);
    } catch (e) {
      if (e.code !== 'ESRCH') throw e;
    }
  }
  const abort = () => {
    kill('SIGTERM');
    timer = setTimeout(() => kill('SIGKILL'), 5000);
    timer.unref();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    return await new Promise((ok, fail) => {
      p.once('error', fail);
      p.once('exit', (code, sig) => ok(code ?? (sig === 'SIGINT' ? 130 : 1)));
    });
  } finally {
    clearTimeout(timer);
    if (signal.aborted) kill('SIGKILL');
    signal.removeEventListener('abort', abort);
  }
}
async function wait(reader, root, config, expected, signal) {
  if (reader === 'nvda') {
    const code = await child(
      process.execPath,
      [join(project, 'scripts/nvda-windows.mjs'), 'docker-readiness'],
      {
        ...process.env,
        HST_NVDA_RUNTIME_ROOT: root,
        HST_NVDA_ENGINE: 'docker',
        HST_NVDA_ACCELERATION: config.acceleration,
        HST_NVDA_CONTAINER_ID: expected,
      },
      signal,
    );
    if (code !== 0) throw new Error('NVDA guest readiness failed (exit ' + code + ')');
    return;
  }
  const token = readFileSync(join(root, 'shared/secrets/control-token'), 'utf8').trim();
  const lock = json(join(config.oem, 'runtime-lock.json'));
  const limit = Number(process.env.HST_JAWS_READY_TIMEOUT_MS ?? 4 * 60 * 60 * 1000);
  if (!Number.isSafeInteger(limit) || limit < 1000 || limit > 4 * 60 * 60 * 1000)
    throw new Error('Invalid JAWS readiness deadline');
  let lastPhase,
    last = 'no bridge response';
  const end = Date.now() + limit;
  while (Date.now() < end) {
    signal.throwIfAborted();
    if (!state(root, config, expected).running)
      throw new Error('The JAWS VM stopped before the reader was ready.');
    const p = phase(root, reader);
    if (p && p !== lastPhase) {
      console.log('JAWS provisioning: ' + p);
      lastPhase = p;
    }
    try {
      const probe = AbortSignal.any([
        signal,
        AbortSignal.timeout(
          Math.min(config.acceleration === 'tcg' ? 30_000 : 10_000, Math.max(1, end - Date.now())),
        ),
      ]);
      const [health, chrome] = await Promise.all([
        jsonEndpoint(
          'http://127.0.0.1:3004/v2/health',
          { authorization: 'Bearer ' + token },
          probe,
        ),
        jsonEndpoint('http://127.0.0.1:9226/json/version', {}, probe),
      ]);
      if (jawsReady(health, chrome, lock)) {
        console.log('JAWS and Chrome ready on the owned WinHoo desktop.');
        return;
      }
      last = 'bridge or browser identity does not match the runtime lock';
    } catch (e) {
      last = e.message;
    }
    await delay(Math.min(3000, Math.max(0, end - Date.now())), undefined, { signal });
  }
  throw new Error(
    'JAWS readiness timed out: ' + last + '; last provisioning phase: ' + (lastPhase ?? 'unknown'),
  );
}
export async function runWindowsReader(reader, argv) {
  const [op = 'status', ...args] = argv;
  if (
    (['-h', '--help', 'help'].includes(reader) && argv.length === 0) ||
    (names.has(reader) && ['-h', '--help', 'help'].includes(op) && !args.length)
  ) {
    console.log(help);
    return;
  }
  if (
    !names.has(reader) ||
    !['doctor', 'init', 'up', 'status', 'wait', 'sync', 'run', 'down'].includes(op) ||
    (op === 'run' ? args[0] !== '--' || !args[1] : args.length)
  )
    throw new Error(usage);
  const { arch, id: engineId } = localDocker();
  const envRoot = process.env['HST_' + reader.toUpperCase() + '_RUNTIME_ROOT'];
  let root = resolve(envRoot ?? join(homedir(), 'VMs', 'hoosaidthat-' + reader + '-docker'));
  if (op === 'doctor' || op === 'init' || op === 'up' || op === 'run') folder(root);
  if (!existsSync(root)) throw new Error('WinHoo runtime is not initialized: ' + root);
  root = realpathSync(root);
  if (root === dirname(root) || root === realpathSync(homedir()) || root === project)
    throw new Error('Choose a dedicated private Windows reader runtime directory.');
  verifyEngine(root, engineId);
  const path = join(root, 'winhoo-docker.json');
  const unlock = ['init', 'up', 'down', 'sync', 'run'].includes(op)
    ? await lease(reader)
    : async () => {};
  const abort = new AbortController(),
    stop = () => abort.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  let started, config, control, heartbeat;
  try {
    const saved = existsSync(path) ? json(path) : null;
    const image =
      saved?.image ?? process.env.HST_WINHOO_DOCKER_IMAGE ?? 'winhoo-desktop:0.4.0-' + arch;
    const runtime = resolveWinhooRuntime({
      runtimeRoot: root,
      engine: 'docker',
      architecture: arch,
      version: '0.4.0',
      image,
    });
    const choice =
      saved?.acceleration ?? process.env['HST_' + reader.toUpperCase() + '_ACCELERATION'] ?? 'auto';
    const kvm = arch === 'amd64' && usableDevice('/dev/kvm') && usableDevice('/dev/net/tun');
    const acceleration = choice === 'auto' ? (kvm ? 'kvm' : 'tcg') : choice;
    if (
      !['kvm', 'tcg'].includes(acceleration) ||
      (acceleration === 'kvm' && !kvm && ['doctor', 'up', 'run', 'init'].includes(op))
    )
      throw new Error(
        'KVM requires accessible /dev/kvm and /dev/net/tun inside the x64 controller distribution.',
      );
    const diskExists = ['data.img', 'windows.img'].some((n) => existsSync(join(root, 'state', n)));
    const cloned = saved?.legacyBind ?? process.env.HST_WINHOO_DOCKER_CLONED_DISK === '1';
    if (!saved && diskExists !== cloned)
      throw new Error(
        'For a dedicated copy of a stopped Windows disk under state/, explicitly select HST_WINHOO_DOCKER_CLONED_DISK=1. A new guest should have no existing disk.',
      );
    if (!saved && !cloned && existsSync(join(root, '.env')))
      throw new Error(
        'Refusing to reuse an existing runtime without a WinHoo Docker identity. Use a new private directory.',
      );
    const sparseBackup = saved
      ? saved.diskBackup === 'sparse'
      : process.env.HST_WINHOO_DOCKER_SPARSE_BACKUP === '1';
    config = readerConfig(reader, {
      root,
      arch,
      acceleration,
      image: runtime.image,
      cloned,
      sparseBackup,
    });
    if (saved && JSON.stringify({ ...saved, ownerGeneration: null }) !== JSON.stringify(config))
      throw new Error('Refusing to change saved WinHoo desktop identity/configuration.');
    const env = {
      ...process.env,
      HST_NVDA_ENGINE: 'docker',
      HST_NVDA_RUNTIME_ROOT: root,
      HST_NVDA_ACCELERATION: acceleration,
    };
    control = (operation) =>
      run('python3', [runtime.controller, '--config', path, operation], {
        stdio: 'inherit',
        timeout: ['up', 'down', 'stop'].includes(operation) ? 1200000 : 45000,
      });
    const current = state(root, config);
    const retainedVolume = !cloned && volumeExists(config.volume);
    if (!saved && retainedVolume)
      throw new Error(
        'A retained Windows volume already exists for this path, but the private runtime identity is missing. Restore the matching runtime folder.',
      );
    const needsProbe = op === 'doctor' || (['up', 'run'].includes(op) && !current?.running);
    const capacity = needsProbe ? resources(root, config, cloned || retainedVolume) : null;
    if (op === 'doctor') {
      const python = run('python3', ['--version']);
      if (!/^Python 3\.(?:9|[1-9]\d+)\./.test(python))
        throw new Error('WinHoo requires Python 3.9 or newer.');
      console.log(
        JSON.stringify({
          reader,
          engine: 'docker',
          image: config.image,
          architecture: arch,
          acceleration,
          root,
          ...capacity,
          container: current?.status ?? 'absent',
        }),
      );
      return;
    }
    if (!saved) {
      if (!['up', 'run', 'init'].includes(op))
        throw new Error('Initialize the WinHoo reader before ' + op);
      if (
        cloned &&
        (!existsSync(join(root, '.env')) ||
          !existsSync(join(root, 'shared/secrets/control-token')) ||
          (reader === 'nvda' && !existsSync(join(root, 'ssh/id_ed25519'))))
      )
        throw new Error(
          'Cloned Windows disks require their matching private guest environment, control token and NVDA SSH key.',
        );
      for (const name of ['state', 'shared/bootstrap', 'shared/secrets', 'oem'])
        folder(join(root, name));
      atomic(path, JSON.stringify(config, null, 2) + '\n');
    }
    const receipt = join(root, 'winhoo-docker-inputs.json');
    if (['up', 'run', 'init'].includes(op) && !existsSync(receipt)) {
      if (current?.running) {
        const required = [
          '.env',
          'shared/secrets/control-token',
          'oem/install.bat',
          ...(reader === 'jaws'
            ? ['oem/hoosaidthat.tgz', 'oem/runtime-lock.json', 'oem/start-runtime.ps1']
            : ['ssh/id_ed25519', 'oem/provision.ps1']),
        ];
        if (
          !required.every(
            (name) => existsSync(join(root, name)) && lstatSync(join(root, name)).isFile(),
          )
        )
          throw new Error('Cannot initialize missing guest inputs while Windows is running.');
      } else stageInputs(reader, root);
      atomic(receipt, JSON.stringify({ reader, config: config.name }) + '\n');
    }
    if (op === 'init') {
      console.log('WinHoo reader initialized: ' + root);
      return;
    }
    if (op === 'status') {
      console.log(
        JSON.stringify({
          reader,
          root,
          container: current?.status ?? 'absent',
          id: current?.id ?? null,
          phase: phase(root, reader),
        }),
      );
      return;
    }
    if (op === 'down') {
      if (current) control('down');
      console.log('WinHoo desktop stopped. Windows disk retained.');
      return;
    }
    let instance = current;
    if (op === 'up' || op === 'run') {
      if (!current?.running) {
        if (op === 'run') {
          const generation = randomBytes(16).toString('hex');
          const file = join(root, 'shared/bootstrap/winhoo-owner-heartbeat');
          let count = 0;
          const renew = () => atomic(file, generation + ' ' + ++count + '\n');
          renew();
          atomic(path, JSON.stringify({ ...config, ownerGeneration: generation }, null, 2) + '\n');
          try {
            control('up');
            heartbeat = setInterval(() => {
              try {
                renew();
              } catch {
                abort.abort();
              }
            }, 5000);
          } finally {
            atomic(path, JSON.stringify(config, null, 2) + '\n');
          }
        } else {
          // A crashed managed run may have left its saved heartbeat generation.
          if (saved?.ownerGeneration) atomic(path, JSON.stringify(config, null, 2) + '\n');
          control('up');
        }
        instance = state(root, config);
        if (!instance?.running) throw new Error('WinHoo did not start the Windows guest.');
        if (op === 'run') started = instance.id;
      }
      if (op === 'up') {
        console.log('WinHoo desktop started. Check reader readiness with wait.');
        return;
      }
    }
    if (!instance?.running)
      throw new Error('Start the WinHoo desktop before waiting for the reader.');
    if (op === 'sync') {
      if (reader === 'nvda') {
        const code = await child(
          process.execPath,
          [join(project, 'scripts/nvda-windows.mjs'), 'sync'],
          { ...env, HST_NVDA_CONTAINER_ID: instance.id },
          abort.signal,
        );
        if (code !== 0) throw new Error('NVDA payload sync failed (exit ' + code + ')');
      } else refreshJaws(root, runtime.controller, path, config, instance.id);
    }
    await wait(reader, root, config, instance.id, abort.signal);
    if (op === 'run') {
      if (!state(root, config, instance.id).running)
        throw new Error('The reader VM stopped after readiness.');
      const prefix = 'HOOSAIDTHAT_' + reader.toUpperCase();
      const controlPort = reader === 'nvda' ? 3002 : 3004,
        cdpPort = reader === 'nvda' ? 9224 : 9226;
      const tokenFile = join(root, 'shared/secrets/control-token');
      const childEnv = {
        ...(reader === 'nvda' ? env : process.env),
        SCREEN_READER: reader,
        HST_NATIVE_TOKEN_FILE: tokenFile,
        [prefix + '_CONTROL_ENDPOINT']: 'http://127.0.0.1:' + controlPort,
        [prefix + '_CDP_ENDPOINT']: 'http://127.0.0.1:' + cdpPort,
        [prefix + '_CONTROL_TOKEN']: readFileSync(tokenFile, 'utf8').trim(),
        ...(reader === 'nvda' ? { HST_NVDA_CONTAINER_ID: instance.id } : {}),
      };
      const code = await child(args[1], args.slice(2), childEnv, abort.signal);
      if (code !== 0) process.exitCode = code;
      else if (!state(root, config, instance.id).running)
        throw new Error('The reader VM stopped during the test.');
    }
  } finally {
    try {
      if (started && state(root, config, started)) control('stop');
    } finally {
      clearInterval(heartbeat);
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
      await unlock();
    }
  }
}
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === cli) {
  try {
    await runWindowsReader(process.argv[2], process.argv.slice(3));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
