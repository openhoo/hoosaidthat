import { defineConfig } from '@openhoo/hoosaidthat';

export default defineConfig({
  testDir: '.', testMatch: 'record-feature.spec.mjs', workers: 1, retries: 0,
  timeout: 15 * 60_000, outputDir: process.env.HST_TALKBACK_RESULTS, reporter: 'list',
  use: { screenReaderOptions: { screenReader: 'talkback', runtime: 'external',
    locale: process.env.SCREEN_READER_LOCALE ?? 'en-US', overlay: false, actionTimeoutMs: 15000 } },
});
