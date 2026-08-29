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
  nextSpellingError: 'Next spelling or grammar error',
  previousSpellingError: 'Previous spelling or grammar error',
  nextNotLinkBlock: 'Next text after block of links',
  previousNotLinkBlock: 'Previous text after block of links',
  nextArticle: 'Next article',
  previousArticle: 'Previous article',
  nextFigure: 'Next figure',
  previousFigure: 'Previous figure',
  nextGrouping: 'Next grouping',
  previousGrouping: 'Previous grouping',
  nextTab: 'Next tab',
  previousTab: 'Previous tab',
  nextMenuItem: 'Next menu item',
  previousMenuItem: 'Previous menu item',
  nextToggleButton: 'Next toggle button',
  previousToggleButton: 'Previous toggle button',
  nextProgressBar: 'Next progress bar',
  previousProgressBar: 'Previous progress bar',
  nextReference: 'Next reference',
  previousReference: 'Previous reference',
  nextMathFormula: 'Next math formula',
  previousMathFormula: 'Previous math formula',
  nextVerticalParagraph: 'Next vertically aligned paragraph',
  previousVerticalParagraph: 'Previous vertically aligned paragraph',
  nextSameStyle: 'Next same style text',
  previousSameStyle: 'Previous same style text',
  nextDifferentStyle: 'Next different style text',
  previousDifferentStyle: 'Previous different style text',
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
  moveToContainerStart: 'Move to start of containing element',
  movePastContainerEnd: 'Move past end of containing element',
  refreshBrowseDocument: 'Refresh browse-mode document',
  exitEmbeddedObject: 'Exit current embedded object',
  toggleNativeSelection: 'Toggle native selection mode',
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
  reportTitle: 'Report window title',
  readActiveWindow: 'Read active window',
  reportShortcutKey: 'Report focused element shortcut key',
  reportCurrentLine: 'Report current line',
  reportTextSelection: 'Report current text selection',
  reportTextFormatting: 'Report text formatting at caret',
  reportLanguage: 'Report language at caret',
  reportLinkDestination: 'Report link destination',
  reportCaretLocation: 'Report caret location',
  sayAllTableColumn: 'Read table column from current cell',
  sayAllTableRow: 'Read table row from current cell',
  readTableColumn: 'Read complete table column',
  readTableRow: 'Read complete table row',
  reportCurrentObject: 'Report current navigator object',
  moveToContainingObject: 'Move to containing object',
  moveToPreviousObject: 'Move to previous sibling object',
  moveToPreviousObjectFlat: 'Move to previous object in flattened view',
  moveToNextObject: 'Move to next sibling object',
  moveToNextObjectFlat: 'Move to next object in flattened view',
  moveToFirstContainedObject: 'Move to first contained object',
  moveToFocusObject: 'Move navigator object to focus',
  activateNavigatorObject: 'Activate navigator object',
  moveFocusToReviewPosition: 'Move focus to review position',
  reportReviewLocation: 'Report review cursor location',
  reviewTopLine: 'Move review cursor to top line',
  reviewPreviousLine: 'Move review cursor to previous line',
  reviewCurrentLine: 'Report current review line',
  reviewNextLine: 'Move review cursor to next line',
  reviewBottomLine: 'Move review cursor to bottom line',
  reviewPreviousWord: 'Move review cursor to previous word',
  reviewCurrentWord: 'Report current review word',
  reviewNextWord: 'Move review cursor to next word',
  reviewLineStart: 'Move review cursor to line start',
  reviewPreviousCharacter: 'Move review cursor to previous character',
  reviewCurrentCharacter: 'Report current review character',
  reviewNextCharacter: 'Move review cursor to next character',
  reviewLineEnd: 'Move review cursor to line end',
  reviewPreviousPage: 'Move review cursor to previous page',
  reviewNextPage: 'Move review cursor to next page',
  reviewSelectionStart: 'Move review cursor to selection start',
  reviewSelectionEnd: 'Move review cursor to selection end',
  sayAllReview: 'Read from review cursor',
  setReviewCopyStart: 'Mark review copy start',
  copyToReviewPosition: 'Select text through review position',
  moveToReviewCopyStart: 'Move review cursor to copy start',
  reportReviewFormatting: 'Report formatting at review cursor',
  nextReviewMode: 'Switch to next review mode',
  previousReviewMode: 'Switch to previous review mode',
  leftMouseClick: 'Click left mouse button',
  leftMouseLock: 'Toggle left mouse button lock',
  rightMouseClick: 'Click right mouse button',
  rightMouseLock: 'Toggle right mouse button lock',
  moveMouseToNavigatorObject: 'Move mouse to navigator object',
  moveNavigatorToMouseObject: 'Move navigator object to mouse object',
  stopSpeech: 'Stop speech',
  pauseSpeech: 'Pause or resume speech',
  cycleSpeechMode: 'Cycle speech mode',
  braillePanBack: 'Pan braille display back',
  braillePanForward: 'Pan braille display forward',
  braillePreviousLine: 'Move braille display to previous line',
  brailleNextLine: 'Move braille display to next line',
  brailleRoute: 'Route braille cell',
  brailleToggleTether: 'Toggle braille tether',
  brailleReportFormatting: 'Report formatting at braille cell',
  toggleFocusMode: 'Toggle browse or focus mode',
  toggleSingleLetterNavigation: 'Toggle single letter navigation',
  elementsList: 'Elements list',
  find: 'Find',
  findNext: 'Find next',
  findPrevious: 'Find previous',
} as const;

export type ScreenReaderAction = keyof typeof SCREEN_READER_ACTIONS;

/**
 * Commands exposed by NVDA without a default keyboard gesture. Adapters invoke
 * NVDA's real browse-mode script and report structured delivery explicitly.
 */
export const STRUCTURED_SCREEN_READER_ACTIONS = new Set<ScreenReaderAction>([
  'nextArticle',
  'previousArticle',
  'nextFigure',
  'previousFigure',
  'nextGrouping',
  'previousGrouping',
  'nextTab',
  'previousTab',
  'nextMenuItem',
  'previousMenuItem',
  'nextToggleButton',
  'previousToggleButton',
  'nextProgressBar',
  'previousProgressBar',
  'nextReference',
  'previousReference',
  'nextMathFormula',
  'previousMathFormula',
  'nextVerticalParagraph',
  'previousVerticalParagraph',
  'nextSameStyle',
  'previousSameStyle',
  'nextDifferentStyle',
  'previousDifferentStyle',
  'reportLanguage',
  'reportCaretLocation',
  'stopSpeech',
  'pauseSpeech',
  'braillePanBack',
  'braillePanForward',
  'braillePreviousLine',
  'brailleNextLine',
  'brailleRoute',
  'brailleReportFormatting',
]);
export type ScreenReaderName = 'orca' | 'hoovda' | 'nvda';
export type ScreenReaderProfile = 'nvda-web-2026.1.1';
export type ScreenReaderLocale = 'en-US' | 'de-DE';
export type KeyboardLayout = 'desktop' | 'laptop';
export type ContainerRuntime = 'auto' | 'docker' | 'podman' | 'external';
export type ActionScreenshotMode = 'off' | 'on';
export type RecordingMode = 'off' | 'on';
export type CaptureBoundary =
  | 'speech-dispatcher-output-module'
  | 'hoovda-structured-presentation'
  | 'nvda-presentation-hooks';

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

export type SpeechSymbolLevel = 'none' | 'some' | 'most' | 'all' | 'character';
export type BrailleTether = 'auto' | 'focus' | 'review';
export type FontAttributeReporting = 'off' | 'speech' | 'braille' | 'speechAndBraille';
export type TableHeaderReporting = 'off' | 'rowsAndColumns' | 'rows' | 'columns';
export type SpellingErrorChannel = 'speech' | 'sound' | 'braille';

/** Web-relevant presentation preferences pinned for one screen-reader session. */
export interface ScreenReaderPresentationSettings {
  speechSymbolLevel: SpeechSymbolLevel;
  brailleTether: BrailleTether;
  reportKeyboardShortcuts: boolean;
  reportObjectPositionInformation: boolean;
  reportObjectDescriptions: boolean;
  reportDynamicContentChanges: boolean;
  reportAriaDescription: boolean;
  reportDetails: boolean;
  reportFontName: boolean;
  reportFontSize: boolean;
  fontAttributeReporting: FontAttributeReporting;
  reportColor: boolean;
  reportStyle: boolean;
  reportSpellingErrors: readonly SpellingErrorChannel[];
  reportTables: boolean;
  includeLayoutTables: boolean;
  reportTableHeaders: TableHeaderReporting;
  reportTableCellCoordinates: boolean;
  reportLinks: boolean;
  reportLinkType: boolean;
  reportGraphics: boolean;
  reportComments: boolean;
  reportBookmarks: boolean;
  reportLists: boolean;
  reportHeadings: boolean;
  reportBlockQuotes: boolean;
  reportGroupings: boolean;
  reportLandmarks: boolean;
  reportArticles: boolean;
  reportFrames: boolean;
  reportFigures: boolean;
  reportClickable: boolean;
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

export type EventProvenance =
  | 'screenReaderOutput'
  | 'screenReaderEvent'
  | 'accessibilityEvent'
  | 'adapterLifecycle'
  | 'synthesizedAudio';

interface EventBase {
  sequence: number;
  monotonicNs: number;
  kind: string;
  command: string;
  text: string;
  reason?: string;
  source?: AccessibleSource;
  provenance?: EventProvenance;
  redacted?: boolean;
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
  kind: 'commandStarted' | 'commandSettled';
}

export interface LiveRegionEvent extends EventBase {
  kind: 'liveRegion';
  priority?: 'polite' | 'assertive';
}

export type ScreenReaderEvent =
  | SpeechEvent
  | BrailleEvent
  | FocusEvent
  | ModeEvent
  | AudioEvent
  | LifecycleEvent
  | LiveRegionEvent;

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
  platform: 'linux' | 'windows';
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
    /** Opaque, session-local identity when the adapter exposes it. */
    id?: string | null;
    /** SHA-256 of the focused accessible document URL, when available. */
    documentUrlSha256?: string;
    browserWindowActive: boolean;
    webContentFocused: boolean;
    role: string | null;
    name: string | null;
  };
  /** Runtime-native diagnostic state when the adapter can expose it safely. */
  browse?: ScreenReaderRuntimeObject | null;
  navigator?: ScreenReaderRuntimeObject | null;
  review?: ScreenReaderRuntimeObject | null;
  mouse?: {
    x: number;
    y: number;
    object: ScreenReaderRuntimeObject | null;
  };
  speech?: {
    mode: string;
    paused: boolean;
  };
}

export interface ScreenReaderRuntimeObject {
  /** Opaque, session-local identity for repeat detection. */
  id?: string;
  /** SHA-256 of a document URL; raw URL remains undisclosed. */
  documentUrlSha256?: string;
  role: string | null;
  name: string | null;
  /** Link visitation state when this object is a link. */
  visited?: boolean;
  /** True when the runtime intentionally withheld protected object text. */
  redacted?: boolean;
  /** Exact HooVDA quick-navigation predicates matched by this object. */
  quickNavigationTargets?: readonly string[];
  location: {
    left: number;
    top: number;
    width: number;
    height: number;
  } | null;
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

export function resolveOptions(options: ScreenReaderOptions = {}): ResolvedScreenReaderOptions {
  const screenReader = options.screenReader ?? 'orca';
  if (screenReader !== 'orca' && screenReader !== 'hoovda' && screenReader !== 'nvda') {
    throw new Error('screenReaderOptions.screenReader must be "orca", "hoovda", or "nvda"');
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
  if (!Number.isInteger(viewport.width) || viewport.width < 320 || viewport.width > 8192) {
    throw new Error('screenReaderOptions.viewport.width must be an integer between 320 and 8192');
  }
  if (!Number.isInteger(viewport.height) || viewport.height < 240 || viewport.height > 8192) {
    throw new Error('screenReaderOptions.viewport.height must be an integer between 240 and 8192');
  }
  const resolved: ResolvedScreenReaderOptions = {
    screenReader,
    profile,
    locale,
    keyboardLayout,
    runtime: options.runtime ?? (screenReader === 'nvda' ? 'external' : 'auto'),
    image:
      options.image ??
      (screenReader === 'hoovda'
        ? (process.env.HOOSAIDTHAT_HOOVDA_IMAGE ?? 'ghcr.io/openhoo/hoosaidthat-hoovda:0.1.0')
        : screenReader === 'nvda'
          ? 'external:nvda-windows'
          : (process.env.HOOSAIDTHAT_ORCA_IMAGE ?? 'ghcr.io/openhoo/hoosaidthat-orca:0.1.0')),
    controlEndpoint:
      options.controlEndpoint ??
      (screenReader === 'nvda' ? process.env.HOOSAIDTHAT_NVDA_CONTROL_ENDPOINT : undefined),
    cdpEndpoint:
      options.cdpEndpoint ??
      (screenReader === 'nvda' ? process.env.HOOSAIDTHAT_NVDA_CDP_ENDPOINT : undefined),
    controlToken:
      options.controlToken ??
      (screenReader === 'nvda' ? process.env.HOOSAIDTHAT_NVDA_CONTROL_TOKEN : undefined),
    startupTimeoutMs: options.startupTimeoutMs ?? 60_000,
    actionTimeoutMs:
      options.actionTimeoutMs ??
      (screenReader === 'hoovda' || screenReader === 'nvda' ? 15_000 : 5_000),
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
      "screenReaderOptions.actionTimeoutMs must exceed HooVDA's 5000ms graph refresh deadline",
    );
  }
  if (screenReader === 'nvda' && resolved.runtime !== 'external') {
    throw new Error('NVDA is a Windows reference oracle and requires runtime "external"');
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
    resolved.containerEngineArgs.length > 100 ||
    resolved.containerEngineArgs.some(
      (argument) =>
        typeof argument !== 'string' ||
        argument.length === 0 ||
        Buffer.byteLength(argument) > 4_096,
    )
  ) {
    throw new Error(
      'screenReaderOptions.containerEngineArgs must contain at most 100 non-empty strings of at most 4096 bytes',
    );
  }
  if (screenReader === 'nvda' && resolved.containerEngineArgs.length > 0) {
    throw new Error('screenReaderOptions.containerEngineArgs are not supported by external NVDA');
  }
  if (resolved.runtime === 'external') {
    if (!resolved.controlEndpoint || !resolved.cdpEndpoint || !resolved.controlToken) {
      throw new Error('external runtime requires controlEndpoint, cdpEndpoint, and controlToken');
    }
    if (
      Buffer.byteLength(resolved.controlToken) > 4_096 ||
      /[\u0000-\u001f\u007f]/u.test(resolved.controlToken)
    ) {
      throw new Error(
        'screenReaderOptions.controlToken must contain 1 to 4096 bytes without control characters',
      );
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
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !url.hostname ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(`screenReaderOptions.${name} must be an absolute HTTP URL`);
  }
  if (
    url.protocol === 'http:' &&
    url.hostname !== '127.0.0.1' &&
    url.hostname !== 'localhost' &&
    url.hostname !== '[::1]'
  ) {
    throw new Error(`screenReaderOptions.${name} must use HTTPS unless it targets host loopback`);
  }
}
