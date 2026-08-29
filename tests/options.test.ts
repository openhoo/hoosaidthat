import assert from 'node:assert/strict';
import test from 'node:test';
import { defineConfig } from '../src/fixtures.js';
import { resolveOptions, SCREEN_READER_ACTIONS } from '../src/types.js';

test('screen-reader config forces native browser viewport', () => {
  const config = defineConfig({
    use: { viewport: { width: 800, height: 600 } },
  });
  assert.equal(config.use?.viewport, null);
});

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

test('resolves NVDA only as an external Windows oracle', () => {
  const options = resolveOptions({
    screenReader: 'nvda',
    controlEndpoint: 'http://127.0.0.1:3002',
    cdpEndpoint: 'http://127.0.0.1:9224',
    controlToken: 'secret',
  });
  assert.equal(options.runtime, 'external');
  assert.equal(options.screenReader, 'nvda');
  assert.equal(options.image, 'external:nvda-windows');
  assert.equal(options.actionTimeoutMs, 15_000);
  assert.throws(
    () =>
      resolveOptions({
        screenReader: 'nvda',
        runtime: 'podman',
      }),
    /requires runtime "external"/,
  );
  assert.throws(
    () =>
      resolveOptions({
        screenReader: 'nvda',
        controlEndpoint: 'http://127.0.0.1:3002',
        cdpEndpoint: 'http://127.0.0.1:9224',
        controlToken: 'secret',
        containerEngineArgs: ['--network=host'],
      }),
    /containerEngineArgs are not supported/,
  );
});

test('rejects unsafe timeout and viewport values', () => {
  assert.throws(() => resolveOptions({ quietMs: 0 }), /quietMs/);
  assert.throws(() => resolveOptions({ quietMs: 5_001 }), /quietMs/);
  assert.throws(() => resolveOptions({ actionTimeoutMs: 30_001 }), /actionTimeoutMs/);
  assert.throws(
    () => resolveOptions({ screenReader: 'hoovda', actionTimeoutMs: 5_000 }),
    /graph refresh deadline/,
  );
  assert.throws(() => resolveOptions({ viewport: { width: 200, height: 720 } }), /viewport.width/);
  assert.throws(
    () => resolveOptions({ viewport: { width: 8_193, height: 720 } }),
    /viewport.width/,
  );
});

test('rejects invalid runtime options received from JavaScript', () => {
  assert.throws(() => resolveOptions({ runtime: 'invalid' as never }), /runtime/);
  assert.throws(() => resolveOptions({ screenReader: 'jaws' as never }), /screenReader/);
  assert.throws(() => resolveOptions({ image: ' ' }), /image/);
  assert.throws(() => resolveOptions({ containerEngineArgs: [''] }), /containerEngineArgs/);
  assert.throws(
    () =>
      resolveOptions({
        containerEngineArgs: Array.from({ length: 101 }, () => '--label=x'),
      }),
    /containerEngineArgs/,
  );
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
  assert.throws(
    () =>
      resolveOptions({
        runtime: 'external',
        controlEndpoint: 'http://user:password@127.0.0.1:3000',
        cdpEndpoint: 'http://127.0.0.1:9222',
        controlToken: 'secret',
      }),
    /controlEndpoint/,
  );
  assert.throws(
    () =>
      resolveOptions({
        runtime: 'external',
        controlEndpoint: 'http://192.0.2.1:3000',
        cdpEndpoint: 'http://192.0.2.1:9222',
        controlToken: 'secret',
      }),
    /HTTPS unless it targets host loopback/,
  );
  assert.throws(
    () =>
      resolveOptions({
        runtime: 'external',
        controlEndpoint: 'http://127.0.0.1:3000',
        cdpEndpoint: 'http://127.0.0.1:9222',
        controlToken: 'secret\nX-Injected: true',
      }),
    /controlToken/,
  );
});
