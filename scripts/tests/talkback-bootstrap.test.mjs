import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyTalkBackBootstrap } from '../talkback-android.mjs';
import { TalkBackCaptureError, TalkBackDriver } from '../native/talkback.mjs';
import { NATIVE_BOOTSTRAP_URL } from '../../dist/bootstrap.js';

function coldBoot(behaviors, onFocus = () => {}) {
  const signal = new AbortController().signal;
  const drivers = [], titles = [];
  let clock = 0, listener;
  const result = verifyTalkBackBootstrap({ signal, now: () => clock, wait: async ms => { clock += ms; },
    connect: async () => {
      const behavior = behaviors[drivers.length];
      const d = { closed: false, canonical: false, close: async () => { d.closed = true; },
        onSpeech: fn => { listener = fn; return () => { listener = undefined; }; },
        drain: async () => {
          if (d.canonical && behavior === 'restart') throw new TalkBackCaptureError('fixture capture restarted');
          if (behavior === 'stale') listener(titles[0]);
          else if (!d.canonical) listener(titles.at(-1));
        } };
      drivers.push(d); return d;
    },
    navigate: async url => {
      if (url === NATIVE_BOOTSTRAP_URL) drivers.at(-1).canonical = true;
      else titles.push(/<title>([^<]+)<\/title>/.exec(decodeURIComponent(url))[1]);
    }, focus: onFocus,
  });
  return { result, drivers, titles };
}

test('a cold engine restart and delayed old title require reattachment and a new live challenge', async () => {
  const { result, drivers, titles } = coldBoot(['restart', 'stale', 'ok']);
  assert.equal(await result, drivers[2]);
  assert.deepEqual(drivers.map(d => d.closed), [true, true, false]);
  assert.equal(new Set(titles).size, 3);
  // Once returned, this driver's errors cannot trigger another bootstrap attempt.
  await drivers[2].close();
});

test('repeated cold restarts fail closed; unrelated setup errors are not retried', async () => {
  const exhausted = coldBoot(['restart', 'restart', 'restart']);
  await assert.rejects(exhausted.result, /after 3 attempts/);
  assert.deepEqual(exhausted.drivers.map(d => d.closed), [true, true, true]);
  const badFocus = coldBoot(['ok'], () => { throw new Error('native focus failed'); });
  await assert.rejects(badFocus.result, /native focus failed/);
  assert.deepEqual(badFocus.drivers.map(d => d.closed), [true]);
});

test('initial capture corruption produces a retryable status without exposing speech', async () => {
  const state = { ok:true, version:'15', browserVersion:'124', browserWindowActive:true, webContentFocused:true };
  const adb = async (...args) => Buffer.from(args[0] === 'exec-out' ? 'private initial speech\\n\n' :
    args.includes('instrument') ? `INSTRUMENTATION_RESULT: hst=${JSON.stringify(state)}\n` : '123\n');
  await assert.rejects(TalkBackDriver.connect(adb), e => e instanceof TalkBackCaptureError && !e.message.includes('private'));
});
