import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  guestErrorMessage,
  jawsReady,
  readerCheck,
  readerConfig,
  verifyReaderContainer,
} from '../windows-reader-docker.mjs';

const root = '/private/test/reader';
const opts = {
  root,
  arch: 'amd64',
  acceleration: 'kvm',
  image: 'sha256:' + 'a'.repeat(64),
  cloned: false,
};
const id = 'b'.repeat(64);
test('packaged checks load from another cwd and write reports only in fresh private output', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'windows reader checks '));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const tokenFile = join(cwd, 'fixture-token');
  writeFileSync(tokenFile, 'fixture-private-credential', { mode: 0o600 });
  const seen = new Set();
  for (const [reader, args, spec] of [
    ['nvda', [], 'native.spec.mjs'],
    ['jaws', [], 'jaws.spec.mjs'],
    ['jaws', ['--navigation'], 'jaws-navigation.spec.mjs'],
  ]) {
    const check = readerCheck(reader, args, cwd);
    const [, program, ...parameters] = check.argv;
    assert.equal(statSync(check.directory).mode & 0o777, 0o700);
    assert(!seen.has(check.directory));
    seen.add(check.directory);
    const probe = spawnSync(program, [...parameters, '--list'], {
      cwd, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, SCREEN_READER: reader, HST_NATIVE_TOKEN_FILE: tokenFile, ...check.env },
    });
    assert.equal(probe.status, 0, probe.stderr);
    assert(probe.stdout.includes(spec));
    const report = readFileSync(check.env.HST_NATIVE_JSON, 'utf8');
    assert(!report.includes('fixture-private-credential'));
    assert.equal(JSON.parse(report).config.projects[0].outputDir, check.env.HST_NATIVE_RESULTS);
    assert.equal(check.env.HST_NATIVE_RESULTS, join(check.directory, 'artifacts'));
  }
  assert.throws(() => readerCheck('nvda', ['--navigation'], cwd), /Use nvda check/);
  assert.throws(() => readerCheck('jaws', ['--grep', 'example'], cwd), /Use nvda check/);
});
test('guest failure surfaces PowerShell errors beyond progress output', () => {
  const progress = '<Obj S="progress">' + 'noise'.repeat(600) + '</Obj>';
  const prefix = '#< CLIXML\r\n<Objs>';
  const error = '<S S="Error">Access &amp; sharing violation_x000D__x000A_</S>';
  assert.equal(
    guestErrorMessage(prefix + progress + error + '</Objs>', 1),
    'Access & sharing violation',
  );
  assert.equal(guestErrorMessage(prefix + progress + '</Objs>', 5), 'guest exit 5');
  assert.equal(guestErrorMessage('plain diagnostic\n', 1), 'plain diagnostic');
});
function record(config) {
  return {
    Id: id,
    Name: '/' + config.name,
    Image: config.image,
    Config: {
      Labels: {
        'io.openhoo.winhoo.desktop': createHash('sha256')
          .update(join(root, 'winhoo-docker.json'))
          .digest('hex'),
      },
    },
    HostConfig: {
      PortBindings: Object.fromEntries(
        config.ports.map((p) => [
          p.guest + '/' + p.protocol,
          [{ HostIp: '127.0.0.1', HostPort: String(p.host) }],
        ]),
      ),
    },
    Mounts: [
      { Type: 'bind', Source: config.shared, Destination: '/shared' },
      { Type: 'bind', Source: config.oem, Destination: '/oem', RW: false },
      config.legacyBind
        ? { Type: 'bind', Source: config.storage, Destination: '/storage' }
        : { Type: 'volume', Name: config.volume, Destination: '/storage' },
    ],
  };
}
test('readers have independent persistent disks, loopback port assignments and Windows accounts', () => {
  const n = readerConfig('nvda', opts),
    j = readerConfig('jaws', opts);
  assert.notEqual(n.volume, j.volume);
  assert.notEqual(n.volume, readerConfig('nvda', { ...opts, root: root + '2' }).volume);
  assert(!n.ports.some((p) => j.ports.some((q) => p.host === q.host)));
  assert.notEqual(n.environment.USERNAME, j.environment.USERNAME);
  assert.equal(readerConfig('jaws', { ...opts, sparseBackup: true }).diskBackup, 'sparse');
  const c = readerConfig('nvda', { ...opts, cloned: true, sparseBackup: true });
  assert.equal(c.diskBackup, 'sparse');
  assert.equal(n.diskBackup, undefined);
});
test('foreign owners, a writable OEM mount and replaced disks cannot be adopted for cleanup', () => {
  for (const cloned of [false, true]) {
    const config = readerConfig('nvda', { ...opts, cloned });
    assert.doesNotThrow(() => verifyReaderContainer(root, config, id, record(config)));
    for (const change of [
      (v) => {
        v.Config.Labels = {};
      },
      (v) => {
        v.Mounts[1].RW = true;
      },
      (v) => {
        Object.values(v.HostConfig.PortBindings)[0][0].HostIp = '0.0.0.0';
      },
      (v) => {
        v.Image = opts.image + 'x';
      },
      (v) => {
        v.Id = 'c'.repeat(64);
      },
      (v) => {
        v.Mounts[2].Source = v.Mounts[2].Name = 'another-disk';
      },
    ]) {
      const v = record(config);
      change(v);
      assert.throws(() => verifyReaderContainer(root, config, id, v), /does not match/);
    }
  }
});
test('real JAWS protocol, capture, product and Chrome version must all agree', () => {
  const lock = {
    jaws: { version: '2027.1.2.3' },
    chrome: { version: '151.0.0.1' },
  };
  const health = {
    ready: true,
    status: 'ok',
    protocolVersion: '2.0',
    profile: 'jaws-web',
    screenReader: 'jaws',
    platform: 'windows',
    capture: 'jaws-speech-output',
    version: lock.jaws.version,
    browser: { version: lock.chrome.version },
  };
  const chrome = {
    Browser: 'Chrome/' + lock.chrome.version,
    webSocketDebuggerUrl: 'ws://127.0.0.1:9226/devtools/browser/example',
  };
  assert.equal(jawsReady(health, chrome, lock), true);
  for (const field of Object.keys(health))
    assert.equal(jawsReady({ ...health, [field]: null }, chrome, lock), false, field);
  assert.equal(jawsReady(health, { ...chrome, Browser: 'Chrome/other' }, lock), false);
  assert.equal(jawsReady(health, { ...chrome, webSocketDebuggerUrl: '' }, lock), false);
});
