import type { Browser, BrowserContext, BrowserContextOptions, Frame, Page } from '@playwright/test';
import { isRuntimeBootstrapURL } from './bootstrap.js';

export type ScreenReaderContextFactory = (options?: BrowserContextOptions) => Promise<{
  context: BrowserContext;
  close: () => Promise<void>;
}>;

/** Android Chrome exposes a persistent context and cannot create incognito contexts over CDP. */
export function androidContextFactory(browser: Browser): ScreenReaderContextFactory {
  return async (options) => {
    if (options && Object.keys(options).length > 0) {
      throw new Error('TalkBack uses the Android device context; browser.newContext options are unavailable');
    }
    const context = browser.contexts()[0];
    if (!context) throw new Error('TalkBack requires Android Chrome with a persistent CDP context');
    const existing = new Set(context.pages());
    const origins = new Set<string>();
    const listeners = new Map<Page, (frame: Frame) => void>();
    const track = (page: Page): void => {
      const listener = (frame: Frame): void => {
        try {
          const url = new URL(frame.url());
          if (url.protocol === 'http:' || url.protocol === 'https:') origins.add(url.origin);
        } catch { /* Non-network documents have no origin storage to clear. */ }
      };
      listeners.set(page, listener);
      page.on('framenavigated', listener);
    };
    for (const page of context.pages()) if (isRuntimeBootstrapURL(page.url())) track(page);
    context.on('page', track);
    let closed = false;
    return { context, close: async () => {
      if (closed) return;
      closed = true;
      context.off('page', track);
      for (const [page, listener] of listeners) page.off('framenavigated', listener);
      try {
        if (browser.isConnected()) {
          await context.unrouteAll({ behavior: 'wait' });
          await context.clearCookies();
          if (origins.size) {
            // The page fixture can already have closed the last test tab.
            // A temporary target keeps origin cleanup effective in that case.
            const page = context.pages().find(candidate => !candidate.isClosed()) ?? await context.newPage();
            const cdp = await context.newCDPSession(page);
            try {
              for (const origin of origins) await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
            } finally { await cdp.detach(); }
          }
        }
      } finally {
        for (const page of context.pages()) if (!existing.has(page)) await page.close();
      }
    } };
  };
}
