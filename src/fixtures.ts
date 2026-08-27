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
    config,
    ...configs,
  );
}
