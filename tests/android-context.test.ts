import assert from 'node:assert/strict';
import test from 'node:test';
import type { Browser } from '@playwright/test';
import { androidContextFactory } from '../src/android-context.js';

test('Android uses its persistent context and clears visited storage before closing test pages', async () => {
  const calls: unknown[] = [];
  let onPage: ((page: unknown) => void) | undefined;
  let onNavigate: ((frame: { url(): string }) => void) | undefined;
  const bootstrap = { close: async () => calls.push('close-bootstrap'), isClosed: () => false, url: () => 'about:blank' };
  const page = { close: async () => calls.push('close-test-page'), isClosed: () => false,
    on(_event: string, listener: typeof onNavigate) { onNavigate = listener; }, off() {} };
  const pages: unknown[] = [bootstrap];
  const context = {
    pages: () => pages,
    on(_event: string, listener: typeof onPage) { onPage = listener; },
    off() { calls.push('remove-tracker'); },
    unrouteAll: async () => calls.push('clear-routes'),
    clearCookies: async () => calls.push('clear-cookies'),
    newCDPSession: async () => ({
      send: async (command: string, args: unknown) => calls.push([command, args]),
      detach: async () => calls.push('detach'),
    }),
  };
  const browser = { contexts: () => [context], isConnected: () => true } as unknown as Browser;
  const factory = androidContextFactory(browser);
  await assert.rejects(() => factory({ viewport: { width: 320, height: 480 } }), /device context/);
  const session = await factory();
  assert.equal(session.context, context);
  pages.push(page);
  onPage?.(page);
  onNavigate?.({ url: () => 'http://localhost:3000/checkout' });
  onNavigate?.({ url: () => 'data:text/html,private' });
  await session.close();
  await session.close();
  assert.deepEqual(calls, ['remove-tracker', 'clear-routes', 'clear-cookies',
    ['Storage.clearDataForOrigin', { origin: 'http://localhost:3000', storageTypes: 'all' }], 'detach', 'close-test-page']);
});

test('Android refuses a CDP browser without a persistent context', async () => {
  const browser = { contexts: () => [] } as unknown as Browser;
  await assert.rejects(() => androidContextFactory(browser)(), /persistent CDP context/);
});

test('Android still clears origin storage after the final test tab has closed', async () => {
  const calls: string[] = [];
  let onPage: ((page: unknown) => void) | undefined;
  let onNavigate: ((frame: { url(): string }) => void) | undefined;
  const cleanupPage = { close: async () => { calls.push('close-cleanup'); }, isClosed: () => false };
  const page = { on(_event: string, listener: typeof onNavigate) { onNavigate = listener; }, off() {} };
  let pages: unknown[] = [];
  const context = {
    pages: () => pages,
    on(_event: string, listener: typeof onPage) { onPage = listener; }, off() {},
    unrouteAll: async () => {}, clearCookies: async () => {},
    newPage: async () => { calls.push('create-cleanup'); pages = [cleanupPage]; return cleanupPage; },
    newCDPSession: async () => ({ send: async () => { calls.push('clear-origin'); }, detach: async () => {} }),
  };
  const browser = { contexts: () => [context], isConnected: () => true } as unknown as Browser;
  const session = await androidContextFactory(browser)();
  onPage?.(page);
  onNavigate?.({ url: () => 'http://localhost:3000/checkout' });
  await session.close();
  assert.deepEqual(calls, ['create-cleanup', 'clear-origin', 'close-cleanup']);
});
