import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveWinhooRuntime } from '../../oracle/windows-nvda/winhoo-image.mjs';

const id = `sha256:${'a'.repeat(64)}`;
const labels = {
  'io.openhoo.winhoo.desktop.runtime': 'winhoo.desktop-runtime/1',
  'io.openhoo.winhoo.desktop.version': '0.4.0',
  'io.openhoo.winhoo.desktop.applications': 'none',
};

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'hst-winhoo-image-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  mkdirSync(join(source, 'desktop'), { recursive: true });
  writeFileSync(join(source, 'winhoo_desktop.py'), '# Generic controller fixture\n');
  writeFileSync(join(source, 'desktop/owner-watchdog.sh'), '# Generic watchdog fixture\n');
  const manifest = {
    schema: 'winhoo.desktop-runtime/1',
    version: '0.4.0',
    kind: 'windows-desktop-vm',
    configurationSchema: 'winhoo.desktop/1',
    controller: 'winhoo_desktop.py',
    controllerBundle: '/usr/share/winhoo/controller',
    applications: [],
    guestTools: { hiddenLauncher: String.raw`C:\ProgramData\WinHoo\tools\WinHoo.RunHidden.exe` },
  };
  writeFileSync(join(source, 'desktop/runtime.json'), JSON.stringify(manifest));
  const record = { Id: id, Os: 'linux', Architecture: 'arm64', Config: { Labels: { ...labels } } };
  const calls = [];
  const options = {
    runtimeRoot: join(root, 'runtime'),
    engine: 'docker',
    architecture: 'arm64',
    version: '0.4.0',
    run(program, args) {
      assert.equal(program, 'docker');
      calls.push(args);
      if (args[0] === 'image') return { status: 0, stdout: JSON.stringify([record]) };
      if (args[0] === 'cp')
        cpSync(join(source, args[1].split('/usr/share/winhoo/controller/')[1]), args[2]);
      return { status: 0, stdout: '' };
    },
  };
  return { source, manifest, record, calls, options };
}

test('installed image supplies a private immutable controller cache without starting Windows', (t) => {
  const { options, calls } = fixture(t);
  const result = resolveWinhooRuntime(options);
  assert.equal(result.image, id);
  assert.equal(result.buildImage, false);
  const create = calls.find((args) => args[0] === 'create');
  assert.deepEqual(create.slice(3), ['--network', 'none', '--entrypoint', '/bin/true', id]);
  assert.equal(calls.filter((args) => args[0] === 'cp').length, 3);
  assert.deepEqual(calls.at(-1), ['rm', '--volumes', create[2]]);
  assert.ok(calls.every((args) => !['run', 'start', 'compose'].includes(args[0])));
  calls.length = 0;
  assert.deepEqual(resolveWinhooRuntime(options), result);
  assert.deepEqual(
    calls.map((args) => args[0]),
    ['image'],
  );
  writeFileSync(result.controller, '# altered controller\n');
  assert.throws(() => resolveWinhooRuntime(options), /cache is damaged/);
});

test('failed or incompatible extraction removes its own temporary container and files', (t) => {
  const { options, calls } = fixture(t);
  const run = options.run;
  options.run = (program, args, config) =>
    args[0] === 'cp'
      ? (calls.push(args), { status: 1, stderr: 'fixture copy failure' })
      : run(program, args, config);
  assert.throws(() => resolveWinhooRuntime(options), /fixture copy failure/);
  assert.equal(calls.at(-1)[0], 'rm');
  assert.equal(existsSync(join(options.runtimeRoot, 'winhoo-controller', id.slice(7))), false);
});

test('wrong image architecture, contract or applications fail before creating a container', (t) => {
  const { options, record, calls } = fixture(t);
  for (const change of [
    () => {
      record.Architecture = 'amd64';
    },
    () => {
      record.Architecture = 'arm64';
      record.Config.Labels['io.openhoo.winhoo.desktop.applications'] = 'nvda';
    },
    () => {
      record.Config.Labels = { ...labels, 'io.openhoo.winhoo.desktop.version': '0.2.0' };
    },
  ]) {
    change();
    assert.throws(() => resolveWinhooRuntime(options), /general Linux arm64 desktop runtime 0.4.0/);
  }
  assert.ok(calls.every((args) => args[0] === 'image'));
});

test('an older desktop image without the hidden launcher fails before Windows starts', (t) => {
  const { options, source, manifest, calls } = fixture(t);
  delete manifest.guestTools;
  writeFileSync(join(source, 'desktop/runtime.json'), JSON.stringify(manifest));
  assert.throws(() => resolveWinhooRuntime(options), /hidden launcher/);
  assert.ok(calls.every((args) => !['run', 'start', 'compose'].includes(args[0])));
});
