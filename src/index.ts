export { defineConfig, test } from './fixtures.js';
export type { ScreenReaderFixtures, ScreenReaderWorkerFixtures } from './fixtures.js';
export { expect } from './matchers.js';
export { HttpScreenReaderClient, ScreenReaderProtocolError } from './client.js';
export { ScreenReaderRuntime } from './runtime.js';
export { ScreenReaderSession } from './session.js';
export { SCREEN_READER_ACTIONS, resolveOptions } from './types.js';
export type {
  ActionScreenshotMode,
  AudioEvent,
  BrailleEvent,
  CaptureBoundary,
  ContainerRuntime,
  DownloadedArtifact,
  ElementCapture,
  FocusEvent,
  KeyboardLayout,
  LifecycleEvent,
  ModeEvent,
  RecordingMode,
  ResolvedScreenReaderOptions,
  RuntimeArtifact,
  RuntimeEndpoints,
  ScanOptions,
  ScanResult,
  ScreenReaderAction,
  ScreenReaderCapabilities,
  ScreenReaderHealth,
  ScreenReaderEvent,
  ScreenReaderLocale,
  ScreenReaderName,
  ScreenReaderObservation,
  ScreenReaderOptions,
  ScreenReaderProfile,
  ScreenReaderState,
  SpeechEvent,
} from './types.js';
export { devices } from '@playwright/test';
