import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import test from 'node:test';
import { listenForEmulatorConsole, startTalkBackEmulator } from '../native/android-emulator.mjs';
import { parseTalkBackArguments } from '../talkback-android.mjs';

function harness({ reportSerial = Promise.resolve('emulator-5560'), boot = ['1'], identity = 'HST_test\r\nOK\r\n' } = {}) {
  const actions = [], child = new EventEmitter(); let stopped = 0, listenerClosed = 0, lastBoot;
  const deps = {
    pollMs: 1, bootTimeoutMs: 2000,
    listAvds: async () => ['HST_test'],
    listen: async () => ({ port: 49152, serial: reportSerial, close() { listenerClosed++; } }),
    launch: args => { actions.push(['launch', args]); return child; },
    stop: async target => { assert.equal(target, child); stopped++; },
    createDevice: serial => async (...args) => {
      actions.push([serial, args]);
      if (args.join(' ') === 'shell getprop sys.boot_completed') return boot.length ? (lastBoot = boot.shift()) : lastBoot;
      if (args.join(' ') === 'emu avd name') return identity;
      throw new Error('unexpected device command');
    },
  };
  return { deps, actions, child, stopped: () => stopped, listenerClosed: () => listenerClosed };
}

test('managed AVD options cannot mutate the external device path', () => {
  assert.deepEqual(parseTalkBackArguments(['doctor', '--serial', 'emulator-5554']).serial, 'emulator-5554');
  const parsed = parseTalkBackArguments(['run', '--avd', 'HST_test', '--token-file', '/tmp/token', '--talkback-apk', 'TalkBack.apk', '--', 'npm', 'test']);
  assert.equal(parsed.avd, 'HST_test'); assert.equal(parsed['talkback-apk'], 'TalkBack.apk'); assert.deepEqual(parsed.child, ['npm', 'test']);
  for (const args of [
    ['doctor', '--avd', 'HST_test'], ['start', '--avd', '../HST_test'], ['run', '--avd', 'test;stop'],
    ['run', '--avd', 'HST_test', '--serial', 'emulator-5554'], ['run', '--serial', 'emulator-5554', '--talkback-apk', 'test.apk'],
  ]) assert.throws(() => parseTalkBackArguments([...args, '--token-file', '/tmp/token']));
});

test('reads the allocated even console port over loopback without assuming port 5554', async t => {
  for (const [report, expected] of [['5562', 'emulator-5562'], ['5555', null], ['9999', null]]) {
    const listener = await listenForEmulatorConsole(); t.after(() => listener.close());
    const socket = createConnection(listener.port, '127.0.0.1'); t.after(() => socket.destroy());
    await once(socket, 'connect'); socket.write(report.slice(0, 2)); socket.end(report.slice(2));
    if (expected) assert.equal(await listener.serial, expected);
    else await assert.rejects(listener.serial, /invalid console port/);
  }
});

test('boots a disposable AVD, checks its identity, and stops only its process once', async () => {
  const h = harness({ boot: ['', '0', '1'] });
  const emulator = await startTalkBackEmulator('HST_test', h.deps);
  assert.equal(emulator.serial, 'emulator-5560');
  const launch = h.actions[0][1];
  for (const arg of ['-avd', 'HST_test', '-read-only', '-no-snapshot', '-no-window', '-report-console', 'tcp:49152']) assert(launch.includes(arg));
  assert(!launch.includes('-wipe-data'));
  assert.deepEqual(h.actions.slice(1).map(a => a[0]), Array(4).fill(emulator.serial));
  assert.equal(h.listenerClosed(), 1); assert.equal(h.stopped(), 0);
  await Promise.all([emulator.close(), emulator.close()]); assert.equal(h.stopped(), 1);
});

test('lavapipe disables guest Vulkan and malformed GPU options never launch an emulator', async () => {
  const h = harness();
  await assert.rejects(startTalkBackEmulator('HST_test', { ...h.deps, gpu: 'lavapipe -wipe-data' }), /HST_EMULATOR_GPU/);
  assert.deepEqual(h.actions, []);
  const emulator = await startTalkBackEmulator('HST_test', { ...h.deps, gpu: 'lavapipe' });
  try {
    const args = h.actions[0][1];
    assert.deepEqual(args.slice(args.indexOf('-gpu'), args.indexOf('-gpu') + 4), ['-gpu', 'lavapipe', '-feature', '-Vulkan']);
  } finally { await emulator.close(); }
});

test('a different or unregistered AVD cannot be configured', async () => {
  const h = harness({ identity: 'other-avd\nOK\n' });
  await assert.rejects(startTalkBackEmulator('doesnt_exist', h.deps), /does not exist/);
  assert.deepEqual(h.actions, []); assert.equal(h.stopped(), 0);
  await assert.rejects(startTalkBackEmulator('HST_test', h.deps), /different AVD/);
  assert.deepEqual(h.actions.at(-1), ['emulator-5560', ['emu', 'avd', 'name']]);
  assert.equal(h.stopped(), 1); assert.equal(h.listenerClosed(), 1);
});

test('failure, timeout or interrupt before a console report always releases the process', async () => {
  for (const kind of ['exit', 'timeout', 'abort']) {
    const h = harness({ reportSerial: new Promise(() => {}) }), controller = new AbortController();
    const launch = h.deps.launch;
    h.deps.launch = args => { const child = launch(args); queueMicrotask(() => {
      if (kind === 'exit') child.emit('exit', 9, null);
      if (kind === 'abort') controller.abort(new Error('interrupted during boot'));
    }); return child; };
    await assert.rejects(startTalkBackEmulator('HST_test', { ...h.deps, signal: controller.signal, bootTimeoutMs: 15 }),
      kind === 'exit' ? /exited \(9\)/ : kind === 'timeout' ? /Timed out/ : /interrupted during boot/);
    assert.equal(h.stopped(), 1); assert.equal(h.listenerClosed(), 1);
    assert.equal(h.actions.length, 1);
  }
});
