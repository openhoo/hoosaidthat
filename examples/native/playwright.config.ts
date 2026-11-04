import { readFileSync } from 'node:fs';
import { defineConfig, type ScreenReaderName } from '../../src/index.js';

const reader = process.env.SCREEN_READER ?? 'voiceover';
if (reader !== 'voiceover') throw new Error('SCREEN_READER must be voiceover');
const prefix = `HOOSAIDTHAT_${reader.toUpperCase()}`;
const tokenFile = process.env.HST_NATIVE_TOKEN_FILE;

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
      controlEndpoint: process.env[`${prefix}_CONTROL_ENDPOINT`] ?? 'http://127.0.0.1:3003',
      cdpEndpoint: process.env[`${prefix}_CDP_ENDPOINT`] ?? 'http://127.0.0.1:9225',
      controlToken: process.env[`${prefix}_CONTROL_TOKEN`] ?? (tokenFile ? readFileSync(tokenFile, 'utf8').trim() : ''),
      locale: process.env.SCREEN_READER_LOCALE === 'de-DE' ? 'de-DE' : 'en-US',
      keyboardLayout: 'desktop',
      actionTimeoutMs: 15000,
      overlay: true,
      webReport: 'on',
    },
  },
});
