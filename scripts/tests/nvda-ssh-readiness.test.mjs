import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Invoke the installed CLI. All process, HTTP, clock and sleep effects are local fakes;
// the implementation under test is copied from the actual distribution script.
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
      import { writeFileSync } from 'node:fs';
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
        if (scenario === 'invalid-json') return { status: 0, stdout: '{broken', stderr: '' };
        if (scenario === 'wrong-command') return { status: 0, stdout: JSON.stringify({ ...payload, command: 'other' }), stderr: '' };
        if (scenario === 'process-timeout') {
          now += options.timeout;
          return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawnSync ssh ETIMEDOUT'), { code: 'ETIMEDOUT' }) };
        }
        let handshake = scenario === 'slow-banner' ? 30_000 : 100;
        let dispatch = scenario === 'slow-status' ? 240_000 : 100;
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

for (const command of [['wait-ssh'], ['wait'], ['control', 'status'], ...['start', 'stop', 'restart', 'locale-en-US', 'locale-de-DE'].map(value => ['control', value])]) {
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
}

for (const [remoteCommand, timeout] of [['logs', 30_000], ['time-sync', 30_000], ['reconfigure-ssh', 120_000]]) {
  test(`TCG verändert das bisherige Budget für ${remoteCommand} ohne Runtime-Statusantwort nicht`, () => {
    const result = invoke(['control', remoteCommand], 'ready');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls[0].command, remoteCommand);
    assert.equal(result.calls[0].timeout, timeout);
    assert.equal(result.calls[0].connect, 5);
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
