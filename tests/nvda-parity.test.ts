import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { SCREEN_READER_ACTIONS } from '../src/types.js';

const coveragePath = resolve('oracle/parity/coverage.json');
const pluginPath = resolve(
  'oracle/windows-nvda/oem/hoosaidthat/nvdaConfig/scratchpad/globalPlugins/hoosaidthatControl.py',
);
const surfacePath = resolve('oracle/parity/accessibility-testing-surface.json');

test('NVDA parity coverage and guest command catalog exactly match public actions', () => {
  const coverage = JSON.parse(readFileSync(coveragePath, 'utf8')) as {
    matrix: unknown[];
    scenarios: Record<string, string[]>;
  };
  assert.equal(coverage.matrix.length, 4);
  const covered = Object.values(coverage.scenarios).flat();
  assert.equal(covered.length, 190, 'NVDA web-profile action count changed');
  assert.equal(covered.length, new Set(covered).size, 'coverage actions must be unique');
  assert.deepEqual([...covered].sort(), Object.keys(SCREEN_READER_ACTIONS).sort());

  const plugin = readFileSync(pluginPath, 'utf8');
  const guestActions = [...plugin.matchAll(/^\s*\(\s*"([A-Za-z0-9]+)"\s*,\s*"/gm)].map(
    (match) => match[1]!,
  );
  assert.equal(guestActions.length, new Set(guestActions).size, 'guest actions must be unique');
  assert.deepEqual(guestActions.sort(), Object.keys(SCREEN_READER_ACTIONS).sort());
  assert.match(plugin, /speech\.extensions\.pre_speechQueued\.register/);
  assert.match(plugin, /braille\.pre_writeCells\.register/);
  assert.match(plugin, /inputCore\.manager\.emulateGesture/);
  assert.match(plugin, /def event_liveRegionChange\(/);
  assert.match(plugin, /def event_alert\(/);
  assert.doesNotMatch(plugin, /Bearer [A-Za-z0-9_-]{32}/);
});

test('HooVDA parity runner shards the complete command surface', () => {
  const runner = readFileSync(resolve('scripts/hoovda-parity.mjs'), 'utf8');
  assert.match(runner, /actions\.length !== 190/);
  assert.match(runner, /new Set\(actions\)\.size !== actions\.length/);
  assert.match(runner, /const shards = chunk\(actions, 24\)/);
  assert.match(runner, /const selectedShard = process\.argv\[4\] \?\? 'all'/);
  assert.match(runner, /HOOSAIDTHAT_NVDA_PARITY_CORE: '1'/);
  assert.match(runner, /HOOSAIDTHAT_NVDA_PARITY_ACTIONS: shards\[index\]\.join\(','\)/);
  assert.match(runner, /HOOSAIDTHAT_NVDA_PARITY_SETTINGS: '1'/);
  assert.match(runner, /createRequire\(import\.meta\.url\)/);
  assert.match(runner, /require\.resolve\('@playwright\/test\/cli'\)/);
});

test('accessibility-testing surface is pinned and never labels pending commands implemented', () => {
  const surface = JSON.parse(readFileSync(surfacePath, 'utf8')) as {
    reference: { version: string; releaseCommit: string };
    implementedCommandManifest: string;
    pendingCommandGroups: Record<string, string[]>;
    implementedBehaviorGroups: string[];
    pendingBehaviorGroups: string[];
  };
  assert.equal(surface.reference.version, '2026.1.1');
  assert.equal(surface.reference.releaseCommit, '5d92106f17e461dac62aa48257bbbf4183e033d0');
  assert.equal(surface.implementedCommandManifest, 'coverage.json');
  const pending = Object.values(surface.pendingCommandGroups).flat();
  assert.equal(pending.length, new Set(pending).size, 'pending commands must be unique');
  for (const action of Object.keys(SCREEN_READER_ACTIONS)) {
    assert(!pending.includes(action), `${action} cannot be both implemented and pending`);
  }
  assert.equal(
    surface.pendingBehaviorGroups.length,
    new Set(surface.pendingBehaviorGroups).size,
    'pending behaviors must be unique',
  );
  for (const behavior of surface.pendingBehaviorGroups) {
    assert(
      !surface.implementedBehaviorGroups.includes(behavior),
      `${behavior} cannot be both implemented and pending`,
    );
  }
});

test('Windows oracle exposes guest services only through host loopback', () => {
  const compose = readFileSync(resolve('oracle/windows-nvda/compose.yml'), 'utf8');
  const mappings = compose.match(/^\s+-\s+([^\n]+:\d+\/(?:tcp|udp))$/gm) ?? [];
  assert(mappings.length >= 5);
  for (const mapping of mappings) assert.match(mapping, /127\.0\.0\.1:/);
  assert.match(compose, /dockurr\/windows@sha256:[0-9a-f]{64}/);
  assert.match(compose, /127\.0\.0\.1:2224:22\/tcp/);
  assert.match(compose, /USER_PORTS:\s*"22,3000,9222"/);
  assert.doesNotMatch(compose, /privileged:\s*true/);
});

test('Windows SSH control is key-only, pinned, forced, and allowlisted', () => {
  const configure = readFileSync(
    resolve('oracle/windows-nvda/oem/hoosaidthat/configure-ssh.ps1'),
    'utf8',
  );
  const dispatcher = readFileSync(
    resolve('oracle/windows-nvda/oem/hoosaidthat/ssh-dispatch.ps1'),
    'utf8',
  );
  const host = readFileSync(resolve('scripts/nvda-windows.mjs'), 'utf8');
  const runtime = readFileSync(
    resolve('oracle/windows-nvda/oem/hoosaidthat/start-runtime.ps1'),
    'utf8',
  );

  assert.match(configure, /AuthenticationMethods publickey/);
  assert.match(configure, /PasswordAuthentication no/);
  assert.match(configure, /KbdInteractiveAuthentication no/);
  assert.match(configure, /AllowUsers hstoracle/);
  assert.match(configure, /PermitTTY no/);
  assert.match(configure, /AllowTcpForwarding no/);
  assert.match(configure, /AllowAgentForwarding no/);
  assert.match(configure, /PermitTunnel no/);
  assert.match(configure, /ForceCommand powershell\.exe .*ssh-dispatch\.ps1/);
  assert.match(configure, /administrators_authorized_keys/);
  assert.match(configure, /Set-StrictSshFileAcl/);

  assert.match(dispatcher, /locale-en-US\|locale-de-DE/);
  assert.match(dispatcher, /\^update \(\[a-f0-9\]\{64\}\)\$/);
  assert.match(dispatcher, /control payload generation mismatch/);
  assert.match(dispatcher, /control payload manifest too large/);
  assert.match(dispatcher, /runtimeFresh/);
  assert.match(dispatcher, /runtime status too large/);
  assert.match(dispatcher, /Set-RuntimeLocale/);
  assert.doesNotMatch(dispatcher, /Invoke-Expression|\biex\b/iu);

  assert.match(host, /StrictHostKeyChecking=yes/);
  assert.match(host, /UserKnownHostsFile=/);
  assert.match(host, /guest SSH host key changed/);
  assert.match(host, /existing NVDA VM SSH identity is missing/);
  assert.match(host, /reconfigure-ssh/);
  assert.match(host, /locale-en-US/);
  assert.match(host, /locale-de-DE/);
  assert.match(host, /\/run\/shm\/qemu\.pid/);
  assert.match(host, /writeBigUInt64BE/);
  assert.match(host, /readBoundedJsonResponse/);
  assert.match(host, /const parityActionShards = chunk\(parityActions, 24\)/);
  assert.match(host, /fullSharded/);
  assert.match(host, /HOOSAIDTHAT_NVDA_PARITY_CORE/);
  assert.match(host, /--output/);
  assert.match(host, /require\.resolve\('@playwright\/test\/cli'\)/);
  assert.match(host, /existsSync\(join\(projectRoot, 'tsconfig\.build\.json'\)\)/);
  assert.doesNotMatch(host, /\.State\.Health\.Status/);
  assert.doesNotMatch(host, /StrictHostKeyChecking=no/);

  assert.match(configure, /MaxAuthTries 3/);
  assert.match(configure, /LoginGraceTime 20/);
  assert.match(configure, /PermitEmptyPasswords no/);
  assert.match(configure, /HostbasedAuthentication no/);
  assert.match(configure, /PermitUserEnvironment no/);
  assert.match(configure, /LogLevel VERBOSE/);
  assert.match(configure, /sshd configuration invalid/);

  assert.match(runtime, /--lang=\$nvdaLanguage/);
  assert.match(runtime, /locale = \$runtimeLocale/);
});

test('NVDA control serializes mutating operations and fails closed on event loss', () => {
  const plugin = readFileSync(pluginPath, 'utf8');
  assert.match(plugin, /operation_lock = threading\.Lock\(\)/);
  assert.match(plugin, /another session operation is active/);
  assert.match(plugin, /screen-reader event history was truncated/);
  assert.match(plugin, /braille\.handler\.setTether\("focus", auto=True\)/);
  assert.match(plugin, /completed\["result"\]/);
  assert.match(plugin, /finish request must be empty/);
  assert.match(plugin, /reason="timeout" if timed_out else "completed"/);
  assert.match(plugin, /len\(pending\[peers\[endpoint\]\]\) < 1024 \* 1024/);
  assert.match(plugin, /NVDA process language does not match requested session locale/);
});
