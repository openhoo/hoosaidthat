import { defineConfig } from '@openhoo/hoosaidthat';

export default defineConfig({
  testDir: '.', testMatch: 'talkback.spec.mjs', workers: 1, fullyParallel: false,
  timeout: 120000, expect: { timeout: 15000 },
  outputDir: process.env.HST_TALKBACK_RESULTS ?? 'test-results',
  reporter: [['list']],
  use: { screenReaderOptions: {
    screenReader: 'talkback', runtime: 'external',
    locale: process.env.SCREEN_READER_LOCALE === 'de-DE' ? 'de-DE' : 'en-US',
    keyboardLayout: 'desktop', quietMs: 500, actionTimeoutMs: 15000,
    webReport: 'on', overlay: true,
  } },
});
