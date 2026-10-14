import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('installed HooVDA parity collects compiled JavaScript with the real Playwright runner', () => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'hoosaidthat-installed-parity-'));
  try {
    const packageRoot = resolve(temporary, 'node_modules/@openhoo/hoosaidthat');
    mkdirSync(resolve(packageRoot, 'scripts'), { recursive: true });
    cpSync(resolve(root, 'dist'), resolve(packageRoot, 'dist'), { recursive: true });
    cpSync(resolve(root, 'oracle'), resolve(packageRoot, 'oracle'), { recursive: true });
    cpSync(resolve(root, 'package.json'), resolve(packageRoot, 'package.json'));
    cpSync(resolve(root, 'scripts/hoovda-parity.mjs'), resolve(packageRoot, 'scripts/hoovda-parity.mjs'));
    symlinkSync(resolve(root, 'node_modules/@playwright'), resolve(temporary, 'node_modules/@playwright'), 'dir');
    const preload = resolve(temporary, 'list-only.mjs');
    writeFileSync(preload, `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import assert from 'node:assert/strict';
      const spawn = childProcess.spawnSync;
      childProcess.spawnSync = (program, args, options) => {
        assert.equal(program, process.execPath);
        assert.ok(args[args.indexOf('--config') + 1].endsWith('/dist/oracle/parity/playwright.config.js'));
        assert.equal(options.env.HOOSAIDTHAT_PARITY_ADAPTER, 'hoovda');
        assert.equal(options.env.SCREEN_READER_IMAGE, 'consumer-image:fixture');
        assert.equal(options.env.HOOSAIDTHAT_NVDA_PARITY_ACTIONS.split(',').length, 22);
        return spawn(program, [...args, '--list'], options);
      };
      syncBuiltinESMExports();
    `);
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, resolve(packageRoot, 'scripts/hoovda-parity.mjs'), 'de-DE', 'laptop', 'actions-8'], {
      cwd: temporary,
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, SCREEN_READER_IMAGE: 'consumer-image:fixture', HOOSAIDTHAT_PARITY_ADAPTER: 'nvda' },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /nvda-parity\.spec\.js.*every declared web-profile command executes through selected adapter/);
    assert.match(result.stdout, /Total: 6 tests in 1 file/);
    assert.match(result.stdout, /HooVDA de-DE\/laptop\/actions-8 passed/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('published Windows parity uses built package and forces the NVDA adapter', () => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'hoosaidthat-published-cli-'));
  try {
    const packageRoot = resolve(temporary, 'package');
    const runtimeRoot = resolve(temporary, 'runtime');
    for (const path of ['scripts', 'oracle/parity', 'oracle/windows-nvda', 'node_modules/@playwright/test']) {
      mkdirSync(resolve(packageRoot, path), { recursive: true });
    }
    cpSync(resolve(root, 'scripts/nvda-windows.mjs'), resolve(packageRoot, 'scripts/nvda-windows.mjs'));
    cpSync(resolve(root, 'oracle/parity/coverage.json'), resolve(packageRoot, 'oracle/parity/coverage.json'));
    writeFileSync(resolve(packageRoot, 'node_modules/@playwright/test/package.json'), JSON.stringify({ exports: { './cli': './cli.cjs' } }));
    writeFileSync(resolve(packageRoot, 'node_modules/@playwright/test/cli.cjs'), '');
    for (const path of ['shared/secrets', 'shared/bootstrap', 'ssh']) mkdirSync(resolve(runtimeRoot, path), { recursive: true });
    writeFileSync(resolve(runtimeRoot, '.env'), '');
    writeFileSync(resolve(runtimeRoot, 'shared/secrets/control-token'), `${'a'.repeat(64)}\n`);
    writeFileSync(resolve(runtimeRoot, 'shared/bootstrap/ssh_host_ed25519_key.pub'), `ssh-ed25519 ${Buffer.alloc(51).toString('base64')}\n`);
    const preload = resolve(temporary, 'preload.mjs');
    writeFileSync(preload, `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import assert from 'node:assert/strict';
      let locale = 'en-US';
      let invocations = 0;
      childProcess.execFileSync = () => { throw new Error('published package tried to rebuild missing source'); };
      childProcess.spawnSync = (program, args, options) => {
        if (program === 'ssh') {
          const command = args.at(-1);
          if (command.startsWith('locale-')) locale = command.slice(7);
          return { status: 0, stdout: JSON.stringify({ schema: 'hoosaidthat.nvda-ssh-control', version: 1, command, status: 'ready', ready: true, runtimeFresh: true, runtime: { locale } }), stderr: '' };
        }
        assert.equal(program, process.execPath);
        assert.ok(args[args.indexOf('--config') + 1].endsWith('/dist/oracle/parity/playwright.config.js'));
        assert.equal(options.env.HOOSAIDTHAT_PARITY_ADAPTER, 'nvda', 'NVDA parity must not inherit another adapter');
        invocations += 1;
        return { status: 0 };
      };
      syncBuiltinESMExports();
      globalThis.fetch = async url => new Response(JSON.stringify(String(url).includes('/v2/health') ? { protocolVersion: '2.0', screenReader: 'nvda', version: '2026.1.1', ready: true } : { webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/fixture' }));
      process.on('exit', () => { if (!process.exitCode) assert.equal(invocations, 40); });
    `);
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, resolve(packageRoot, 'scripts/nvda-windows.mjs'), 'parity'], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, HST_NVDA_RUNTIME_ROOT: runtimeRoot, HOOSAIDTHAT_PARITY_ADAPTER: 'hoovda' },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /NVDA full declared-profile matrix passed/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('Windows doctor reports unsupported host before touching Linux state', () => {
  const preload = 'Object.defineProperty(process, "platform", { value: "darwin" });';
  const result = spawnSync(
    process.execPath,
    ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, resolve(root, 'scripts/nvda-windows.mjs'), 'doctor'],
    { encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /NVDA VM doctor failed: host must be Linux/);
  assert.doesNotMatch(result.stderr, /ENOENT|\/proc\/meminfo|at doctor/);
});

for (const adapter of ['orca', 'hoovda']) {
  test(`${adapter} entrypoint rejects decimal integer overflow`, () => {
    const script = readFileSync(resolve(root, `images/${adapter}/entrypoint.sh`), 'utf8');
    const start = script.indexOf('require_integer_between() {');
    const end = script.indexOf('\n}\n', start) + 2;
    assert.ok(start >= 0 && end > start);
    const validation = script.slice(start, end);
    const result = spawnSync('bash', ['-c', `${validation}\nrequire_integer_between width 18446744073709551936 320 8192`], { encoding: 'utf8' });
    assert.equal(result.status, 64);
    assert.match(result.stderr, /must be an integer/);
  });

  test(`${adapter} smoke supervisor rejects an unavailable container state`, () => {
    const temporary = mkdtempSync(resolve(tmpdir(), 'hoosaidthat-smoke-supervisor-'));
    try {
      const engine = resolve(temporary, 'engine');
      writeFileSync(engine, '#!/bin/sh\nif [ "$1" = inspect ]; then exit 1; fi\nexit 0\n', { mode: 0o755 });
      const script = readFileSync(resolve(root, `images/${adapter}/smoke-test.sh`), 'utf8');
      const start = script.lastIndexOf('"$engine" exec "$container_name" pkill');
      assert.ok(start >= 0);
      const result = spawnSync('bash', ['-c', 'engine=$1; container_name=fixture; sleep() { :; }; eval "$2"', 'smoke-supervisor', engine, script.slice(start)], { encoding: 'utf8', timeout: 5000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /did not report a stopped state/);
      assert.doesNotMatch(result.stdout, /supervisor stopped container/);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}
