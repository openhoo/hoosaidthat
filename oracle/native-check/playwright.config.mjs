import { readFileSync } from 'node:fs';
import { defineConfig } from '@openhoo/hoosaidthat';
const reader = process.env.SCREEN_READER;
if (!reader || !['voiceover', 'jaws', 'nvda'].includes(reader)) throw new Error('SCREEN_READER must be voiceover, jaws or nvda');
const controlPort = reader === 'jaws' ? 3004 : reader === 'nvda' ? 3002 : 3003;
const cdpPort = reader === 'jaws' ? 9226 : reader === 'nvda' ? 9224 : 9225;
export default defineConfig({
  testDir: '.',
  testMatch: reader === 'jaws' ? ['native.spec.mjs', 'jaws.spec.mjs'] : 'native.spec.mjs',
  workers: 1, fullyParallel: false,
  timeout: 90000, expect: { timeout: 15000 },
  outputDir: process.env.HST_NATIVE_RESULTS ?? 'test-results',
  reporter: [['list'], ['json', { outputFile: process.env.HST_NATIVE_JSON ?? 'native-results.json' }]],
  use: { screenReaderOptions: {
    screenReader: reader, runtime: 'external',
    controlEndpoint: process.env[`HOOSAIDTHAT_${reader.toUpperCase()}_CONTROL_ENDPOINT`] ?? `http://127.0.0.1:${controlPort}`,
    cdpEndpoint: process.env[`HOOSAIDTHAT_${reader.toUpperCase()}_CDP_ENDPOINT`] ?? `http://127.0.0.1:${cdpPort}`,
    controlToken: readFileSync(process.env.HST_NATIVE_TOKEN_FILE, 'utf8').trim(),
    locale: 'en-US', keyboardLayout: 'desktop', webReport: 'on', overlay: true,
  } },
});
