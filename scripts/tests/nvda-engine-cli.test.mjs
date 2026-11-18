import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../..');
const managedCLI = process.env.HST_TEST_WINHOO_OPERATOR;
function cli(command, scenario, managed = false) {
  const root = mkdtempSync(join(tmpdir(), 'hst-engine-cli-'));
  try {
    const pub = 'ssh-ed25519 ' + Buffer.alloc(51).toString('base64');
    for (const dir of ['state', 'shared/bootstrap', 'shared/secrets', 'ssh', 'bundle/desktop'])
      mkdirSync(join(root, dir), { recursive: true });
    const files = {
      '.env': '',
      'state/data.img': 'fixture',
      'ssh/id_ed25519': 'fixture',
      'ssh/id_ed25519.pub': pub,
      'shared/secrets/control-token': 'a'.repeat(64),
      'shared/bootstrap/ssh_host_ed25519_key.pub': pub,
    };
    if (managed)
      Object.assign(files, {
        'bundle/winhoo_desktop.py': 'fixture',
        'bundle/desktop/owner-watchdog.sh': 'fixture',
        'bundle/desktop/runtime.json': JSON.stringify({
          schema: 'winhoo.desktop-runtime/1',
          version: '0.4.0',
          kind: 'windows-desktop-vm',
          configurationSchema: 'winhoo.desktop/1',
          controller: 'winhoo_desktop.py',
          controllerBundle: '/usr/share/winhoo/controller',
          applications: [],
          guestTools: { hiddenLauncher: String.raw`C:\ProgramData\WinHoo\tools\WinHoo.RunHidden.exe` },
        }),
      });
    for (const [path, contents] of Object.entries(files)) writeFileSync(join(root, path), contents);
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        join(here, 'fixtures/nvda-engine-preload.mjs'),
        managed ? managedCLI : join(source, 'scripts/nvda-windows.mjs'),
        ...command,
      ],
      {
        encoding: 'utf8',
        timeout: 3500,
        env: {
          ...process.env,
          HST_NVDA_RUNTIME_ROOT: root,
          HST_NVDA_ENGINE: managed ? 'docker' : 'podman',
          HST_NVDA_ACCELERATION: managed ? 'tcg' : 'kvm',
          HST_TEST_MANAGED: managed ? '1' : '',
          HST_TEST_SCENARIO: scenario,
          HST_NVDA_WINHOO_ROOT: join(root, 'bundle'),
          HST_NVDA_PYTHON: 'python3',
          HST_NVDA_KEEP_CONTAINER: '1',
        },
      },
    );
    assert.ifError(result.error);
    const calls = JSON.parse(readFileSync(join(root, 'calls.json')));
    const actions = calls
      .filter(
        ([p, first, ...rest]) =>
          (p === 'podman' && first === 'compose' && rest[0] !== 'version') ||
          (p === 'python3' && first !== '--version') ||
          (p === 'ssh' && first !== '-V'),
      )
      .map((args) => args.at(-1));
    return { ...result, calls, actions };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
for (const scenario of ['engine-loss', 'engine-timeout', 'malformed']) {
  test('up refuses to touch Windows when container state is unreadable: ' + scenario, () => {
    const r = cli(['up'], scenario);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /container state unknown/i);
    assert.deepEqual(r.actions, []);
  });
}
for (const [scenario, expected] of [
  ['running', []],
  ['booting', []],
  ['ended', ['restart']],
  ['stopped', ['--detach']],
  ['absent', ['--detach']],
]) {
  test('up chooses the correct lifecycle operation: ' + scenario, () => {
    const r = cli(['up'], scenario);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.actions, expected);
  });
}
test('failed QEMU inspection cannot cause a restart', () => {
  const r = cli(['up'], 'exec-loss');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /state unknown/i);
  assert.deepEqual(r.actions, []);
});
for (const command of ['wait', 'wait-ssh', 'status']) {
  test(command + ' reports engine loss before using guest or HTTP endpoints', () => {
    const r = cli([command], 'engine-loss');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /container state unknown/i);
    assert.deepEqual(r.actions, []);
  });
}
test('a paused oracle is not restarted', () => {
  const r = cli(['up'], 'paused');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /paused/i);
  assert.deepEqual(r.actions, []);
});
if (managedCLI) {
  for (const scenario of ['mid-run-loss', 'replaced', 'low-disk']) {
    test('managed run cleans up only a verified live owner: ' + scenario, () => {
      const r = cli(['run', '--', 'unused-consumer'], scenario, true);
      assert.equal(r.status, 1, r.stdout);
      if (scenario === 'low-disk') {
        assert.match(r.stderr, /below 8 GiB/);
        assert.deepEqual(r.actions, ['up', 'shutdown', 'stop']);
      } else {
        assert.match(r.stdout + r.stderr, /cleanup deferred/i);
        assert.doesNotMatch(r.stdout + r.stderr, /stopped before readiness|shutting down Windows/i);
        assert.deepEqual(r.actions, ['up']);
      }
    });
  }
}
