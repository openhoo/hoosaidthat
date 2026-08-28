import { defineConfig } from '@openhoo/hoosaidthat';

const requestedScreenReader = process.env.SCREEN_READER ?? 'orca';
if (requestedScreenReader !== 'orca' && requestedScreenReader !== 'hoovda') {
  throw new Error('SCREEN_READER must be "orca" or "hoovda"');
}
const image =
  process.env.SCREEN_READER_IMAGE ?? `hoosaidthat-${requestedScreenReader}:dev`;
const requestedLocale = process.env.SCREEN_READER_LOCALE ?? 'en-US';
if (requestedLocale !== 'en-US' && requestedLocale !== 'de-DE') {
  throw new Error('SCREEN_READER_LOCALE must be "en-US" or "de-DE"');
}
const requestedKeyboardLayout = process.env.SCREEN_READER_KEYBOARD_LAYOUT ?? 'desktop';
if (requestedKeyboardLayout !== 'desktop' && requestedKeyboardLayout !== 'laptop') {
  throw new Error('SCREEN_READER_KEYBOARD_LAYOUT must be "desktop" or "laptop"');
}

export default defineConfig({
  testDir: './tests',
  workers: 1,
  webServer: {
    command: 'python3 -m http.server 4173 --bind 127.0.0.1 --directory site',
    port: 4173,
    reuseExistingServer: true,
  },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    video: 'on',
    trace: 'retain-on-failure',
    screenReaderOptions: {
      screenReader: requestedScreenReader,
      image,
      profile: 'nvda-web-2026.1.1',
      locale: requestedLocale,
      keyboardLayout: requestedKeyboardLayout,
      recording: 'on',
      actionScreenshots: 'on',
      keepContainer: process.env.KEEP_SCREEN_READER_CONTAINER === '1',
    },
  },
});
