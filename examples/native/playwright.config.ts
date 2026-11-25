import { defineConfig, type ScreenReaderName } from '../../src/index.js';

const reader = process.env.SCREEN_READER ?? 'voiceover';
if (!['voiceover', 'jaws', 'nvda'].includes(reader)) throw new Error('SCREEN_READER must be voiceover, jaws or nvda');
const prefix = `HOOSAIDTHAT_${reader.toUpperCase()}`;

const controlPort = reader === 'jaws' ? 3004 : reader === 'nvda' ? 3002 : 3003;
const cdpPort = reader === 'jaws' ? 9226 : reader === 'nvda' ? 9224 : 9225;
export default defineConfig({
  testDir: './tests',
  workers: 1,
  fullyParallel: false,
  timeout: 90000,
  expect: { timeout: 15000 },
  use: {
    trace: 'retain-on-failure',
    screenReaderOptions: {
      screenReader: reader as ScreenReaderName,
      runtime: 'external',
      controlEndpoint: process.env[`${prefix}_CONTROL_ENDPOINT`] ?? `http://127.0.0.1:${controlPort}`,
      cdpEndpoint: process.env[`${prefix}_CDP_ENDPOINT`] ?? `http://127.0.0.1:${cdpPort}`,
      controlTokenFile: process.env.HST_NATIVE_TOKEN_FILE,
      locale: process.env.SCREEN_READER_LOCALE === 'de-DE' ? 'de-DE' : 'en-US',
      keyboardLayout: 'desktop',
      actionTimeoutMs: 15000,
      overlay: true,
      webReport: 'on',
    },
  },
});
