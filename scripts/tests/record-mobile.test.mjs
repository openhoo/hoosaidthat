import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRecording } from '../record-mobile.mjs';
import { runAndroidSteps } from '../mobile-scenario.mjs';

test('choose either a scenario or a custom Android workflow, preserving child flags and spaces', () => {
  const args = ['android', '--avd', 'demo', '--', 'npx', 'playwright', 'test', '--grep', 'Pay now'];
  assert.deepEqual(parseRecording(args).child, args.slice(4));
  assert.throws(() => parseRecording(['android','--avd','demo','--scenario','a.json','--','npm','test']));
  assert.throws(() => parseRecording(['ios','--','npm','test']));
  assert.throws(() => parseRecording(['ios','--dedicated-mac-output']));
  assert.equal(parseRecording(['ios','--dedicated-mac-output','--audio-device','BlackHole 2ch']).options['--dedicated-mac-output'], true);
  assert.throws(() => parseRecording(['android','--udid','wrong']));
  assert.throws(() => parseRecording(['android','--avd','one','--avd','two']));
});

const feature = steps => ({ url: 'https://example.test/orders', steps });
const heard = (...texts) => ({ timedOut: false, speechEvents: texts.map(text => ({text})) });
test('find a label within actual reader output then move backward in reading order', async () => {
  const commands = [], responses = [heard('Order summary, heading'), heard('Continue, button'), heard('Order summary, heading')];
  await runAndroidSteps(feature([
    { action: 'forward', until: 'Continue', maxMoves: 3 },
    { action: 'backward', expect: 'Order summary' },
  ]), async id => { commands.push(id); return responses.shift(); });
  assert.deepEqual(commands, ['moveToNextObjectFlat','moveToNextObjectFlat','moveToPreviousObjectFlat']);
});
test('unrelated speech, silence and timed-out observations do not pass', async () => {
  let calls = 0;
  await assert.rejects(runAndroidSteps(feature([{ action: 'forward', until: 'value', maxMoves: 2 }]),
    async () => { calls++; return heard('another','label'); }), /did not speak/);
  assert.equal(calls, 2);
  await assert.rejects(runAndroidSteps(feature([{ action:'current' }]), async () => heard('  ')), /did not speak/);
  await assert.rejects(runAndroidSteps(feature([{ action:'current',expect:'value' }]), async () => ({...heard('value'), timedOut:true})), /did not settle/);
  await assert.rejects(runAndroidSteps(feature([{ action:'activate',until:'value',maxMoves:2 }]), assert.fail), /Invalid Android scenario/);
});
