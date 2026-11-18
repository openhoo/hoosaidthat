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
    for (const path of ['scripts', 'oracle/parity', 'oracle/windows-nvda', 'node_modules/@playwright/test']) {
      mkdirSync(resolve(packageRoot, path), { recursive: true });
    }
    cpSync(resolve(root, 'scripts/nvda-windows.mjs'), resolve(packageRoot, 'scripts/nvda-windows.mjs'));
    cpSync(resolve(root, 'oracle/windows-nvda/engine-state.mjs'), resolve(packageRoot, 'oracle/windows-nvda/engine-state.mjs'));
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
      const runs = [];
      let now = 0;
      let fetches = 0;
      let locale = 'en-US';
      const httpRequests = [];
      const httpOverlaps = [];
      let httpActive = 0;
      let httpMaxActive = 0;
      let nextTimer = 0;
      let timerPumpScheduled = false;
      const timers = new Map();
      const signalTimers = new WeakMap();
      Date.now = () => now;
      // Promise-Fortsetzungen dürfen Timer löschen, bevor die virtuelle Uhr weiterläuft.
      function pumpTimers() {
        if (timerPumpScheduled || timers.size === 0) return;
        timerPumpScheduled = true;
        setImmediate(() => {
          timerPumpScheduled = false;
          const next = [...timers].sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
          if (!next) return;
          timers.delete(next[0]);
          now = Math.max(now, next[1].at);
          next[1].callback(...next[1].args);
          pumpTimers();
        });
      }
      globalThis.setTimeout = (callback, duration, ...args) => {
        assert.ok(Number.isFinite(duration) && duration >= 0);
        const id = ++nextTimer;
        timers.set(id, { at: now + duration, callback, args });
        pumpTimers();
        return id;
      };
      globalThis.clearTimeout = id => timers.delete(id);
      AbortSignal.timeout = duration => {
        const controller = new AbortController();
        signalTimers.set(controller.signal,
          setTimeout(() => controller.abort(new DOMException('Zeitlimit der HTTP-Probe erreicht', 'TimeoutError')), duration));
        return controller.signal;
      };
      childProcess.execFileSync = () => { throw new Error('unexpected process execution'); };
      childProcess.spawnSync = (program, args, options) => {
        if (program === process.execPath) {
          assert.ok(args.includes('--config'));
          assert.equal(options.env.HOOSAIDTHAT_PARITY_ADAPTER, 'nvda');
          playwrightCalls += 1;
          runs.push({ output: args[args.indexOf('--output') + 1],
            actions: options.env.HOOSAIDTHAT_NVDA_PARITY_ACTIONS,
            core: options.env.HOOSAIDTHAT_NVDA_PARITY_CORE, settings: options.env.HOOSAIDTHAT_NVDA_PARITY_SETTINGS });
          return { status: 0, stdout: '', stderr: '' };
        }
        if (program === 'podman') {
          assert.equal(args[0], 'ps');
          return { status: 0, stdout: 'a'.repeat(64) + '\t' + 'hoosaidthat-nvda-oracle' + '\trunning', stderr: '' };
        }
        assert.equal(program, 'ssh', 'the test must never run another executable');
        const command = args.at(-1);
        if (command.startsWith('locale-')) locale = command.slice(7);
        const connect = Number(args.find(value => value.startsWith('ConnectTimeout=')).split('=')[1]);
        calls.push({ command, timeout: options.timeout, connect, started: now });
        const payload = { schema: 'hoosaidthat.nvda-ssh-control', version: 1, command, status: 'ready', ready: true, runtimeFresh: true, runtime: { locale } };
        if (locale === 'de-DE' && scenario === 'locale-stale') payload.runtimeFresh = false;
        if (locale === 'de-DE' && scenario === 'locale-mismatch') payload.runtime.locale = 'en-US';
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
        if (scenario === 'reset-session' || (scenario === 'recover-session' && calls.length === 1))
          return { status: 255, stdout: '', stderr: 'Read from remote host 127.0.0.1: Connection reset by peer; client_loop: send disconnect: Broken pipe' };
        if (scenario === 'wrong-command' || scenario === 'http-invalid-ssh') return { status: 0, stdout: JSON.stringify({ ...payload, command: 'other' }), stderr: '' };
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
      function simulatedHttp(url, options) {
        const address = String(url);
        assert.ok(['http://127.0.0.1:3002/v2/health', 'http://127.0.0.1:9224/json/version'].includes(address), address);
        const control = address === 'http://127.0.0.1:3002/v2/health';
        const headers = new Headers(options.headers);
        assert.equal(headers.get('authorization'), control ? 'Bearer ' + 'a'.repeat(64) : null);
        assert.ok(options.signal instanceof AbortSignal);
        const index = httpRequests.length;
        const round = Math.floor(index / 2);
        if (index % 2 === 0 && httpActive !== 0) httpOverlaps.push({ round, active: httpActive, at: now });
        const request = { index, round, endpoint: control ? 'control' : 'cdp', started: now,
          headersAt: null, abortedAt: null, endedAt: null, cancelledAt: null, endReason: null };
        httpRequests.push(request);
        httpActive += 1;
        httpMaxActive = Math.max(httpMaxActive, httpActive);
        const health = { protocolVersion: '2.0', screenReader: 'nvda', version: '2026.1.1', ready: true };
        const version = { webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/fixture' };
        if (scenario === 'http-invalid-protocol') health.protocolVersion = '1.0';
        if (scenario === 'http-invalid-version') health.version = '2025.1';
        if (scenario === 'http-invalid-reader') health.screenReader = 'hoovda';
        if (scenario === 'http-invalid-ready') health.ready = false;
        if (scenario === 'http-invalid-cdp') version.webSocketDebuggerUrl = null;
        let headerMs = scenario === 'http-slow-headers' && control ? 29_689 : 10;
        let bodyMs = scenario === 'http-slow-body' && control ? 29_589 : 0;
        if (scenario === 'http-slow-body' && control) headerMs = 100;
        if (scenario === 'http-total-budget') { headerMs = 20_000; bodyMs = 15_000; }
        if (scenario === 'http-deadline-clamp') headerMs = Infinity;
        const firstRoundFailure = round === 0 && ['http-sibling-headers', 'http-sibling-body', 'http-non-ok'].includes(scenario);
        if (firstRoundFailure && !control) {
          if (scenario === 'http-sibling-body') bodyMs = 100_000;
          else headerMs = 100_000;
        }
        if (firstRoundFailure && scenario === 'http-non-ok' && control) bodyMs = 100_000;
        const status = firstRoundFailure && scenario === 'http-non-ok' && control ? 503 : 200;
        const brokenJson = control && (scenario === 'http-invalid-json' || firstRoundFailure && scenario === 'http-sibling-body');
        const bytes = new TextEncoder().encode(brokenJson ? '{ungueltig' : JSON.stringify(control ? health : version));
        // Die Bereinigung dauert länger als die Retrypause und macht Überlappungen sichtbar.
        const cleanupMs = firstRoundFailure ? 7_000 : 0;
        let headerTimer, bodyTimer, bodyController, rejectFetch, closing = false, closed = false, cleanup;
        const finish = reason => {
          if (closed) return;
          closed = true;
          clearTimeout(headerTimer);
          clearTimeout(bodyTimer);
          clearTimeout(signalTimers.get(options.signal));
          options.signal.removeEventListener('abort', aborted);
          httpActive -= 1;
          request.endedAt = now;
          request.endReason = reason;
        };
        const close = (reason, error) => {
          if (closed) return Promise.resolve();
          if (closing) return cleanup;
          closing = true;
          clearTimeout(headerTimer);
          clearTimeout(bodyTimer);
          cleanup = new Promise(resolveCleanup => setTimeout(() => {
            finish(reason);
            if (error && bodyController) bodyController.error(error);
            else if (error) rejectFetch(error);
            resolveCleanup();
          }, cleanupMs));
          return cleanup;
        };
        const aborted = () => {
          request.abortedAt = now;
          close('aborted', options.signal.reason ?? new DOMException('Abgebrochen', 'AbortError'));
        };
        return new Promise((resolveFetch, reject) => {
          rejectFetch = reject;
          options.signal.addEventListener('abort', aborted, { once: true });
          if (options.signal.aborted) return aborted();
          if (!Number.isFinite(headerMs)) return;
          headerTimer = setTimeout(() => {
            if (firstRoundFailure && scenario === 'http-sibling-headers' && control) {
              finish('transport-error');
              reject(new Error('Simulierter HTTP-Verbindungsfehler'));
              return;
            }
            request.headersAt = now;
            const body = new ReadableStream({
              start(controller) {
                bodyController = controller;
                bodyTimer = setTimeout(() => {
                  if (closed || closing) return;
                  controller.enqueue(bytes);
                  controller.close();
                  finish('body-complete');
                }, bodyMs);
              },
              cancel() {
                request.cancelledAt = now;
                return close('cancelled');
              },
            });
            const responseHeaders = scenario === 'http-oversized-body' && control
              ? { 'content-length': '65537' } : { 'content-length': String(bytes.byteLength) };
            resolveFetch(new Response(body, { status, headers: responseHeaders }));
          }, headerMs);
        });
      }
      globalThis.fetch = async (url, options) => {
        fetches += 1;
        if (scenario.startsWith('http-')) return simulatedHttp(url, options);
        clearTimeout(signalTimers.get(options?.signal));
        if (scenario === 'fetch-exhausts-deadline' && fetches === 1) now += 45 * 60_000;
        return new Response(JSON.stringify(String(url).includes('/v2/health')
          ? { protocolVersion: '2.0', screenReader: 'nvda', version: '2026.1.1', ready: true }
          : { webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/fixture' }));
      };
      process.on('exit', () => writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({ calls, now, fetches, playwrightCalls, runs,
        httpRequests, httpOverlaps, httpActive, httpMaxActive })));
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
  assert.deepEqual(result.calls.map(call => call.command), ['status', 'locale-de-DE', 'status']);
  assert.equal(result.calls[1].timeout, 900_000);
  assert.equal(result.calls[1].connect, 120);
  assert.equal(result.playwrightCalls, 10);
});

for (const scenario of ['locale-stale', 'locale-mismatch']) {
  test(`Parity starts no browser work for ${scenario}`, () => {
    const r = invoke(['parity-cell', 'de-DE', 'laptop'], scenario);
    assert.equal(r.status, 1);
    assert.equal(r.playwrightCalls, 0);
    assert.match(r.stderr, /locale|fresh/i);
  });
}

test('the matrix reuses each validated locale receipt without skipping any shard', () => {
  const r = invoke(['parity'], 'ready');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls.map(c => c.command), ['en-US', 'en-US', 'de-DE', 'de-DE']
    .flatMap(locale => ['status', `locale-${locale}`, 'status']));
  assert.equal(r.playwrightCalls, 40);
});

test('live NVDA and CDP with repeated SSH resets stop before Playwright or the boot deadline', () => {
  const r = invoke(['parity-shard', 'en-US', 'desktop', 'actions-08'], 'reset-session', 'kvm');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /NVDA and Chrome are ready.*SSH.*reset/i);
  assert.equal(r.calls.length, 3);
  assert.ok(r.now <= 15_000);
  assert.equal(r.playwrightCalls, 0);
});

test('one reset during startup recovers and still requires a valid SSH status', () => {
  const r = invoke(['wait'], 'recover-session', 'kvm');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.length, 2);
});

test('replay selects the exact final action block and preserves normal matrix evidence', () => {
  const r = invoke(['parity-shard', 'de-DE', 'laptop', 'actions-08'], 'ready');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls.map(c => c.command), ['status', 'locale-de-DE', 'status']);
  assert.equal(r.playwrightCalls, 1);
  const actions = Object.values(JSON.parse(readFileSync(resolve(root, 'oracle/parity/coverage.json'))).scenarios).flat();
  assert.deepEqual(r.runs[0].actions.split(','), actions.slice(168));
  assert.equal(r.runs[0].settings, '');
  assert.equal(r.runs[0].core, '');
  assert.match(r.runs[0].output, /nvda-replay-de-de-laptop-actions-08-[a-zA-Z0-9]+$/);
});

test('an unknown replay block fails before polling Windows or starting Playwright', () => {
  const r = invoke(['parity-shard', 'de-DE', 'laptop', 'actions-09'], 'ready');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /core.*actions-01.*actions-08.*settings/);
  assert.deepEqual(r.calls, []);
  assert.equal(r.fetches, 0);
  assert.equal(r.playwrightCalls, 0);
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

for (const scenario of ['http-slow-headers', 'http-slow-body']) {
  test(`TCG wartet innerhalb einer HTTP-Runde auf gültige ${scenario === 'http-slow-headers' ? 'Header' : 'Bodydaten'} nach 29,689 Sekunden`, t => {
    const result = invoke(['wait'], scenario);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.fetches, 2, 'die erste vollständige Probenrunde muss genügen');
    assert.deepEqual(result.calls.map(call => call.command), ['status']);
    const control = result.httpRequests.find(request => request.endpoint === 'control');
    assert.equal(control.endedAt - control.started, 29_689);
    assert.equal(control.endReason, 'body-complete');
    assert.equal(control.abortedAt, null);
    assert.equal(result.httpActive, 0);
    assert.deepEqual(result.httpOverlaps, []);
    t.diagnostic(JSON.stringify({ fixture: 'echte lokale CLI mit simulierten HTTP-Antworten', scenario,
      httpRequests: result.httpRequests, sshCalls: result.calls }));
  });
}

for (const acceleration of ['kvm', 'auto', null]) {
  test(`${acceleration || 'ohne Modus'} behält die HTTP-Frist von zwei Sekunden`, () => {
    const result = invoke(['wait'], 'http-slow-headers', acceleration);
    assert.equal(result.status, 1);
    assert.equal(result.calls.length, 0, 'eine unvollständige HTTP-Runde darf kein SSH freigeben');
    assert.equal(result.httpRequests[0].abortedAt - result.httpRequests[0].started, 2_000);
    assert.equal(result.now, 45 * 60_000);
    assert.equal(result.httpActive, 0);
    assert.deepEqual(result.httpOverlaps, []);
  });
}

test('TCG teilt die 30 Sekunden zwischen HTTP-Headern und Body und begrenzt die letzte Runde auf die Außenfrist', t => {
  const result = invoke(['wait'], 'http-total-budget');
  assert.equal(result.status, 1);
  assert.equal(result.calls.length, 0);
  const first = result.httpRequests[0];
  assert.equal(first.headersAt - first.started, 20_000);
  assert.equal(first.abortedAt - first.started, 30_000, 'der Body erhält keine neue eigene Frist');
  const lastRound = result.httpRequests.filter(request => request.round === result.httpRequests.at(-1).round);
  assert.equal(lastRound.length, 2);
  for (const request of lastRound) {
    assert.equal(request.abortedAt - request.started, 5_000);
    assert.equal(request.endedAt, 45 * 60_000);
  }
  assert.equal(result.now, 45 * 60_000);
  assert.equal(result.httpActive, 0);
  assert.equal(result.httpMaxActive, 2);
  assert.deepEqual(result.httpOverlaps, []);
  t.diagnostic(JSON.stringify({ fixture: 'echte lokale CLI mit simulierter gemeinsamer HTTP-Frist',
    firstRound: result.httpRequests.slice(0, 2), lastRound, endedAt: result.now }));
});

test('TCG begrenzt auch ausbleibende HTTP-Header auf die restliche gemeinsame Außenfrist', () => {
  const result = invoke(['wait'], 'http-deadline-clamp');
  assert.equal(result.status, 1);
  assert.equal(result.calls.length, 0);
  assert.equal(result.httpRequests[0].abortedAt - result.httpRequests[0].started, 30_000);
  for (const request of result.httpRequests.slice(-2)) {
    assert.equal(request.abortedAt - request.started, 5_000);
    assert.equal(request.headersAt, null);
    assert.equal(request.endedAt, 45 * 60_000);
  }
  assert.equal(result.now, 45 * 60_000);
  assert.equal(result.httpActive, 0);
  assert.deepEqual(result.httpOverlaps, []);
});

for (const scenario of ['http-sibling-headers', 'http-sibling-body', 'http-non-ok']) {
  test(`${scenario} bricht die Schwesterprobe ab und wartet vor dem Retry auf deren Bereinigung`, t => {
    const result = invoke(['wait'], scenario);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.fetches, 4, 'nach der fehlgeschlagenen Runde muss genau eine vollständige Runde folgen');
    assert.deepEqual(result.calls.map(call => call.command), ['status']);
    const sibling = result.httpRequests[1];
    assert.equal(sibling.abortedAt, 10, 'der Fehler muss die Schwester vor ihrer eigenen Deadline abbrechen');
    assert.equal(sibling.endedAt, 7_010, 'die asynchrone Bereinigung bleibt bis zum Abschluss in Bearbeitung');
    assert.ok(result.httpRequests[2].started >= sibling.endedAt + 5_000,
      JSON.stringify(result.httpRequests));
    assert.equal(result.httpActive, 0);
    assert.equal(result.httpMaxActive, 2);
    assert.deepEqual(result.httpOverlaps, []);
    t.diagnostic(JSON.stringify({ fixture: 'echte lokale CLI mit asynchroner Schwesterbereinigung',
      scenario, httpRequests: result.httpRequests, httpMaxActive: result.httpMaxActive }));
  });
}

for (const scenario of ['http-invalid-json', 'http-invalid-protocol', 'http-invalid-version',
  'http-invalid-reader', 'http-invalid-ready', 'http-invalid-cdp', 'http-oversized-body']) {
  test(`HTTP-Readiness verwirft weiterhin ${scenario} vor dem SSH-Status`, () => {
    const result = invoke(['wait'], scenario);
    assert.equal(result.status, 1);
    assert.equal(result.calls.length, 0, 'ungültige HTTP-Daten dürfen den SSH-Status nicht freigeben');
    assert.doesNotMatch(result.stdout, /oracle ready/);
    assert.equal(result.httpActive, 0);
    assert.deepEqual(result.httpOverlaps, []);
  });
}

test('Gültige HTTP-Antworten ersetzen nicht den validierten SSH-Statusvertrag', () => {
  const result = invoke(['wait'], 'http-invalid-ssh');
  assert.equal(result.status, 1);
  assert.ok(result.calls.length > 0);
  assert.doesNotMatch(result.stdout, /oracle ready/);
  assert.equal(result.httpActive, 0);
  assert.deepEqual(result.httpOverlaps, []);
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
