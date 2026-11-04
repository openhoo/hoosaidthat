import { readFileSync } from 'node:fs';
import { defineConfig } from '@openhoo/hoosaidthat';
const reader = process.env.SCREEN_READER;
if (!['voiceover'].includes(reader)) throw new Error('SCREEN_READER must be voiceover');
export default defineConfig({
  testDir: '.', testMatch: 'native.spec.mjs', workers: 1, fullyParallel: false,
  timeout: 90000, expect: { timeout: 15000 },
  outputDir: process.env.HST_NATIVE_RESULTS ?? 'test-results',
  reporter: [['list'], ['json', { outputFile: process.env.HST_NATIVE_JSON ?? 'native-results.json' }]],
  use: { screenReaderOptions: {
    screenReader: reader, runtime: 'external',
    controlEndpoint: 'http://127.0.0.1:3003', cdpEndpoint: 'http://127.0.0.1:9225',
    controlToken: readFileSync(process.env.HST_NATIVE_TOKEN_FILE, 'utf8').trim(),
    locale: 'en-US', keyboardLayout: 'desktop', webReport: 'on', overlay: true,
  } },
});
