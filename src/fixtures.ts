import {
  defineConfig as baseDefineConfig,
  test as base,
  type PlaywrightTestConfig,
} from '@playwright/test';
import { HttpScreenReaderClient } from './client.js';
import { ScreenReaderRuntime } from './runtime.js';
import { ScreenReaderSession } from './session.js';
import {
  resolveOptions,
  type ResolvedScreenReaderOptions,
  type ScreenReaderOptions,
} from './types.js';

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
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          if (page.url() === 'about:blank') await page.close();
        }
      }
      try {
        await use(browser);
      } finally {
        await browser.close();
      }
    },
    { scope: 'worker' },
  ],

  page: async ({ context }, use) => {
    // Drive the runtime-owned foreground tab. Creating a second CDP page can
    // leave Chromium's bootstrap tab as the X11/AT-SPI active tab, making
    // Playwright and the screenreader observe different documents.
    const existing = context
      .pages()
      .find((candidate) => candidate.url().startsWith('file:///opt/hoosaidthat/bootstrap.html'));
    const page = existing ?? context.pages()[0] ?? (await context.newPage());
    await page.bringToFront();
    try {
      await use(page);
    } finally {
      if (!page.isClosed()) await page.close();
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
  return { ...config, use: { ...config.use, viewport: null } };
}
