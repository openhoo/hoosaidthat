import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const payloadFiles = [
  'bootstrap.html',
  'configure-ssh.ps1',
  'nvdaConfig/nvda.ini',
  'nvdaConfig/scratchpad/globalPlugins/hoosaidthatControl.py',
  'runtime-startup.cmd',
  'ssh-dispatch.ps1',
  'start-runtime.ps1',
];

// Die installierte CLI und ihre echten Payloaddateien stammen aus der Distribution.
// Prozesse, HTTP, Uhr und Pausen werden ausschließlich lokal simuliert.
function invoke(command, scenario, acceleration = 'tcg') {
  const temporary = mkdtempSync(resolve(tmpdir(), 'hoosaidthat-ssh-readiness-'));
  try {
    const packageRoot = resolve(temporary, 'package');
    const runtimeRoot = resolve(temporary, 'runtime');
    const receiptPath = resolve(temporary, 'calls.json');
    for (const path of ['scripts', 'oracle/parity', 'node_modules/@playwright/test']) {
      mkdirSync(resolve(packageRoot, path), { recursive: true });
    }
    cpSync(resolve(root, 'scripts/nvda-windows.mjs'), resolve(packageRoot, 'scripts/nvda-windows.mjs'));
    cpSync(resolve(root, 'oracle/parity/coverage.json'), resolve(packageRoot, 'oracle/parity/coverage.json'));
    const generationHash = createHash('sha256');
    const payloadEntries = payloadFiles.map(name => {
      const source = resolve(root, 'oracle/windows-nvda/oem/hoosaidthat', name);
      const destination = resolve(packageRoot, 'oracle/windows-nvda/oem/hoosaidthat', name);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(source, destination);
      const data = readFileSync(source);
      const length = Buffer.alloc(8);
      length.writeBigUInt64BE(BigInt(data.length));
      generationHash.update(Buffer.from(name, 'utf8'));
      generationHash.update(Buffer.from([0]));
      generationHash.update(length);
      generationHash.update(data);
      return { name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
    });
    const payloadGeneration = generationHash.digest('hex');
    writeFileSync(resolve(packageRoot, 'node_modules/@playwright/test/package.json'), JSON.stringify({ exports: { './cli': './cli.cjs' } }));
    writeFileSync(resolve(packageRoot, 'node_modules/@playwright/test/cli.cjs'), '');
    for (const path of ['shared/secrets', 'shared/bootstrap', 'ssh']) {
      mkdirSync(resolve(runtimeRoot, path), { recursive: true });
    }
    writeFileSync(resolve(runtimeRoot, '.env'), '');
    writeFileSync(resolve(runtimeRoot, 'shared/secrets/control-token'), `${'a'.repeat(64)}\n`);
    writeFileSync(resolve(runtimeRoot, 'shared/bootstrap/ssh_host_ed25519_key.pub'), `ssh-ed25519 ${Buffer.alloc(51).toString('base64')}\n`);
    writeFileSync(resolve(runtimeRoot, 'ssh/id_ed25519'), 'synthetic fixture; never used for authentication');
    const preload = resolve(temporary, 'preload.mjs');
    writeFileSync(preload, `
      import assert from 'node:assert/strict';
      import childProcess from 'node:child_process';
      import { readFileSync, writeFileSync } from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const scenario = ${JSON.stringify(scenario)};
      const calls = [];
      let playwrightCalls = 0;
      let now = 0;
      let fetches = 0;
      let locale = 'en-US';
      Date.now = () => now;
      globalThis.setTimeout = (callback, duration, ...args) => {
        assert.ok(Number.isFinite(duration) && duration >= 0);
        now += duration;
        queueMicrotask(() => callback(...args));
        return 0;
      };
      childProcess.execFileSync = () => { throw new Error('unexpected process execution'); };
      childProcess.spawnSync = (program, args, options) => {
        if (program === process.execPath) {
          assert.ok(args.includes('--config'));
          assert.equal(options.env.HOOSAIDTHAT_PARITY_ADAPTER, 'nvda');
          playwrightCalls += 1;
          return { status: 0, stdout: '', stderr: '' };
        }
        if (program === 'podman') {
          assert.equal(args[0], 'inspect');
          return { status: 0, stdout: 'running', stderr: '' };
        }
        assert.equal(program, 'ssh', 'the test must never run another executable');
        const command = args.at(-1);
        if (command.startsWith('locale-')) locale = command.slice(7);
        const connect = Number(args.find(value => value.startsWith('ConnectTimeout=')).split('=')[1]);
        calls.push({ command, timeout: options.timeout, connect, started: now });
        const payload = { schema: 'hoosaidthat.nvda-ssh-control', version: 1, command, status: 'ready', ready: true, runtimeFresh: true, runtime: { locale } };
        if (command.startsWith('update ')) {
          const expectedGeneration = ${JSON.stringify(payloadGeneration)};
          assert.equal(command, 'update ' + expectedGeneration);
          const staged = ${JSON.stringify(resolve(runtimeRoot, 'shared/control/payloads'))} + '/' + expectedGeneration;
          const manifest = JSON.parse(readFileSync(staged + '/payload-manifest.json', 'utf8'));
          assert.deepEqual(manifest, { payloadGeneration: expectedGeneration, files: ${JSON.stringify(payloadEntries)} });
          for (const entry of manifest.files) {
            assert.deepEqual(readFileSync(staged + '/' + entry.name),
              readFileSync(${JSON.stringify(resolve(packageRoot, 'oracle/windows-nvda/oem/hoosaidthat'))} + '/' + entry.name));
          }
          Object.assign(payload, { command: 'update', payloadGeneration: expectedGeneration, files: manifest.files.length });
        }
        if (scenario === 'invalid-json') return { status: 0, stdout: '{broken', stderr: '' };
        if (scenario === 'wrong-command') return { status: 0, stdout: JSON.stringify({ ...payload, command: 'other' }), stderr: '' };
        if (scenario === 'process-timeout') {
          now += options.timeout;
          return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawnSync ssh ETIMEDOUT'), { code: 'ETIMEDOUT' }) };
        }
        let handshake = scenario === 'slow-banner' ? 30_000 : 100;
        if (scenario === 'slow-sync-banner') handshake = 20_000;
        let dispatch = scenario === 'slow-status' ? 240_000 : 100;
        if (scenario === 'slow-sync-update' && command.startsWith('update ')) {
          handshake = 20_000;
          dispatch = 25_000;
        }
        if (scenario === 'slow-sync-update-timeout' && command.startsWith('update ')) {
          handshake = 20_000;
          dispatch = 100_001;
        }
        if (scenario === 'slow-locale' && command.startsWith('locale-')) dispatch = 240_000;
        if (scenario === 'unavailable') handshake = Infinity;
        if (handshake > connect * 1000) {
          now += Math.min(connect * 1000, options.timeout);
          return { status: 255, stdout: '', stderr: 'Connection timed out during banner exchange' };
        }
        if (handshake + dispatch > options.timeout) {
          now += options.timeout;
          return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawnSync ssh ETIMEDOUT'), { code: 'ETIMEDOUT' }) };
        }
        now += handshake + dispatch;
        return { status: 0, stdout: JSON.stringify(payload), stderr: '' };
      };
      syncBuiltinESMExports();
      globalThis.fetch = async url => {
        fetches += 1;
        if (scenario === 'fetch-exhausts-deadline' && fetches === 1) now += 45 * 60_000;
        return new Response(JSON.stringify(String(url).includes('/v2/health')
          ? { protocolVersion: '2.0', screenReader: 'nvda', version: '2026.1.1', ready: true }
          : { webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/fixture' }));
      };
      process.on('exit', () => writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({ calls, now, fetches, playwrightCalls })));
    `);
    const env = { ...process.env, HST_NVDA_RUNTIME_ROOT: runtimeRoot };
    if (acceleration === null) delete env.HST_NVDA_ACCELERATION;
    else env.HST_NVDA_ACCELERATION = acceleration;
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, resolve(packageRoot, 'scripts/nvda-windows.mjs'), ...command], {
      cwd: temporary,
      encoding: 'utf8',
      timeout: 5000,
      env,
    });
    assert.equal(result.error, undefined, result.stderr);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    return { ...result, ...receipt };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

test('TCG-Synchronisierung bestätigt sieben reale Payloads nach insgesamt 45 Sekunden SSH-Handschlag und Update-Dispatch', t => {
  const result = invoke(['sync'], 'slow-sync-update');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.map(call => call.command.startsWith('update ') ? 'update' : call.command),
    ['update', 'reconfigure-ssh', 'status']);
  assert.equal(result.calls[0].timeout, 120_000);
  assert.equal(result.calls[0].connect, 120);
  const updateElapsedMs = result.calls[1].started - result.calls[0].started;
  assert.equal(updateElapsedMs, 45_000);
  const acknowledgements = result.stdout.split(/\r?\n/).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }).filter(value => value.command === 'update');
  assert.equal(acknowledgements.length, 1);
  const acknowledgement = acknowledgements[0];
  assert.equal(acknowledgement.schema, 'hoosaidthat.nvda-ssh-control');
  assert.equal(acknowledgement.version, 1);
  assert.equal(acknowledgement.status, 'ready');
  assert.equal(acknowledgement.files, 7);
  assert.equal(acknowledgement.payloadGeneration, result.calls[0].command.slice('update '.length));
  assert.equal(result.fetches, 0);
  t.diagnostic(JSON.stringify({ fixture: 'lokale CLI mit simulierter SSH-Zeit',
    updateElapsedMs, calls: result.calls, acknowledgement, fetches: result.fetches }));
});

test('TCG-Synchronisierung wartet auf einen SSH-Banner über fünf Sekunden innerhalb ihrer begrenzten Budgets', () => {
  const result = invoke(['sync'], 'slow-sync-banner');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.map(call => call.command.startsWith('update ') ? 'update' : call.command),
    ['update', 'reconfigure-ssh', 'status']);
  assert.deepEqual(result.calls.map(({ timeout, connect }) => ({ timeout, connect })), [
    { timeout: 120_000, connect: 120 },
    { timeout: 120_000, connect: 120 },
    { timeout: 900_000, connect: 120 },
  ]);
  assert.equal(result.fetches, 0);
});

test('TCG-Synchronisierung beendet einen langsamen Update-Aufruf nach 120 Sekunden ohne Folgeaufruf', t => {
  const result = invoke(['sync'], 'slow-sync-update-timeout');
  assert.equal(result.status, 1);
  assert.equal(result.calls.length, 1, result.stderr);
  assert.match(result.calls[0].command, /^update [a-f0-9]{64}$/);
  assert.equal(result.calls[0].timeout, 120_000);
  assert.equal(result.calls[0].connect, 120);
  assert.equal(result.now, 120_000);
  assert.equal(result.fetches, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /timed out after 120000 ms/);
  assert.match(result.stderr, /remote process may still be running/i);
  assert.match(result.stderr, /refusing overlapping retries/i);
  t.diagnostic(JSON.stringify({ fixture: 'lokale CLI mit simulierter SSH-Zeit',
    elapsedMs: result.now, calls: result.calls, acknowledgement: false, fetches: result.fetches }));
});

test('TCG-Status wartet auf einen langsamen SSH-Banner', () => {
  const result = invoke(['wait-ssh'], 'slow-banner');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].connect, 120);
  assert.equal(result.calls[0].timeout, 900_000);
});

for (const command of [['wait-ssh'], ['wait'], ['control', 'status'], ['status']]) {
  test(`TCG-Status erlaubt langsame gültige Diagnostik über ${command.join(' ')}`, () => {
    const result = invoke(command, 'slow-status');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].timeout, 900_000);
    assert.equal(result.calls[0].connect, 120);
    assert.doesNotMatch(result.stdout, /unavailable/);
  });
}

for (const command of [['wait-ssh'], ['wait'], ['control', 'status'], ...['start', 'stop', 'restart', 'locale-en-US', 'locale-de-DE', 'logs', 'time-sync', 'reconfigure-ssh', 'shutdown', 'reboot'].map(value => ['control', value])]) {
  test(`${command.join(' ')} startet nach lokalem SSH-Prozess-Timeout keine überlappende Abfrage`, () => {
    const result = invoke(command, 'process-timeout');
    assert.equal(result.status, 1);
    assert.equal(result.calls.length, 1, result.stderr);
    assert.match(result.stderr, /remote process may still be running/i);
    assert.match(result.stderr, /refusing overlapping retries/i);
  });
}

for (const remoteCommand of ['start', 'stop', 'restart', 'locale-en-US', 'locale-de-DE']) {
  for (const scenario of ['slow-status', 'slow-banner']) {
    test(`TCG wartet auf die vollständige Runtime-Statusantwort von ${remoteCommand} bei ${scenario}`, () => {
      const result = invoke(['control', remoteCommand], scenario);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.calls.length, 1);
      assert.equal(result.calls[0].command, remoteCommand);
      assert.equal(result.calls[0].timeout, 900_000);
      assert.equal(result.calls[0].connect, 120);
    });
  }
}

test('TCG-Parity-Cell wartet vor der erneuten Readiness auf die langsame Locale-Antwort', () => {
  const result = invoke(['parity-cell', 'de-DE', 'laptop'], 'slow-locale');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.map(call => call.command), ['status', 'locale-de-DE', 'status', 'status']);
  assert.equal(result.calls[1].timeout, 900_000);
  assert.equal(result.calls[1].connect, 120);
  assert.equal(result.playwrightCalls, 10);
});

for (const [command, deadline] of [[['wait-ssh'], 20 * 60_000], [['wait'], 45 * 60_000]]) {
  test(`${command.join(' ')} begrenzt SSH-Aufrufe und Pausen auf die bestehende Deadline`, () => {
    const result = invoke(command, 'unavailable');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /did not become ready/);
    assert.ok(result.calls.length > 1);
    for (const call of result.calls) {
      const remaining = deadline - call.started;
      assert.ok(call.timeout > 0 && call.timeout <= remaining, JSON.stringify(call));
      assert.ok(call.connect <= Math.max(1, Math.floor(remaining / 1000)), JSON.stringify(call));
    }
    assert.equal(result.now, deadline, 'no sleep or new SSH attempt may exceed the outer deadline');
  });
}

test('HTTP-Bereitschaft darf nach Ablauf der gemeinsamen Deadline kein SSH mehr starten', () => {
  const result = invoke(['wait'], 'fetch-exhausts-deadline');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.calls.length, 0);
  assert.equal(result.now, 45 * 60_000);
});

for (const acceleration of ['kvm', 'auto', null]) {
  for (const [command, timeout] of [[['wait-ssh'], 15_000], [['control', 'status'], 30_000]]) {
    test(`${acceleration || 'ohne Modus'} behält das bestehende SSH-Budget für ${command.join(' ')}`, () => {
      const result = invoke(command, 'ready', acceleration);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.calls.length, 1);
      assert.equal(result.calls[0].timeout, timeout);
      assert.equal(result.calls[0].connect, 5);
    });
  }
  test(`${acceleration || 'ohne Modus'} behält alle bestehenden SSH-Budgets bei der Synchronisierung`, () => {
    const result = invoke(['sync'], 'ready', acceleration);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls.map(call => call.command.startsWith('update ') ? 'update' : call.command),
      ['update', 'reconfigure-ssh', 'status']);
    assert.deepEqual(result.calls.map(({ timeout, connect }) => ({ timeout, connect })), [
      { timeout: 30_000, connect: 5 },
      { timeout: 120_000, connect: 5 },
      { timeout: 15_000, connect: 5 },
    ]);
    assert.equal(result.fetches, 0);
  });
  test(`${acceleration || 'ohne Modus'} beendet den Update-Aufruf weiterhin nach 30 Sekunden ohne Folgeaufruf`, t => {
    const result = invoke(['sync'], 'process-timeout', acceleration);
    assert.equal(result.status, 1);
    assert.equal(result.calls.length, 1, result.stderr);
    assert.match(result.calls[0].command, /^update [a-f0-9]{64}$/);
    assert.equal(result.calls[0].timeout, 30_000);
    assert.equal(result.calls[0].connect, 5);
    assert.equal(result.now, 30_000);
    assert.equal(result.stdout, '');
    assert.equal(result.fetches, 0);
    assert.match(result.stderr, /timed out after 30000 ms/);
    assert.match(result.stderr, /refusing overlapping retries/i);
    t.diagnostic(JSON.stringify({ fixture: 'lokale CLI mit simulierter SSH-Zeit',
      acceleration, elapsedMs: result.now, calls: result.calls, acknowledgement: false }));
  });
}

for (const [remoteCommand, timeout, connect] of [['logs', 30_000, 30], ['time-sync', 30_000, 30], ['reconfigure-ssh', 120_000, 120], ['reboot', 30_000, 30]]) {
  test(`TCG begrenzt den SSH-Verbindungsaufbau von ${remoteCommand} auf sein bestehendes Prozessbudget`, () => {
    const result = invoke(['control', remoteCommand], 'ready');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls.length, remoteCommand === 'reconfigure-ssh' ? 2 : 1);
    assert.equal(result.calls[0].command, remoteCommand);
    assert.equal(result.calls[0].timeout, timeout);
    assert.equal(result.calls[0].connect, connect);
  });
}

for (const acceleration of ['kvm', 'auto', null]) {
  for (const remoteCommand of ['start', 'stop', 'restart', 'locale-en-US', 'locale-de-DE']) {
    test(`${acceleration || 'ohne Modus'} behält das bisherige Antwortbudget für ${remoteCommand}`, () => {
      const result = invoke(['control', remoteCommand], 'ready', acceleration);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.calls.length, 1);
      assert.equal(result.calls[0].timeout, 30_000);
      assert.equal(result.calls[0].connect, 5);
    });
  }
}

for (const scenario of ['invalid-json', 'wrong-command']) {
  test(`TCG-Status verwirft weiterhin ${scenario}`, () => {
    const result = invoke(['control', 'status'], scenario);
    assert.equal(result.status, 1);
    assert.match(result.stderr, scenario === 'invalid-json' ? /invalid JSON/ : /response contract mismatch/);
  });
}
