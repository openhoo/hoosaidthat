import { defineConfig } from '@openhoo/hoosaidthat';

const locale = process.env.SCREEN_READER_LOCALE;
const keyboardLayout = process.env.SCREEN_READER_KEYBOARD_LAYOUT;
const requestedAdapter = process.env.HOOSAIDTHAT_PARITY_ADAPTER ?? 'nvda';
const controlToken = process.env.HOOSAIDTHAT_NVDA_CONTROL_TOKEN;
const artifactRun = process.env.HOOSAIDTHAT_NVDA_PARITY_ARTIFACTS === '1';
if (locale !== 'en-US' && locale !== 'de-DE') throw new Error('parity locale is required');
if (keyboardLayout !== 'desktop' && keyboardLayout !== 'laptop')
  throw new Error('parity keyboard layout is required');
if (requestedAdapter !== 'nvda' && requestedAdapter !== 'hoovda') {
  throw new Error('HOOSAIDTHAT_PARITY_ADAPTER must be "nvda" or "hoovda"');
}
if (requestedAdapter === 'nvda' && !controlToken) throw new Error('NVDA control token is required');

const screenReaderOptions =
  requestedAdapter === 'nvda'
    ? {
        screenReader: 'nvda' as const,
        runtime: 'external' as const,
        controlEndpoint: 'http://127.0.0.1:3002',
        cdpEndpoint: 'http://127.0.0.1:9224',
        controlToken,
      }
    : {
        screenReader: 'hoovda' as const,
        image: process.env.SCREEN_READER_IMAGE ?? 'hoosaidthat-hoovda:dev',
      };

export default defineConfig({
  testDir: '.',
  testMatch: 'nvda-parity.spec.ts',
  outputDir: `../../test-results/${requestedAdapter}-${locale.toLowerCase()}-${keyboardLayout}-parity`,
  workers: 1,
  fullyParallel: false,
  timeout: 12 * 60_000,
  use: {
    // Real screen-reader pointer coordinates require browser-native geometry.
    viewport: null,
    // The page overlay is part of the browser frame, so Playwright video keeps
    // NVDA actions and captured presentation text synchronized in one artifact.
    video: 'on',
    trace: 'retain-on-failure',
    screenReaderOptions: {
      ...screenReaderOptions,
      profile: 'nvda-web-2026.1.1',
      locale,
      keyboardLayout,
      recording: requestedAdapter === 'hoovda' && !artifactRun ? 'off' : 'on',
      overlay: true,
      actionScreenshots: 'off',
      startupTimeoutMs: 120_000,
      actionTimeoutMs: 15_000,
      quietMs: 500,
      keepContainer: process.env.KEEP_SCREEN_READER_CONTAINER === '1',
    },
  },
});
