import {
  defineConfig as baseDefineConfig,
  test as base,
  type Browser,
  type BrowserContext,
  type Page,
  type PlaywrightTestConfig,
} from '@playwright/test';
import { HttpScreenReaderClient } from './client.js';
import { isRuntimeBootstrapURL } from './bootstrap.js';
import { ScreenReaderRuntime } from './runtime.js';
import { ScreenReaderSession } from './session.js';
import {
  resolveOptions,
  type ResolvedScreenReaderOptions,
  type ScreenReaderOptions,
} from './types.js';

// Native Chromium exits when its final window closes. Retain one owned
// window outside isolated test contexts only while their final windows close.
const keepAlivePages = new WeakMap<Browser, Page>();
const keepAliveCreations = new WeakMap<Browser, Promise<void>>();
const KEEP_ALIVE_URL = 'data:text/html,<title>HooSaidThat runtime keepalive</title>';

async function ensureKeepAlive(
  browser: Browser,
  testContext: BrowserContext,
  closingPages: readonly Page[] = testContext.pages(),
): Promise<void> {
  const creating = keepAliveCreations.get(browser);
  if (creating) return await creating;
  const existing = keepAlivePages.get(browser);
  if (existing && !existing.isClosed()) return;
  const otherPageExists = browser.contexts().some(candidate =>
    candidate.pages().some(page => !page.isClosed() && !closingPages.includes(page)),
  );
  if (otherPageExists) return;
  const nativeContext = browser.contexts().find(candidate => candidate !== testContext);
  if (nativeContext) {
    const creation = (async () => {
      const page = await nativeContext.newPage();
      await page.goto(KEEP_ALIVE_URL);
      keepAlivePages.set(browser, page);
    })();
    keepAliveCreations.set(browser, creation);
    try {
      await creation;
    } finally {
      keepAliveCreations.delete(browser);
    }
  }
}

export interface ScreenReaderFixtures {
  screenReader: ScreenReaderSession;
}

export interface ScreenReaderWorkerFixtures {
  screenReaderOptions: ScreenReaderOptions;
  screenReaderResolvedOptions: ResolvedScreenReaderOptions;
  screenReaderRuntime: ScreenReaderRuntime;
  screenReaderClient: HttpScreenReaderClient;
}

export const test = base.extend<ScreenReaderFixtures, ScreenReaderWorkerFixtures>({
  screenReaderOptions: [{}, { option: true, scope: 'worker' }],

  screenReaderResolvedOptions: [
    async ({ screenReaderOptions }, use) => {
      await use(resolveOptions(screenReaderOptions));
    },
    { scope: 'worker' },
  ],

  screenReaderRuntime: [
    async ({ screenReaderResolvedOptions }, use, workerInfo) => {
      const runtime = await ScreenReaderRuntime.start(
        screenReaderResolvedOptions,
        workerInfo.workerIndex,
      );
      try {
        await use(runtime);
      } finally {
        await runtime.stop();
      }
    },
    { scope: 'worker', timeout: 0 },
  ],

  screenReaderClient: [
    async ({ screenReaderRuntime, screenReaderResolvedOptions }, use) => {
      await use(
        new HttpScreenReaderClient(
          screenReaderRuntime.endpoints,
          screenReaderResolvedOptions.screenReader,
          screenReaderResolvedOptions.actionTimeoutMs,
          {
            profile: screenReaderResolvedOptions.profile,
            locale: screenReaderResolvedOptions.locale,
            keyboardLayout: screenReaderResolvedOptions.keyboardLayout,
          },
        ),
      );
    },
    { scope: 'worker' },
  ],

  browser: [
    async ({ playwright, screenReaderRuntime }, use) => {
      const browser = await playwright.chromium.connectOverCDP(
        screenReaderRuntime.endpoints.cdpEndpoint,
      );
      try {
        await use(browser);
      } finally {
        await browser.close();
      }
    },
    { scope: 'worker' },
  ],

  page: async ({ context, browser }, use) => {
    // Keep Playwright's per-test context for isolation, tracing, and video.
    // Once its page exists, retire the runtime bootstrap tab even when it
    // belongs to the browser's separate default context. Native focus must
    // not retain a different document from the one Playwright is driving.
    const existing = context
      .pages()
      .find((candidate) => isRuntimeBootstrapURL(candidate.url()));
    const page = existing ?? context.pages()[0] ?? (await context.newPage());
    await page.bringToFront();
    const keepAlive = keepAlivePages.get(browser);
    if (keepAlive && keepAlive !== page) {
      await keepAlive.close();
      keepAlivePages.delete(browser);
    }
    for (const candidateContext of browser.contexts()) {
      for (const candidate of candidateContext.pages()) {
        if (candidate !== page && isRuntimeBootstrapURL(candidate.url())) {
          await candidate.close();
        }
      }
    }
    // A test may close its final window and continue asynchronous cleanup.
    // Establish the between-test window before close can terminate Chromium.
    // Retire it after the next test's page exists, keeping one native window
    // during ordinary screen-reader actions and per-test video capture.
    const originalPageCloses = new Map<Page, Page['close']>();
    const closingPages = new Set<Page>();
    const guardPageClose = (candidate: Page): void => {
      if (originalPageCloses.has(candidate)) return;
      const closePage = candidate.close;
      originalPageCloses.set(candidate, closePage);
      candidate.close = async (options) => {
        closingPages.add(candidate);
        try {
          if (browser.isConnected()) {
            await ensureKeepAlive(browser, context, [...closingPages]);
          }
          await closePage.call(candidate, options);
        } finally {
          closingPages.delete(candidate);
        }
      };
    };
    for (const candidate of context.pages()) guardPageClose(candidate);
    // Popups and secondary pages can outlive the primary fixture page. Guard
    // their final-window closes too, including concurrent page cleanup.
    context.on('page', guardPageClose);
    const closeContext = context.close;
    context.close = async (options) => {
      if (browser.isConnected()) await ensureKeepAlive(browser, context);
      await closeContext.call(context, options);
    };
    try {
      await use(page);
    } finally {
      try {
        if (browser.isConnected()) await ensureKeepAlive(browser, context);
        if (!page.isClosed()) await page.close();
      } finally {
        context.off('page', guardPageClose);
        for (const [candidate, closePage] of originalPageCloses) candidate.close = closePage;
        context.close = closeContext;
      }
    }
  },

  screenReader: async (
    { page, screenReaderClient, screenReaderResolvedOptions },
    use,
    testInfo,
  ) => {
    const session = await ScreenReaderSession.create(
      page,
      screenReaderClient,
      screenReaderResolvedOptions,
      testInfo,
    );
    try {
      await use(session);
    } finally {
      await session.finish();
    }
  },
});

export function defineConfig(
  config: PlaywrightTestConfig<ScreenReaderFixtures, ScreenReaderWorkerFixtures>,
  ...configs: PlaywrightTestConfig<ScreenReaderFixtures, ScreenReaderWorkerFixtures>[]
): PlaywrightTestConfig<ScreenReaderFixtures, ScreenReaderWorkerFixtures> {
  return baseDefineConfig<ScreenReaderFixtures, ScreenReaderWorkerFixtures>(
    withNativeViewport(config),
    ...configs.map(withNativeViewport),
  );
}

function withNativeViewport(
  config: PlaywrightTestConfig<ScreenReaderFixtures, ScreenReaderWorkerFixtures>,
): PlaywrightTestConfig<ScreenReaderFixtures, ScreenReaderWorkerFixtures> {
  return {
    ...config,
    use: { ...config.use, viewport: null },
    ...(config.projects ? {
      projects: config.projects.map((project) => ({
        ...project,
        use: { ...project.use, viewport: null },
      })),
    } : {}),
  };
}
