#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const invocationRoot = process.cwd();
const require = createRequire(import.meta.url);
const playwrightCLI = require.resolve('@playwright/test/cli');
const deploymentRoot = join(projectRoot, 'oracle', 'windows-nvda');
const runtimeRoot = resolve(
  process.env.HST_NVDA_RUNTIME_ROOT ?? join(homedir(), 'VMs', 'hoosaidthat-nvda'),
);
const stateRoot = join(runtimeRoot, 'state');
const sharedRoot = join(runtimeRoot, 'shared');
const secretRoot = join(sharedRoot, 'secrets');
const sshRoot = join(runtimeRoot, 'ssh');
const environmentPath = join(runtimeRoot, '.env');
const tokenPath = join(secretRoot, 'control-token');
const sshPrivateKeyPath = join(sshRoot, 'id_ed25519');
const sshPublicKeyPath = `${sshPrivateKeyPath}.pub`;
const knownHostsPath = join(sshRoot, 'known_hosts');
const publishedClientKeyPath = join(sharedRoot, 'bootstrap', 'authorized_key.pub');
const publishedHostKeyPath = join(sharedRoot, 'bootstrap', 'ssh_host_ed25519_key.pub');
const controlPayloadsRoot = join(sharedRoot, 'control', 'payloads');
const composePath = join(deploymentRoot, 'compose.yml');
const ports = [8008, 2224, 3392, 3002, 9224];
const sshCommands = new Set([
  'status',
  'start',
  'stop',
  'restart',
  'logs',
  'time-sync',
  'reconfigure-ssh',
  'locale-en-US',
  'locale-de-DE',
  'shutdown',
  'reboot',
]);
const maxControlPayloadFileBytes = 2 * 1024 * 1024;
const maxControlPayloadBytes = 8 * 1024 * 1024;
const controlPayloadFiles = [
  'bootstrap.html',
  'configure-ssh.ps1',
  'nvdaConfig/nvda.ini',
  'nvdaConfig/scratchpad/globalPlugins/hoosaidthatControl.py',
  'runtime-startup.cmd',
  'ssh-dispatch.ps1',
  'start-runtime.ps1',
];
const parityCoverage = JSON.parse(
  readFileSync(join(projectRoot, 'oracle', 'parity', 'coverage.json'), 'utf8'),
);
const parityActions = Object.values(parityCoverage.scenarios).flat();
if (
  parityActions.length !== 190 ||
  parityActions.some((action) => typeof action !== 'string') ||
  new Set(parityActions).size !== parityActions.length
) {
  throw new Error('NVDA parity coverage must contain exactly 190 unique action identifiers');
}
const parityActionShards = chunk(parityActions, 24);

const command = process.argv[2] ?? 'status';

switch (command) {
  case 'doctor':
    await doctor();
    break;
  case 'init':
    await doctor();
    initialize();
    console.log(`initialized ${runtimeRoot}`);
    break;
  case 'up':
    await doctor();
    {
      const containerWasRunning = oracleContainerRunning();
      const qemuWasRunning = containerWasRunning && oracleQemuRunning();
      initialize();
      compose(containerWasRunning && !qemuWasRunning ? ['restart'] : ['up', '--detach']);
    }
    console.log('NVDA oracle VM started; run `npm run nvda:windows:wait`.');
    break;
  case 'wait':
    await waitUntilReady();
    break;
  case 'status':
    status();
    break;
  case 'control':
    requireInitialized();
    {
      const remoteCommand = process.argv[3] ?? 'status';
      runSshControl(remoteCommand);
      if (remoteCommand === 'shutdown') await finalizeGuestShutdown();
      if (remoteCommand === 'reconfigure-ssh') await waitAfterSshReconfigure();
    }
    break;
  case 'wait-ssh':
    requireInitialized();
    await waitUntilSshReady();
    break;
  case 'sync':
    requireInitialized();
    await syncControlPayload();
    break;
  case 'parity':
    await runParityMatrix();
    break;
  case 'parity-cell':
    await runParityCell(process.argv[3], process.argv[4]);
    break;
  case 'down':
    requireInitialized();
    compose(['down']);
    console.log('NVDA oracle VM stopped; persistent state retained.');
    break;
  default:
    throw new Error(
      'usage: nvda-windows.mjs doctor|init|up|wait|status|control <command>|wait-ssh|sync|parity|parity-cell <locale> <layout>|down',
    );
}

async function doctor() {
  const failures = [];
  if (process.platform !== 'linux') failures.push('host must be Linux');
  if (!existsSync('/dev/kvm')) failures.push('/dev/kvm missing');
  if (!existsSync('/dev/net/tun')) failures.push('/dev/net/tun missing');
  const composeProbe = spawnSync('podman', ['compose', 'version'], {
    encoding: 'utf8',
  });
  if (composeProbe.status !== 0) failures.push('podman compose unavailable');
  const sshProbe = spawnSync('ssh', ['-V'], { encoding: 'utf8' });
  if (sshProbe.status !== 0) failures.push('OpenSSH client unavailable');
  const sshKeygenProbe = spawnSync('ssh-keygen', ['-?'], { encoding: 'utf8' });
  if (sshKeygenProbe.error?.code === 'ENOENT') failures.push('ssh-keygen unavailable');
  const meminfo = readFileSync('/proc/meminfo', 'utf8');
  const availableKb = Number(/^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1] ?? 0);
  if (availableKb < 10 * 1024 * 1024) failures.push('less than 10 GiB host memory available');
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  const disk = statfsSync(runtimeRoot);
  const availableBytes = Number(disk.bavail) * Number(disk.bsize);
  const minimumDiskBytes = existsSync(join(stateRoot, 'data.img'))
    ? 10 * 1024 ** 3
    : 110 * 1024 ** 3;
  if (availableBytes < minimumDiskBytes) {
    failures.push(`less than ${minimumDiskBytes / 1024 ** 3} GiB disk available`);
  }
  if (!oracleContainerRunning()) {
    const occupied = await occupiedPorts(ports);
    if (occupied.length > 0)
      failures.push(`required loopback ports occupied: ${occupied.join(', ')}`);
  }
  if (failures.length > 0) throw new Error(`NVDA VM doctor failed: ${failures.join('; ')}`);
  console.log('NVDA VM doctor passed: KVM, Podman Compose, memory, disk, and ports ready.');
}

function initialize() {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  mkdirSync(secretRoot, { recursive: true, mode: 0o700 });
  mkdirSync(sshRoot, { recursive: true, mode: 0o700 });
  mkdirSync(join(sharedRoot, 'bootstrap'), { recursive: true, mode: 0o700 });
  initializeSshIdentity();
  createTextFileIfAbsent(tokenPath, `${randomBytes(48).toString('base64url')}\n`, 0o600);
  const password = randomBytes(24).toString('base64url');
  const content = [
    `WINDOWS_PASSWORD=${password}`,
    `HST_NVDA_STATE=${stateRoot}`,
    `HST_NVDA_SHARED=${sharedRoot}`,
    `HST_NVDA_OEM=${join(deploymentRoot, 'oem')}`,
    '',
  ].join('\n');
  createTextFileIfAbsent(environmentPath, content, 0o600);
  chmodSync(runtimeRoot, 0o700);
  chmodSync(secretRoot, 0o700);
  chmodSync(sshRoot, 0o700);
  chmodSync(tokenPath, 0o600);
  chmodSync(sshPrivateKeyPath, 0o600);
  chmodSync(sshPublicKeyPath, 0o644);
  chmodSync(environmentPath, 0o600);
}

function initializeSshIdentity() {
  const privateKeyExists = existsSync(sshPrivateKeyPath);
  let publicKey = tryReadBoundedFile(sshPublicKeyPath, 16 * 1024);
  if (publicKey !== undefined && !privateKeyExists) {
    throw new Error(`SSH public key exists without private key at ${sshRoot}`);
  }
  if (!privateKeyExists) {
    if (
      existsSync(environmentPath) ||
      existsSync(knownHostsPath) ||
      existsSync(publishedHostKeyPath)
    ) {
      throw new Error(
        `existing NVDA VM SSH identity is missing at ${sshPrivateKeyPath}; recover or deliberately rotate it through the loopback RDP console`,
      );
    }
    const generated = spawnSync(
      'ssh-keygen',
      ['-q', '-t', 'ed25519', '-N', '', '-C', 'hoosaidthat-nvda-oracle', '-f', sshPrivateKeyPath],
      { encoding: 'utf8' },
    );
    if (generated.status !== 0) {
      throw new Error(
        `SSH identity generation failed: ${(generated.stderr || generated.error?.message || 'unknown error').trim()}`,
      );
    }
  }
  if (publicKey === undefined) {
    const derived = spawnSync('ssh-keygen', ['-y', '-f', sshPrivateKeyPath], {
      encoding: 'utf8',
    });
    if (derived.status !== 0 || !derived.stdout.trim()) {
      throw new Error(
        `SSH public key derivation failed: ${(derived.stderr || derived.error?.message || 'unknown error').trim()}`,
      );
    }
    createTextFileIfAbsent(
      sshPublicKeyPath,
      `${derived.stdout.trim()} hoosaidthat-nvda-oracle\n`,
      0o644,
    );
    publicKey = readBoundedFile(sshPublicKeyPath, 16 * 1024);
  }
  publicKey = publicKey.trim();
  validateEd25519PublicKey(publicKey, 'client public key');
  writeFileSync(publishedClientKeyPath, `${publicKey}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  chmodSync(publishedClientKeyPath, 0o600);
}

function compose(arguments_) {
  execFileSync(
    'podman',
    [
      'compose',
      '--env-file',
      environmentPath,
      '--file',
      composePath,
      '--project-name',
      'hoosaidthat-nvda',
      ...arguments_,
    ],
    { cwd: deploymentRoot, stdio: 'inherit' },
  );
}

async function waitUntilReady() {
  requireInitialized();
  const token = readControlToken();
  const deadline = Date.now() + 45 * 60_000;
  let lastPhases = '';
  let lastError = 'not started';
  while (Date.now() < deadline) {
    const statusFiles = [
      join(sharedRoot, 'bootstrap', 'oem-status.json'),
      join(sharedRoot, 'bootstrap', 'runtime-status.json'),
    ];
    const phases = [];
    for (const path of statusFiles) {
      try {
        const value = JSON.parse(readBoundedFile(path, 64 * 1024));
        const phase = `${value.schema ?? 'status'}:${value.phase ?? (value.ready ? 'ready' : 'waiting')}`;
        phases.push(phase);
        if (value.status === 'failed' || value.error) {
          throw new Error(
            `guest provisioning failed: ${String(value.error ?? value.phase).slice(0, 500)}`,
          );
        }
      } catch (error) {
        if (error instanceof SyntaxError || isFileError(error, 'ENOENT')) continue;
        throw error;
      }
    }
    const phaseSummary = phases.join(',');
    if (phaseSummary && phaseSummary !== lastPhases) {
      lastPhases = phaseSummary;
      console.log(phaseSummary);
    }
    try {
      const [control, cdp] = await Promise.all([
        fetch('http://127.0.0.1:3002/v2/health', {
          // The validated secret is intentionally sent only to the fixed host-loopback
          // control endpoint. It never influences request destination or path.
          // codeql[js/file-access-to-http]
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(2_000),
        }),
        fetch('http://127.0.0.1:9224/json/version', {
          signal: AbortSignal.timeout(2_000),
        }),
      ]);
      if (control.ok && cdp.ok) {
        const [health, version] = await Promise.all([
          readBoundedJsonResponse(control, 64 * 1024, 'NVDA control health'),
          readBoundedJsonResponse(cdp, 64 * 1024, 'Chrome CDP version'),
        ]);
        if (
          health.protocolVersion === '2.0' &&
          health.screenReader === 'nvda' &&
          health.version === '2026.1.1' &&
          health.ready === true &&
          typeof version.webSocketDebuggerUrl === 'string'
        ) {
          const ssh = trySshControl('status');
          if (ssh.status === 0) {
            console.log(
              'NVDA 2026.1.1 oracle ready: SSH 127.0.0.1:2224, control 127.0.0.1:3002, CDP 127.0.0.1:9224.',
            );
            return;
          }
          lastError = `SSH control unavailable: ${(ssh.stderr || ssh.error?.message || `exit ${ssh.status}`).trim()}`;
        } else {
          lastError = 'readiness payload invalid';
        }
      } else {
        lastError = `control HTTP ${control.status}; CDP HTTP ${cdp.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
  }
  throw new Error(`NVDA oracle did not become ready in 45 minutes: ${lastError}`);
}

function status() {
  const probe = spawnSync(
    'podman',
    ['inspect', '--format', '{{.State.Status}}', 'hoosaidthat-nvda-oracle'],
    { encoding: 'utf8' },
  );
  console.log(probe.status === 0 ? probe.stdout.trim() : 'container absent');
  for (const name of ['oem-status.json', 'ssh-status.json', 'runtime-status.json']) {
    const path = join(sharedRoot, 'bootstrap', name);
    try {
      console.log(`${name}: ${readBoundedFile(path, 64 * 1024).trim()}`);
    } catch (error) {
      if (!isFileError(error, 'ENOENT')) throw error;
    }
  }
  if (probe.status === 0 && existsSync(environmentPath) && existsSync(sshPrivateKeyPath)) {
    const guest = trySshControl('status');
    if (guest.status === 0) process.stdout.write(`guest: ${guest.stdout.trim()}\n`);
    else
      console.log(
        `guest: unavailable (${String(
          guest.error?.message || guest.stderr || `exit ${guest.status}`,
        )
          .trim()
          .slice(0, 500)})`,
      );
  }
}

function validateEd25519PublicKey(value, label) {
  const parts = value.trim().split(/\s+/u);
  if (parts.length < 2 || parts[0] !== 'ssh-ed25519' || !/^[A-Za-z0-9+/]{68}$/u.test(parts[1])) {
    throw new Error(`${label} has invalid shape`);
  }
  if (Buffer.from(parts[1], 'base64').length !== 51) {
    throw new Error(`${label} has invalid wire length`);
  }
  return `ssh-ed25519 ${parts[1]}`;
}

function pinGuestHostKey() {
  const publishedHostKey = tryReadBoundedFile(publishedHostKeyPath, 16 * 1024);
  if (publishedHostKey === undefined) {
    throw new Error(`guest SSH host key not published at ${publishedHostKeyPath}`);
  }
  const key = validateEd25519PublicKey(
    publishedHostKey,
    'guest SSH host key',
  );
  const expected = `[127.0.0.1]:2224 ${key}\n`;
  createTextFileIfAbsent(knownHostsPath, expected, 0o600);
  const pinned = readBoundedFile(knownHostsPath, 16 * 1024);
  if (pinned !== expected) {
    throw new Error(
      `guest SSH host key changed; verify VM identity before replacing ${knownHostsPath}`,
    );
  }
  chmodSync(knownHostsPath, 0o600);
}

function sshArguments(remoteCommand) {
  return [
    '-p',
    '2224',
    '-i',
    sshPrivateKeyPath,
    '-o',
    'BatchMode=yes',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${knownHostsPath}`,
    '-o',
    'PasswordAuthentication=no',
    '-o',
    'KbdInteractiveAuthentication=no',
    '-o',
    'ConnectTimeout=5',
    '-o',
    'LogLevel=ERROR',
    'HstOracle@127.0.0.1',
    remoteCommand,
  ];
}

function trySshControl(remoteCommand) {
  try {
    pinGuestHostKey();
  } catch (error) {
    return { status: 1, stdout: '', stderr: '', error };
  }
  const result = spawnSync('ssh', sshArguments(remoteCommand), {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.status === 0) {
    try {
      validateSshPayload(result.stdout, remoteCommand);
    } catch (error) {
      return { ...result, status: 1, error };
    }
  }
  return result;
}

function runSshControl(remoteCommand) {
  if (!sshCommands.has(remoteCommand)) {
    throw new Error(`unsupported SSH control command: ${remoteCommand}`);
  }
  return runSshCommand(remoteCommand, remoteCommand);
}

function runSshCommand(remoteCommand, expectedCommand) {
  pinGuestHostKey();
  const result = spawnSync('ssh', sshArguments(remoteCommand), {
    encoding: 'utf8',
    timeout: remoteCommand === 'reconfigure-ssh' ? 120_000 : 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(
      `SSH control command failed with exit code ${result.status}: ${result.stdout.trim().slice(0, 500)}`,
    );
  }
  const payload = validateSshPayload(result.stdout, expectedCommand);
  if (payload.status === 'failed') {
    throw new Error(
      `SSH control command failed: ${String(payload.error ?? 'unknown error').slice(0, 500)}`,
    );
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  return payload;
}

function validateSshPayload(stdout, expectedCommand) {
  let payload;
  try {
    payload = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`SSH control returned invalid JSON: ${stdout.trim().slice(0, 500)}`);
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    payload.schema !== 'hoosaidthat.nvda-ssh-control' ||
    payload.version !== 1 ||
    payload.command !== expectedCommand
  ) {
    throw new Error('SSH control response contract mismatch');
  }
  return payload;
}

async function syncControlPayload() {
  const sourceRoot = join(deploymentRoot, 'oem', 'hoosaidthat');
  const files = controlPayloadFiles.map((name) => {
    const data = readFileSync(join(sourceRoot, ...name.split('/')));
    if (data.byteLength > maxControlPayloadFileBytes) {
      throw new Error(`control payload file exceeds ${maxControlPayloadFileBytes} bytes: ${name}`);
    }
    return {
      name,
      bytes: data.byteLength,
      sha256: createHash('sha256').update(data).digest('hex'),
      data,
    };
  });
  const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
  if (totalBytes > maxControlPayloadBytes) {
    throw new Error(`control payload exceeds ${maxControlPayloadBytes} bytes`);
  }
  const generationHash = createHash('sha256');
  for (const file of files) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(file.bytes));
    generationHash.update(Buffer.from(file.name, 'utf8'));
    generationHash.update(Buffer.from([0]));
    generationHash.update(length);
    generationHash.update(file.data);
  }
  const generation = generationHash.digest('hex');
  mkdirSync(controlPayloadsRoot, { recursive: true, mode: 0o700 });
  const destination = join(controlPayloadsRoot, generation);
  if (!existsSync(destination)) {
    const temporary = join(controlPayloadsRoot, `.${generation}.${process.pid}.tmp`);
    try {
      mkdirSync(temporary, { recursive: false, mode: 0o700 });
      for (const file of files) {
        const output = join(temporary, ...file.name.split('/'));
        mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
        writeFileSync(output, file.data, { mode: 0o600, flag: 'wx' });
      }
      const manifest = {
        payloadGeneration: generation,
        files: files.map(({ name, bytes, sha256 }) => ({
          name,
          bytes,
          sha256,
        })),
      };
      writeFileSync(join(temporary, 'payload-manifest.json'), `${JSON.stringify(manifest)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      renameSync(temporary, destination);
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
  }
  const result = runSshCommand(`update ${generation}`, 'update');
  if (
    result.status !== 'ready' ||
    result.payloadGeneration !== generation ||
    result.files !== files.length
  ) {
    throw new Error('SSH control update acknowledgement mismatch');
  }
  runSshControl('reconfigure-ssh');
  await waitAfterSshReconfigure();
}

async function waitUntilSshReady() {
  const deadline = Date.now() + 20 * 60_000;
  let lastError = 'not started';
  while (Date.now() < deadline) {
    const result = trySshControl('status');
    if (result.status === 0) {
      process.stdout.write(result.stdout);
      console.log('NVDA SSH control ready at 127.0.0.1:2224.');
      return;
    }
    lastError = (result.stderr || result.error?.message || `exit ${result.status}`).trim();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 3_000));
  }
  throw new Error(`NVDA SSH control did not become ready in 20 minutes: ${lastError}`);
}

async function finalizeGuestShutdown() {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 12_000));
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const qemu = spawnSync(
      'podman',
      [
        'exec',
        'hoosaidthat-nvda-oracle',
        'sh',
        '-lc',
        'test -s /run/shm/qemu.pid && kill -0 "$(cat /run/shm/qemu.pid)" 2>/dev/null',
      ],
      { encoding: 'utf8' },
    );
    if (qemu.status !== 0) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  compose(['stop']);
  console.log('NVDA oracle VM shut down; persistent state retained.');
}

async function waitAfterSshReconfigure() {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 7_000));
  await waitUntilSshReady();
}

function requireInitialized() {
  if (!existsSync(environmentPath) || !existsSync(tokenPath)) {
    throw new Error(`NVDA runtime is not initialized at ${runtimeRoot}; run init first`);
  }
}

async function runParityMatrix() {
  requireInitialized();
  await waitUntilReady();
  execFileSync('npm', ['run', 'build'], { cwd: projectRoot, stdio: 'inherit' });
  const token = readControlToken();
  for (const [locale, keyboardLayout] of [
    ['en-US', 'desktop'],
    ['en-US', 'laptop'],
    ['de-DE', 'desktop'],
    ['de-DE', 'laptop'],
  ]) {
    await runParityCell(locale, keyboardLayout, {
      token,
      build: false,
      fullSharded: true,
    });
  }
  console.log('NVDA full declared-profile matrix passed.');
}

async function runParityCell(locale, keyboardLayout, options = {}) {
  if (!['en-US', 'de-DE'].includes(locale) || !['desktop', 'laptop'].includes(keyboardLayout)) {
    throw new Error('parity-cell requires locale en-US|de-DE and layout desktop|laptop');
  }
  requireInitialized();
  await waitUntilReady();
  if (options.build !== false && existsSync(join(projectRoot, 'tsconfig.build.json'))) {
    execFileSync('npm', ['run', 'build'], {
      cwd: projectRoot,
      stdio: 'inherit',
    });
  }
  const token = options.token ?? readControlToken();
  console.log(`NVDA parity ${locale}/${keyboardLayout}`);
  runSshControl(`locale-${locale}`);
  await waitUntilReady();
  const localeStatus = runSshControl('status');
  if (
    localeStatus.ready !== true ||
    localeStatus.runtime?.locale !== locale ||
    localeStatus.runtimeFresh !== true
  ) {
    throw new Error(`NVDA runtime locale did not become ready for ${locale}`);
  }
  const inheritedSpecializedRun =
    Boolean(process.env.HOOSAIDTHAT_NVDA_PARITY_ACTIONS?.trim()) ||
    process.env.HOOSAIDTHAT_NVDA_PARITY_SETTINGS === '1' ||
    process.env.HOOSAIDTHAT_NVDA_PARITY_ARTIFACTS === '1' ||
    process.env.HOOSAIDTHAT_NVDA_PARITY_CORE === '1';
  if (options.fullSharded || !inheritedSpecializedRun) {
    runParityInvocation(locale, keyboardLayout, token, 'core', {
      HOOSAIDTHAT_NVDA_PARITY_CORE: '1',
    });
    for (let index = 0; index < parityActionShards.length; index += 1) {
      runParityInvocation(
        locale,
        keyboardLayout,
        token,
        `actions-${String(index + 1).padStart(2, '0')}`,
        {
          HOOSAIDTHAT_NVDA_PARITY_ACTIONS: parityActionShards[index].join(','),
        },
      );
    }
    runParityInvocation(locale, keyboardLayout, token, 'settings', {
      HOOSAIDTHAT_NVDA_PARITY_SETTINGS: '1',
    });
    return;
  }
  runParityInvocation(locale, keyboardLayout, token, 'specialized', {
    HOOSAIDTHAT_NVDA_PARITY_ACTIONS: process.env.HOOSAIDTHAT_NVDA_PARITY_ACTIONS ?? '',
    HOOSAIDTHAT_NVDA_PARITY_SETTINGS: process.env.HOOSAIDTHAT_NVDA_PARITY_SETTINGS ?? '',
    HOOSAIDTHAT_NVDA_PARITY_ARTIFACTS: process.env.HOOSAIDTHAT_NVDA_PARITY_ARTIFACTS ?? '',
    HOOSAIDTHAT_NVDA_PARITY_CORE: process.env.HOOSAIDTHAT_NVDA_PARITY_CORE ?? '',
  });
}

function runParityInvocation(locale, keyboardLayout, token, label, overrides = {}) {
  const result = spawnSync(
    process.execPath,
    [
      playwrightCLI,
      'test',
      '--config',
      join(projectRoot, 'oracle', 'parity', 'playwright.config.ts'),
      '--reporter=line',
      '--output',
      join(
        invocationRoot,
        'test-results',
        `nvda-${locale.toLowerCase()}-${keyboardLayout}-${label}`,
      ),
    ],
    {
      cwd: invocationRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        SCREEN_READER_LOCALE: locale,
        SCREEN_READER_KEYBOARD_LAYOUT: keyboardLayout,
        HOOSAIDTHAT_NVDA_CONTROL_TOKEN: token,
        HOOSAIDTHAT_NVDA_PARITY_ACTIONS: '',
        HOOSAIDTHAT_NVDA_PARITY_SETTINGS: '',
        HOOSAIDTHAT_NVDA_PARITY_ARTIFACTS: '',
        HOOSAIDTHAT_NVDA_PARITY_CORE: '',
        ...overrides,
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(`NVDA parity failed for ${locale}/${keyboardLayout}/${label}`);
  }
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function occupiedPorts(candidates) {
  const occupied = [];
  for (const port of candidates) {
    const available = await new Promise((resolvePromise) => {
      const server = createServer();
      server.once('error', () => resolvePromise(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolvePromise(true)));
    });
    if (!available) occupied.push(port);
  }
  return occupied;
}

function oracleContainerRunning() {
  const probe = spawnSync(
    'podman',
    ['inspect', '--format', '{{.State.Running}}', 'hoosaidthat-nvda-oracle'],
    { encoding: 'utf8' },
  );
  return probe.status === 0 && probe.stdout.trim() === 'true';
}

function oracleQemuRunning() {
  const probe = spawnSync(
    'podman',
    [
      'exec',
      'hoosaidthat-nvda-oracle',
      'sh',
      '-lc',
      'test -s /run/shm/qemu.pid && kill -0 "$(cat /run/shm/qemu.pid)" 2>/dev/null',
    ],
    { encoding: 'utf8' },
  );
  return probe.status === 0;
}

function readBoundedFile(path, maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error('maximumBytes must be a positive safe integer');
  }
  const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(`not a regular file: ${path}`);
    const buffer = Buffer.allocUnsafe(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const bytesRead = readSync(
        descriptor,
        buffer,
        offset,
        buffer.byteLength - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maximumBytes) throw new Error(`file exceeds ${maximumBytes} bytes: ${path}`);
    return buffer.toString('utf8', 0, offset);
  } finally {
    closeSync(descriptor);
  }
}

function tryReadBoundedFile(path, maximumBytes) {
  try {
    return readBoundedFile(path, maximumBytes);
  } catch (error) {
    if (isFileError(error, 'ENOENT')) return undefined;
    throw error;
  }
}

function createTextFileIfAbsent(path, content, mode) {
  try {
    writeFileSync(path, content, { encoding: 'utf8', mode, flag: 'wx' });
    return true;
  } catch (error) {
    if (isFileError(error, 'EEXIST')) return false;
    throw error;
  }
}

function isFileError(error, code) {
  return error !== null && typeof error === 'object' && error.code === code;
}

function readControlToken() {
  const token = readBoundedFile(tokenPath, 256).trim();
  if (!/^[A-Za-z0-9_-]{64}$/u.test(token)) {
    throw new Error(`invalid NVDA control token at ${tokenPath}`);
  }
  return token;
}

async function readBoundedJsonResponse(response, maximumBytes, label) {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const parsed = Number(declared);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`${label} exceeded ${maximumBytes} bytes`);
    }
  }
  if (!response.body) throw new Error(`${label} had no response body`);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error(`${label} exceeded ${maximumBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new Error(`${label} was not UTF-8`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} was not JSON`);
  }
}
