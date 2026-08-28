import type { Locator } from '@playwright/test';

export const SCREEN_READER_ACTIONS = {
  nextFocusable: 'Next focusable element',
  previousFocusable: 'Previous focusable element',
  activate: 'Activate current element',
  activateWithSpace: 'Activate current element with Space',
  escape: 'Escape current context',
  returnToPage: 'Return focus to web page',
  nextHeading: 'Next heading',
  previousHeading: 'Previous heading',
  nextHeading1: 'Next heading level 1',
  previousHeading1: 'Previous heading level 1',
  nextHeading2: 'Next heading level 2',
  previousHeading2: 'Previous heading level 2',
  nextHeading3: 'Next heading level 3',
  previousHeading3: 'Previous heading level 3',
  nextHeading4: 'Next heading level 4',
  previousHeading4: 'Previous heading level 4',
  nextHeading5: 'Next heading level 5',
  previousHeading5: 'Previous heading level 5',
  nextHeading6: 'Next heading level 6',
  previousHeading6: 'Previous heading level 6',
  nextHeading7: 'Next heading level 7',
  previousHeading7: 'Previous heading level 7',
  nextHeading8: 'Next heading level 8',
  previousHeading8: 'Previous heading level 8',
  nextHeading9: 'Next heading level 9',
  previousHeading9: 'Previous heading level 9',
  nextLandmark: 'Next landmark',
  previousLandmark: 'Previous landmark',
  nextButton: 'Next button',
  previousButton: 'Previous button',
  nextFormField: 'Next form field',
  previousFormField: 'Previous form field',
  nextLink: 'Next link',
  previousLink: 'Previous link',
  nextVisitedLink: 'Next visited link',
  previousVisitedLink: 'Previous visited link',
  nextUnvisitedLink: 'Next unvisited link',
  previousUnvisitedLink: 'Previous unvisited link',
  nextList: 'Next list',
  previousList: 'Previous list',
  nextListItem: 'Next list item',
  previousListItem: 'Previous list item',
  nextTable: 'Next table',
  previousTable: 'Previous table',
  nextImage: 'Next graphic',
  previousImage: 'Previous graphic',
  nextCheckbox: 'Next check box',
  previousCheckbox: 'Previous check box',
  nextRadioButton: 'Next radio button',
  previousRadioButton: 'Previous radio button',
  nextCombobox: 'Next combo box',
  previousCombobox: 'Previous combo box',
  nextEntry: 'Next edit field',
  previousEntry: 'Previous edit field',
  nextParagraph: 'Next text paragraph',
  previousParagraph: 'Previous text paragraph',
  nextFrame: 'Next frame',
  previousFrame: 'Previous frame',
  nextSeparator: 'Next separator',
  previousSeparator: 'Previous separator',
  nextBlockQuote: 'Next block quote',
  previousBlockQuote: 'Previous block quote',
  nextEmbeddedObject: 'Next embedded object',
  previousEmbeddedObject: 'Previous embedded object',
  nextAnnotation: 'Next annotation',
  previousAnnotation: 'Previous annotation',
  nextSpellingError: 'Next spelling error',
  previousSpellingError: 'Previous spelling error',
  nextNotLinkBlock: 'Next text after block of links',
  previousNotLinkBlock: 'Previous text after block of links',
  nextCharacter: 'Next character',
  previousCharacter: 'Previous character',
  nextWord: 'Next word',
  previousWord: 'Previous word',
  nextLine: 'Next line',
  previousLine: 'Previous line',
  nextParagraphText: 'Next paragraph by text',
  previousParagraphText: 'Previous paragraph by text',
  documentStart: 'Start of document',
  documentEnd: 'End of document',
  previousTableColumn: 'Previous table column',
  nextTableColumn: 'Next table column',
  previousTableRow: 'Previous table row',
  nextTableRow: 'Next table row',
  firstTableColumn: 'First table column',
  lastTableColumn: 'Last table column',
  firstTableRow: 'First table row',
  lastTableRow: 'Last table row',
  readCurrent: 'Read current location',
  reportDetails: 'Report details',
  sayAll: 'Read from current location',
  toggleFocusMode: 'Toggle browse or focus mode',
  toggleSingleLetterNavigation: 'Toggle single letter navigation',
  elementsList: 'Elements list',
  find: 'Find',
  findNext: 'Find next',
  findPrevious: 'Find previous',
} as const;

export type ScreenReaderAction = keyof typeof SCREEN_READER_ACTIONS;
export type ScreenReaderName = 'orca' | 'hoovda';
export type ScreenReaderProfile = 'nvda-web-2026.1.1';
export type ScreenReaderLocale = 'en-US' | 'de-DE';
export type KeyboardLayout = 'desktop' | 'laptop';
export type ContainerRuntime = 'auto' | 'docker' | 'podman' | 'external';
export type ActionScreenshotMode = 'off' | 'on';
export type RecordingMode = 'off' | 'on';
export type CaptureBoundary =
  | 'speech-dispatcher-output-module'
  | 'hoovda-structured-presentation';

export interface ScreenReaderOptions {
  screenReader?: ScreenReaderName;
  profile?: ScreenReaderProfile;
  locale?: ScreenReaderLocale;
  keyboardLayout?: KeyboardLayout;
  runtime?: ContainerRuntime;
  image?: string;
  controlEndpoint?: string;
  cdpEndpoint?: string;
  controlToken?: string;
  startupTimeoutMs?: number;
  actionTimeoutMs?: number;
  quietMs?: number;
  overlay?: boolean;
  recording?: RecordingMode;
  actionScreenshots?: ActionScreenshotMode;
  keepContainer?: boolean;
  containerEngineArgs?: readonly string[];
  viewport?: { width: number; height: number };
}

export interface ResolvedScreenReaderOptions {
  screenReader: ScreenReaderName;
  profile: ScreenReaderProfile;
  locale: ScreenReaderLocale;
  keyboardLayout: KeyboardLayout;
  runtime: ContainerRuntime;
  image: string;
  controlEndpoint: string | undefined;
  cdpEndpoint: string | undefined;
  controlToken: string | undefined;
  startupTimeoutMs: number;
  actionTimeoutMs: number;
  quietMs: number;
  overlay: boolean;
  recording: RecordingMode;
  actionScreenshots: ActionScreenshotMode;
  keepContainer: boolean;
  containerEngineArgs: readonly string[];
  viewport: { width: number; height: number };
}

interface EventBase {
  sequence: number;
  monotonicNs: number;
  kind: string;
  command: string;
  text: string;
  reason?: string;
  source?: AccessibleSource;
}

export interface AccessibleSource {
  bus: string;
  path: string;
}

export interface SpeechEvent extends EventBase {
  kind: 'speech';
  speechCommands?: ReadonlyArray<{ kind: string; value?: string }>;
}

export interface BrailleEvent extends EventBase {
  kind: 'braille';
  cells: readonly number[];
  cursor: number;
}

export interface FocusEvent extends EventBase {
  kind: 'focus';
}

export interface ModeEvent extends EventBase {
  kind: 'mode';
  mode: string;
}

export interface AudioEvent extends EventBase {
  kind: 'audio';
  audioOffsetNs: number;
  audioDurationNs: number;
}

export interface LifecycleEvent extends EventBase {
  kind: 'commandStarted' | 'commandSettled' | 'liveRegion';
}

export type ScreenReaderEvent =
  | SpeechEvent
  | BrailleEvent
  | FocusEvent
  | ModeEvent
  | AudioEvent
  | LifecycleEvent;

export interface ScreenReaderObservation {
  action: ScreenReaderAction | 'focus' | 'observe';
  label: string;
  events: readonly ScreenReaderEvent[];
  speechEvents: readonly SpeechEvent[];
  brailleEvents: readonly BrailleEvent[];
  speech: string;
  braille: string;
  timedOut: boolean;
}

export interface ScreenReaderHealth {
  protocolVersion: 1 | 2;
  status: 'ready';
  screenReader: {
    name: ScreenReaderName;
    version: string;
    capture: CaptureBoundary;
  };
  profile?: ScreenReaderProfile;
  locale?: ScreenReaderLocale;
  keyboardLayout?: KeyboardLayout;
  browser?: { name: string; version: string; cdpPort: number };
  platform: 'linux';
}

export interface ScreenReaderCapabilities {
  protocolVersion: 1 | 2;
  actions: ReadonlyArray<{ action: ScreenReaderAction; label: string }>;
}

export interface ScreenReaderState {
  protocolVersion: 1 | 2;
  lastSequence: number;
  cursorMode?: string;
  virtualBufferActive?: boolean;
  focus: {
    browserWindowActive: boolean;
    webContentFocused: boolean;
    role: string | null;
    name: string | null;
  };
}

export interface RuntimeEndpoints {
  controlEndpoint: string;
  cdpEndpoint: string;
  controlToken: string;
}

export interface RuntimeArtifact {
  name: string;
  contentType: string;
  bytes: number;
  sha256: string;
}

export interface DownloadedArtifact extends RuntimeArtifact {
  body: Uint8Array;
}

export interface ElementCapture {
  name: string;
  locator: Locator;
}

export interface ScanOptions {
  action: ScreenReaderAction;
  name: string;
  max?: number;
  screenshots?: boolean;
  stopOnRepeat?: boolean;
}

export interface ScanResult {
  observations: readonly ScreenReaderObservation[];
  screenshots: readonly string[];
  stoppedOnRepeat: boolean;
  stoppedOnBoundary: boolean;
  stopReason: 'boundary' | 'repeat' | 'max';
}

export function resolveOptions(
  options: ScreenReaderOptions = {},
): ResolvedScreenReaderOptions {
  const screenReader = options.screenReader ?? 'orca';
  if (screenReader !== 'orca' && screenReader !== 'hoovda') {
    throw new Error('screenReaderOptions.screenReader must be "orca" or "hoovda"');
  }
  const profile = options.profile ?? 'nvda-web-2026.1.1';
  if (profile !== 'nvda-web-2026.1.1') {
    throw new Error('screenReaderOptions.profile must be "nvda-web-2026.1.1"');
  }
  const locale = options.locale ?? 'en-US';
  if (locale !== 'en-US' && locale !== 'de-DE') {
    throw new Error('screenReaderOptions.locale must be "en-US" or "de-DE"');
  }
  const keyboardLayout = options.keyboardLayout ?? 'desktop';
  if (keyboardLayout !== 'desktop' && keyboardLayout !== 'laptop') {
    throw new Error('screenReaderOptions.keyboardLayout must be "desktop" or "laptop"');
  }
  const allowedRuntimes: readonly ContainerRuntime[] = ['auto', 'docker', 'podman', 'external'];
  if (options.runtime !== undefined && !allowedRuntimes.includes(options.runtime)) {
    throw new Error('screenReaderOptions.runtime is not supported');
  }
  const viewport = options.viewport ?? { width: 1280, height: 720 };
  if (!Number.isInteger(viewport.width) || viewport.width < 320) {
    throw new Error('screenReaderOptions.viewport.width must be an integer >= 320');
  }
  if (!Number.isInteger(viewport.height) || viewport.height < 240) {
    throw new Error('screenReaderOptions.viewport.height must be an integer >= 240');
  }
  const resolved: ResolvedScreenReaderOptions = {
    screenReader,
    profile,
    locale,
    keyboardLayout,
    runtime: options.runtime ?? 'auto',
    image:
      options.image ??
      (screenReader === 'hoovda'
        ? process.env.HOOSAIDTHAT_HOOVDA_IMAGE ?? 'ghcr.io/openhoo/hoosaidthat-hoovda:0.1.0'
        : process.env.HOOSAIDTHAT_ORCA_IMAGE ?? 'ghcr.io/openhoo/hoosaidthat-orca:0.1.0'),
    controlEndpoint: options.controlEndpoint,
    cdpEndpoint: options.cdpEndpoint,
    controlToken: options.controlToken,
    startupTimeoutMs: options.startupTimeoutMs ?? 60_000,
    actionTimeoutMs: options.actionTimeoutMs ?? (screenReader === 'hoovda' ? 15_000 : 5_000),
    quietMs: options.quietMs ?? 300,
    overlay: options.overlay ?? true,
    recording: options.recording ?? 'on',
    actionScreenshots: options.actionScreenshots ?? 'off',
    keepContainer: options.keepContainer ?? false,
    containerEngineArgs: options.containerEngineArgs ?? [],
    viewport,
  };
  for (const [name, value, maximum] of [
    ['startupTimeoutMs', resolved.startupTimeoutMs, 600_000],
    ['actionTimeoutMs', resolved.actionTimeoutMs, 30_000],
    ['quietMs', resolved.quietMs, 5_000],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0 || value > maximum) {
      throw new Error(`screenReaderOptions.${name} must be an integer between 1 and ${maximum}`);
    }
  }
  if (screenReader === 'hoovda' && resolved.actionTimeoutMs <= 5_000) {
    throw new Error(
      'screenReaderOptions.actionTimeoutMs must exceed HooVDA\'s 5000ms graph refresh deadline',
    );
  }
  if (typeof resolved.image !== 'string' || !resolved.image.trim()) {
    throw new Error('screenReaderOptions.image must be a non-empty string');
  }
  if (typeof resolved.overlay !== 'boolean') {
    throw new Error('screenReaderOptions.overlay must be a boolean');
  }
  if (resolved.recording !== 'off' && resolved.recording !== 'on') {
    throw new Error('screenReaderOptions.recording must be "off" or "on"');
  }
  if (resolved.actionScreenshots !== 'off' && resolved.actionScreenshots !== 'on') {
    throw new Error('screenReaderOptions.actionScreenshots must be "off" or "on"');
  }
  if (typeof resolved.keepContainer !== 'boolean') {
    throw new Error('screenReaderOptions.keepContainer must be a boolean');
  }
  if (
    !Array.isArray(resolved.containerEngineArgs) ||
    resolved.containerEngineArgs.some(
      (argument) => typeof argument !== 'string' || argument.length === 0,
    )
  ) {
    throw new Error('screenReaderOptions.containerEngineArgs must contain only strings');
  }
  if (resolved.runtime === 'external') {
    if (!resolved.controlEndpoint || !resolved.cdpEndpoint || !resolved.controlToken) {
      throw new Error('external runtime requires controlEndpoint, cdpEndpoint, and controlToken');
    }
    validateEndpoint(resolved.controlEndpoint, 'controlEndpoint');
    validateEndpoint(resolved.cdpEndpoint, 'cdpEndpoint');
  }
  return resolved;
}

function validateEndpoint(value: string, name: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`screenReaderOptions.${name} must be an absolute HTTP URL`);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
    throw new Error(`screenReaderOptions.${name} must be an absolute HTTP URL`);
  }
}
