import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveOptions, SCREEN_READER_ACTIONS } from '../src/types.js';

test('resolves safe runtime defaults', () => {
  const options = resolveOptions();
  assert.equal(options.runtime, 'auto');
  assert.equal(options.screenReader, 'orca');
  assert.equal(options.overlay, true);
  assert.equal(options.quietMs, 300);
  assert.deepEqual(options.viewport, { width: 1280, height: 720 });
  assert.equal(SCREEN_READER_ACTIONS.nextHeading, 'Next heading');
});

test('resolves Linux HooVDA image and immutable profile', () => {
  const options = resolveOptions({ screenReader: 'hoovda' });
  assert.equal(options.screenReader, 'hoovda');
  assert.match(options.image, /hoosaidthat-hoovda/);
  assert.equal(options.profile, 'nvda-web-2026.1.1');
  assert.equal(options.recording, 'on');
  assert.equal(options.startupTimeoutMs, 60_000);
  assert.equal(options.actionTimeoutMs, 15_000);
});

test('external runtime requires all endpoints and token', () => {
  assert.throws(
    () => resolveOptions({ runtime: 'external' }),
    /external runtime requires controlEndpoint, cdpEndpoint, and controlToken/,
  );
  const options = resolveOptions({
    runtime: 'external',
    controlEndpoint: 'http://127.0.0.1:3000',
    cdpEndpoint: 'http://127.0.0.1:9222',
    controlToken: 'secret',
  });
  assert.equal(options.controlToken, 'secret');
});

test('rejects unsafe timeout and viewport values', () => {
  assert.throws(() => resolveOptions({ quietMs: 0 }), /quietMs/);
  assert.throws(() => resolveOptions({ quietMs: 5_001 }), /quietMs/);
  assert.throws(() => resolveOptions({ actionTimeoutMs: 30_001 }), /actionTimeoutMs/);
  assert.throws(
    () => resolveOptions({ screenReader: 'hoovda', actionTimeoutMs: 5_000 }),
    /graph refresh deadline/,
  );
  assert.throws(
    () => resolveOptions({ viewport: { width: 200, height: 720 } }),
    /viewport.width/,
  );
});

test('rejects invalid runtime options received from JavaScript', () => {
  assert.throws(() => resolveOptions({ runtime: 'invalid' as never }), /runtime/);
  assert.throws(
    () => resolveOptions({ screenReader: 'nvda' as never }),
    /screenReader/,
  );
  assert.throws(() => resolveOptions({ image: ' ' }), /image/);
  assert.throws(() => resolveOptions({ containerEngineArgs: [''] }), /containerEngineArgs/);
  assert.throws(
    () =>
      resolveOptions({
        runtime: 'external',
        controlEndpoint: 'not-a-url',
        cdpEndpoint: 'http://127.0.0.1:9222',
        controlToken: 'secret',
      }),
    /controlEndpoint/,
  );
});
