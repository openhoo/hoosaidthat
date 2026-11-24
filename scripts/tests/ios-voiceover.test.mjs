import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { selectDevice, validateScenario, validateTranscript } from '../voiceover-ios.mjs';

const url = 'https://example.test/checkout';
const actions = ['current', 'forward', 'backward', 'in', 'out'];

test('CLI help exposes the doctor and run commands even without the Apple toolchain', () => {
  const cli = fileURLToPath(new URL('../voiceover-ios.mjs', import.meta.url));
  const help = spawnSync(process.execPath, [cli, '--help'], {
    env: { ...process.env, DEVELOPER_DIR: '/no-such-xcode', PATH: '' },
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(help.error, undefined);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /\bdoctor\b/);
  assert.match(help.stdout, /\brun\b/);
});

test('the npm package ships the iPhone runner and every source needed by the XCTest target', () => {
  const args = ['pack', '--dry-run', '--ignore-scripts', '--json', '--offline'];
  const npm = process.env.npm_execpath;
  const packed = spawnSync(npm ? process.execPath : 'npm', npm ? [npm, ...args] : args, {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', timeout: 30_000,
    shell: !npm && process.platform === 'win32',
  });
  assert.equal(packed.error, undefined);
  assert.equal(packed.status, 0, packed.stderr);
  const [manifest] = JSON.parse(packed.stdout);
  const paths = new Set(manifest.files.map(item => item.path));
  for (const file of [
    'scripts/voiceover-ios.mjs', 'scripts/voiceover-ios.d.mts', 'oracle/ios-voiceover/VoiceOverTests.swift',
    'oracle/ios-voiceover/HSTVoiceOver.h', 'oracle/ios-voiceover/HSTVoiceOver.m',
    'oracle/ios-voiceover/HooSaidThat.xcodeproj/project.pbxproj',
    'oracle/ios-voiceover/HooSaidThat.xcodeproj/xcshareddata/xcschemes/HooSaidThat.xcscheme',
  ]) assert.ok(paths.has(file), `npm package omitted ${file}`);
});

test('the scenario preserves action order, a literal expectation and a bounded search', () => {
  const steps = actions.map(action => ({ action }));
  steps[0].expect = 'Total: €19.99 (incl. VAT)';
  Object.assign(steps[1], { until: 'Continue checkout', maxMoves: 12 });
  const scenario = validateScenario({ url, steps });
  assert.equal(scenario.url, url);
  assert.deepEqual(scenario.steps, steps);
  assert.doesNotThrow(() => validateScenario({ url: 'http://127.0.0.1:8080/', steps }));
});

test('the runner rejects credentials, non-web URLs and invalid step limits before opening Safari', () => {
  const steps = [{ action: 'forward' }];
  for (const invalidUrl of [
    'relative/path', 'file:///etc/hosts', 'data:text/plain,hello',
    'https://user:secret@example.test/', 'http://token@example.test/',
  ]) {
    assert.throws(() => validateScenario({ url: invalidUrl, steps }), invalidUrl);
  }
  for (const invalidSteps of [
    [], Array(101).fill(steps[0]), [{ action: 'tap' }], [{ action: 'forward', expect: '' }],
    [{ action: 'current', until: 'Checkout', maxMoves: 3 }],
    [{ action: 'in', until: '', maxMoves: 1 }], [{ action: 'out', until: 'Checkout' }],
    [{ action: 'forward', expect: 'Next', maxMoves: 2 }],
    [{ action: 'forward', expect: 'One', until: 'Two', maxMoves: 2 }],
    ...[0, 51, 1.2, '2'].map(maxMoves => [{ action: 'forward', until: 'Checkout', maxMoves }]),
  ]) {
    assert.throws(() => validateScenario({ url, steps: invalidSteps }));
  }
  assert.doesNotThrow(() => validateScenario({ url, steps: Array(100).fill(steps[0]) }));
  assert.doesNotThrow(() => validateScenario({
    url, steps: [{ action: 'in', until: 'Cart', maxMoves: 1 }, { action: 'out', until: 'Checkout', maxMoves: 50 }],
  }));
});

const ios26 = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5';
const ios27 = 'com.apple.CoreSimulator.SimRuntime.iOS-27-1';
const unavailable = 'com.apple.CoreSimulator.SimRuntime.iOS-27-0';
const tvOS = 'com.apple.CoreSimulator.SimRuntime.tvOS-27-1';
const runtimes = [
  [ios26, '26.5', true], [ios27, '27.1', true], [unavailable, '27.0', false], [tvOS, '27.1', true],
].map(([identifier, version, isAvailable]) => {
  const platform = identifier === tvOS ? 'tvOS' : 'iOS';
  return { identifier, version, isAvailable, platform, name: `${platform} ${version}` };
});
function device(id, type = 'iPhone-17-Pro', extra = {}) {
  return {
    udid: `00000000-1111-2222-3333-${String(id).padStart(12, '0')}`,
    name: 'test device', deviceTypeIdentifier: `com.apple.CoreSimulator.SimDeviceType.${type}`,
    state: 'Shutdown', isAvailable: true, ...extra,
  };
}

test('device eligibility uses platform, runtime, device availability and type rather than its editable name', () => {
  const phone = device(1, 'iPhone-17-Pro', { name: 'CI device' });
  const others = [
    device(2, 'iPad-Pro', { name: 'iPhone 17 Pro' }),
    device(3, 'iPhone-17-Pro', { isAvailable: false }),
  ];
  const devices = {
    [ios26]: [device(4)], [unavailable]: [device(5)], [tvOS]: [device(6)],
    [ios27]: [...others, phone],
  };
  assert.equal(selectDevice(devices, runtimes).udid, phone.udid);
  for (const other of Object.values(devices).flat().filter(item => item !== phone)) {
    assert.throws(() => selectDevice(devices, runtimes, other.udid), other.udid);
  }
});

test('selection refuses ambiguous simulators and an absent requested UDID', () => {
  const first = device(7, 'iPhone-17', { state: 'Booted' });
  const second = device(8);
  const devices = { [ios27]: [first, second] };
  assert.throws(() => selectDevice(devices, runtimes));
  assert.equal(selectDevice(devices, runtimes, second.udid).udid, second.udid);
  assert.throws(() => selectDevice(devices, runtimes, device(9).udid));
});

const scenario = {
  url,
  steps: [
    { action: 'current', expect: 'Checkout' },
    { action: 'forward', until: 'Continue', maxMoves: 2 },
    { action: 'backward', expect: 'Price: €19.99' },
  ],
};
function transcript() {
  return {
    version: 1, url, completed: true,
    events: [
      { step: 0, action: 'current', utterance: 'Checkout, heading' },
      { step: 1, action: 'forward', utterance: 'Price: €19.99' },
      { step: 1, action: 'forward', utterance: 'Continue, button' },
      { step: 2, action: 'backward', utterance: 'Price: €19.99' },
    ],
  };
}

test('the transcript binds actual spoken text and every navigation attempt to the corresponding scenario step', () => {
  assert.doesNotThrow(() => validateTranscript(scenario, transcript()));
  for (const mutate of [
    t => { t.version = 2; }, t => { t.completed = false; },
    t => { t.url += '/other'; }, t => { t.events.pop(); },
    t => { t.events[0].action = 'forward'; }, t => { t.events[0].step = 1; },
    t => { delete t.events[0].utterance; }, t => { t.events[0].utterance = ''; },
    t => { t.events[0].utterance = 'Unrelated application'; },
    t => { t.events[2].utterance = 'Cancel, button'; },
    t => { t.events[3].utterance = 'Price: €19x99'; },
    t => { t.events[1].utterance = 'Continue, button'; },
    t => { t.events.splice(1, 0, { ...t.events[1] }); },
    t => { t.events.push({ ...t.events[3] }); },
  ]) {
    const invalid = transcript();
    mutate(invalid);
    assert.throws(() => validateTranscript(scenario, invalid), mutate.toString());
  }
});
