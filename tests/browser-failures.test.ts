import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { Page } from '@playwright/test';
import { markReaderGesture, watchBrowserFailures } from '../src/browser-failures.js';

test('a burst cannot evict the first script failure; later gestures and private values stay distinguishable', async () => {
  const emitter = new EventEmitter();
  const page = emitter as unknown as Page;
  const finish = watchBrowserFailures(page);
  const request = (type: string, url: string, detail: string) => ({
    url: () => url, resourceType: () => type, failure: () => ({ errorText: detail }),
  });
  const privateURL = 'https://private-user:private-pass@private-host.invalid/private-path/private-file.svg?import&private-key=private-value#private-fragment';
  for (let i = 0; i < 50; i++) {
    emitter.emit('pageerror', Object.assign(new Error('private-message'), { name: 'private-error' }));
  }
  const script = request('script', privateURL, 'net::ERR_NETWORK_CHANGED');
  emitter.emit('requestfailed', script);
  markReaderGesture(page);
  emitter.emit('response', { request: () => script, status: () => 503 });
  emitter.emit('requestfailed', request('script', 'data:text/html,private-data', 'private-detail'));
  for (let i = 0; i < 24; i++) emitter.emit('requestfailed', script);
  let raw = '';
  await finish({ testId: 'opaque-id', retry: 2, status: 'timedOut', attach: async (_name, { body } = {}) => { raw = body!.toString(); } });
  const report = JSON.parse(raw);
  assert.doesNotMatch(raw, /private-/);
  assert.equal(report.retry, 2);
  assert.equal(report.status, 'timedOut');
  assert.equal(typeof report.firstReaderGestureAtMs, 'number');
  assert.equal(report.events.length, 24);
  assert.deepEqual(report.seen, { documentOrScript: 27, other: 50 });
  assert.equal(report.omitted, 53);
  assert.equal(report.events[0].name, 'Error');
  const [first, http, unrecognized] = report.events.slice(8, 11);
  assert.equal(first.beforeFirstReaderGesture, true);
  assert.equal(first.code, 'ERR_NETWORK_CHANGED');
  assert.equal(first.importQuery, true);
  assert.equal(first.extension, 'svg');
  assert.equal(http.beforeFirstReaderGesture, false);
  assert.equal(http.status, 503);
  assert.match(first.resourceId, /^[a-f0-9]{16}$/);
  assert.equal(first.resourceId, http.resourceId);
  assert.equal(unrecognized.code, 'unknown');
  assert.equal(unrecognized.resourceId, undefined);
  assert.deepEqual(emitter.eventNames(), []);
});
