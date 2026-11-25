import assert from 'node:assert/strict';
import test from 'node:test';
import { sendEmulatorChord } from '../native/emulator-keyboard.mjs';
import { nativeCommands } from '../native/commands.mjs';

test('USB keyboard holds both modifiers through the key press and releases them in reverse order', async () => {
  const calls = [];
  await sendEmulatorChord(async (...args) => { calls.push(args); }, [57, 59, 36]);
  assert.equal(calls.length, 1);
  const [shell, tty, script] = calls[0];
  assert.deepEqual([shell, tty], ['shell', '-T']);
  const [, records] = /^printf '%s\\n' '([^']+)' \| uinput -$/.exec(script);
  const [register, ready, down, held, up] = records.split('\n').map(JSON.parse);
  assert.equal(register.bus, 'usb');
  assert.equal(ready.command, 'delay');
  assert.ok(ready.duration > 0 && held.duration > 0);
  assert.deepEqual(down.events, [1,56,1,0,0,0, 1,42,1,0,0,0, 1,35,1,0,0,0]);
  assert.deepEqual(up.events, [1,35,0,0,0,0, 1,42,0,0,0,0, 1,56,0,0,0,0]);
});

test('all advertised keyboard commands have hardware mappings; invalid chords never reach adb', async () => {
  for (const command of Object.values(nativeCommands('talkback')).filter(Array.isArray)) {
    for (const chord of command) await sendEmulatorChord(async () => {}, chord);
  }
  for (const invalid of [[], 'readCurrent', [999], [57, 999], [57, 57, 36], ['57', 36], [36, 57], [57], [36, 8]]) {
    await assert.rejects(sendEmulatorChord(() => assert.fail('sent invalid gesture'), invalid), /unsupported/);
  }
});

test('a failed keyboard command reports the transport failure without replaying the chord', async () => {
  let attempts = 0;
  await assert.rejects(sendEmulatorChord(async () => { ++attempts; throw new Error('device disconnected'); }, [57, 36]), /device disconnected/);
  assert.equal(attempts, 1);
});
