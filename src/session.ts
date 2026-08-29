import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { test as playwrightTest, type Locator, type Page, type TestInfo } from '@playwright/test';
import { HttpScreenReaderClient } from './client.js';
import { ensureOverlay, installOverlay, removeOverlay, updateOverlay } from './overlay.js';
import {
  SCREEN_READER_ACTIONS,
  type ElementCapture,
  type ResolvedScreenReaderOptions,
  type ScanOptions,
  type ScanResult,
  type ScreenReaderAction,
  type ScreenReaderCapabilities,
  type ScreenReaderEvent,
  type ScreenReaderHealth,
  type ScreenReaderObservation,
  type ScreenReaderPresentationSettings,
  type ScreenReaderState,
  type SpeechEvent,
  type BrailleEvent,
} from './types.js';

interface FlowEntry {
  index: number;
  observation: ScreenReaderObservation;
}

export class ScreenReaderSession {
  readonly page: Page;
  readonly health: ScreenReaderHealth;

  private readonly client: HttpScreenReaderClient;
  private readonly options: ResolvedScreenReaderOptions;
  private readonly testInfo: TestInfo;
  private readonly entries: FlowEntry[] = [];
  private readonly supportedActions: ReadonlySet<ScreenReaderAction>;
  private screenshotIndex = 0;
  private pageAriaSnapshotCaptured = false;
  private verifiedPageDocumentFocusId: string | null = null;

  private constructor(
    page: Page,
    client: HttpScreenReaderClient,
    options: ResolvedScreenReaderOptions,
    testInfo: TestInfo,
    health: ScreenReaderHealth,
    supportedActions: ReadonlySet<ScreenReaderAction>,
  ) {
    this.page = page;
    this.client = client;
    this.options = options;
    this.testInfo = testInfo;
    this.health = health;
    this.supportedActions = supportedActions;
  }

  static async create(
    page: Page,
    client: HttpScreenReaderClient,
    options: ResolvedScreenReaderOptions,
    testInfo: TestInfo,
  ): Promise<ScreenReaderSession> {
    for (const sibling of page.context().pages()) {
      if (sibling !== page && sibling.url().startsWith('file:///opt/hoosaidthat/bootstrap.html')) {
        await sibling.close();
      }
    }
    let sessionStarted = false;
    try {
      if (options.screenReader === 'nvda') {
        await assertNativeViewport(page);
      }
      if (options.screenReader === 'nvda') {
        await client.beginSession(testInfo.testId, options.recording === 'on');
        sessionStarted = true;
      }
      const [health, capabilities]: [ScreenReaderHealth, ScreenReaderCapabilities] =
        await Promise.all([client.health(), client.capabilities()]);
      if (health.screenReader.name.toLowerCase() !== options.screenReader) {
        throw new Error(
          `runtime screen reader mismatch: requested ${options.screenReader}, got ${health.screenReader.name}`,
        );
      }
      if (health.profile && health.profile !== options.profile) {
        throw new Error(
          `runtime profile mismatch: requested ${options.profile}, got ${health.profile}`,
        );
      }
      if (health.locale && health.locale !== options.locale) {
        throw new Error(
          `runtime locale mismatch: requested ${options.locale}, got ${health.locale}`,
        );
      }
      if (health.keyboardLayout && health.keyboardLayout !== options.keyboardLayout) {
        throw new Error(
          `runtime keyboard layout mismatch: requested ${options.keyboardLayout}, got ${health.keyboardLayout}`,
        );
      }
      if (!sessionStarted) {
        await client.beginSession(testInfo.testId, options.recording === 'on');
        sessionStarted = true;
      }
      const supportedActions = new Set(capabilities.actions.map((capability) => capability.action));
      const session = new ScreenReaderSession(
        page,
        client,
        options,
        testInfo,
        health,
        supportedActions,
      );
      if (options.overlay) {
        await installOverlay(page);
        await updateOverlay(
          page,
          'Screen reader ready',
          `${health.screenReader.name} ${health.screenReader.version}`,
        );
      }
      await attachEvidenceFile(
        testInfo,
        'screen-reader-runtime.json',
        `${JSON.stringify(health, null, 2)}\n`,
        'application/json',
      );
      return session;
    } catch (error) {
      if (sessionStarted) await client.finishSession().catch(() => undefined);
      throw error;
    }
  }

  async act(action: ScreenReaderAction): Promise<ScreenReaderObservation> {
    const label = SCREEN_READER_ACTIONS[action];
    if (!this.supportedActions.has(action)) {
      throw new Error(
        `${this.health.screenReader.name} runtime does not support screen-reader action ${action}`,
      );
    }
    return await playwrightTest.step(`Screen reader: ${label}`, async () => {
      await this.show(label, 'Listening...');
      const response = await this.client.perform(action);
      const observation = response.events
        ? this.observation(
            response.events,
            response.timedOut ?? false,
            action,
            label,
          )
        : await this.collect(response.afterSequence, action, label);
      await this.afterObservation(observation);
      return observation;
    });
  }

  async focus(locator: Locator, label = 'Focus element'): Promise<ScreenReaderObservation> {
    await locator.scrollIntoViewIfNeeded();
    if (!(await locator.isVisible())) {
      throw new Error(`${label} target is not visible`);
    }
    const keyboardFocusable = await locator.evaluate((element) => {
      if (!(element instanceof HTMLElement)) return false;
      if ('disabled' in element && element.disabled === true) return false;
      return element.tabIndex >= 0;
    });
    if (!keyboardFocusable) {
      throw new Error(
        `${label} target is not keyboard-focusable; use structural navigation for non-focusable elements`,
      );
    }
    await this.returnToPage();
    if (await locator.evaluate(isDeepActiveElement)) {
      const observation = await this.act('readCurrent');
      return await this.relabelLastObservation(observation, 'focus', label);
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const observation = await this.act('nextFocusable');
      if (await locator.evaluate(isDeepActiveElement)) {
        return await this.relabelLastObservation(observation, 'focus', label);
      }
    }
    throw new Error(`${label} target was not reached after 100 screen-reader Tab gestures`);
  }

  async observe<T>(
    label: string,
    operation: () => Promise<T>,
    action: 'focus' | 'observe' = 'observe',
  ): Promise<ScreenReaderObservation> {
    return await playwrightTest.step(`Screen reader: ${label}`, async () => {
      // Playwright can mutate the foreground CDP Page while native browser
      // focus remains in browser chrome. Re-enter and verify web content
      // immediately before the operation so DOM focus and accessibility
      // events cannot diverge.
      await this.returnToPage();
      await this.show(label, 'Listening...');
      const afterSequence = await this.quietCursor();
      await operation();
      const observation = await this.collect(afterSequence, action, label);
      await this.afterObservation(observation);
      return observation;
    });
  }

  async checkpoint(): Promise<number> {
    return await this.client.cursor();
  }

  async state(): Promise<ScreenReaderState> {
    return await this.client.state();
  }

  async presentationSettings(): Promise<ScreenReaderPresentationSettings> {
    return await this.client.presentationSettings();
  }

  async setPresentationSettings(
    settings: ScreenReaderPresentationSettings,
  ): Promise<ScreenReaderPresentationSettings> {
    return await this.client.setPresentationSettings(settings);
  }

  async resetPresentationSettings(): Promise<ScreenReaderPresentationSettings> {
    return await this.client.resetPresentationSettings();
  }

  async readFrom(
    afterSequence: number,
    label = 'Observe screen-reader output',
  ): Promise<ScreenReaderObservation> {
    const observation = await this.collect(afterSequence, 'observe', label);
    await this.afterObservation(observation);
    return observation;
  }

  lastObservation(): ScreenReaderObservation | undefined {
    return this.entries.at(-1)?.observation;
  }

  spokenText(): string {
    return this.lastObservation()?.speech ?? '';
  }

  brailleText(): string {
    return this.lastObservation()?.braille ?? '';
  }

  transcript(): string {
    return this.renderTranscript(this.entries);
  }

  regressionTranscript(): string {
    const entries = this.entries
      .filter(({ observation }) => observation.action !== 'returnToPage')
      .map(({ observation }, index) => {
        let speechEvents = observation.speechEvents;
        let brailleEvents = observation.brailleEvents;
        if (
          observation.action === 'focus' ||
          observation.action === 'nextFocusable' ||
          observation.action === 'previousFocusable'
        ) {
          const focusSpeech = speechEvents.filter(({ command }) => command === 'focus');
          const focusBraille = brailleEvents.filter(({ command }) => command === 'focus');
          speechEvents = (focusSpeech.length > 0 ? focusSpeech : speechEvents).slice(-1);
          brailleEvents = (focusBraille.length > 0 ? focusBraille : brailleEvents).slice(-1);
        } else if (observation.action !== 'observe') {
          const commands = new Set<string>([observation.action]);
          if (observation.action === 'activate' || observation.action === 'activateWithSpace') {
            commands.add('event');
          }
          speechEvents = speechEvents.filter(({ command }) => commands.has(command));
          brailleEvents = brailleEvents.filter(({ command }) => commands.has(command));
        }
        return {
          index: index + 1,
          observation: { ...observation, speechEvents, brailleEvents },
        };
      });
    return this.renderTranscript(entries);
  }

  private renderTranscript(entries: readonly FlowEntry[]): string {
    if (entries.length === 0) return '# Screen reader flow\n\n(no observations)\n';
    const lines = ['# Screen reader flow', ''];
    for (const entry of entries) {
      const number = String(entry.index).padStart(2, '0');
      const observation = entry.observation;
      lines.push(
        `${number}. ACTION ${observation.label} [${observation.action}]`,
        ...(observation.speechEvents.length > 0
          ? observation.speechEvents.map((event) => `    SPEECH[${event.command}] ${event.text}`)
          : ['    SPEECH (none)']),
        ...(observation.brailleEvents.length > 0
          ? observation.brailleEvents.map((event) => `    BRAILLE[${event.command}] ${event.text}`)
          : ['    BRAILLE (none)']),
        `    STATUS ${observation.timedOut ? 'timed-out' : 'settled'}`,
      );
    }
    return `${lines.join('\n')}\n`;
  }

  async captureCurrent(name: string, locator?: Locator): Promise<string> {
    return await this.captureScreenshot(name, locator);
  }

  async captureAriaSnapshot(
    name = 'page',
    locator: Locator = this.page.locator('body'),
  ): Promise<string> {
    if (this.page.isClosed()) throw new Error('cannot capture ARIA snapshot from a closed page');
    const rawYaml = await locator.ariaSnapshot({
      timeout: this.options.actionTimeoutMs,
    });
    const yaml = await redactProtectedAriaValues(this.page, rawYaml, this.options.actionTimeoutMs);
    const filename = `screen-reader-${slug(name)}.aria.yml`;
    await attachEvidenceFile(this.testInfo, filename, `${yaml.trimEnd()}\n`, 'application/yaml');
    if (name === 'page') this.pageAriaSnapshotCaptured = true;
    return yaml;
  }

  async captureElement(name: string, locator: Locator): Promise<ScreenReaderObservation> {
    const observation = await this.focus(locator, `Focus ${name}`);
    await this.captureScreenshot(name, locator);
    return observation;
  }

  async captureElements(
    captures: readonly ElementCapture[],
  ): Promise<readonly ScreenReaderObservation[]> {
    if (captures.length < 1 || captures.length > 500) {
      throw new Error('captureElements requires between 1 and 500 elements');
    }
    const names = captures.map(({ name }) => name.trim());
    if (
      names.some((name) => name.length === 0 || Buffer.byteLength(name) > 200) ||
      new Set(names).size !== names.length
    ) {
      throw new Error('captureElements names must be unique and contain 1 to 200 bytes');
    }
    const observations: ScreenReaderObservation[] = [];
    const manifest: Array<{
      name: string;
      screenshot: string;
      speech: string;
      braille: string;
      timedOut: boolean;
      provenance: string[];
    }> = [];
    for (const capture of captures) {
      const observation = await this.focus(capture.locator, `Focus ${capture.name}`);
      const screenshot = await this.captureScreenshot(capture.name, capture.locator);
      observations.push(observation);
      manifest.push({
        name: capture.name,
        screenshot: basename(screenshot),
        speech: observation.speech,
        braille: observation.braille,
        timedOut: observation.timedOut,
        provenance: [
          ...new Set(observation.events.flatMap((event) => event.provenance ?? [])),
        ].sort(),
      });
    }
    await attachEvidenceFile(
      this.testInfo,
      'screen-reader-element-captures.json',
      `${JSON.stringify(manifest, null, 2)}\n`,
      'application/json',
    );
    return observations;
  }

  async scan(options: ScanOptions): Promise<ScanResult> {
    const max = options.max ?? 25;
    if (!Number.isInteger(max) || max < 1 || max > 500) {
      throw new Error('scan max must be an integer between 1 and 500');
    }
    const seen = new Set<string>();
    const observations: ScreenReaderObservation[] = [];
    const screenshots: string[] = [];
    let stoppedOnRepeat = false;
    let stoppedOnBoundary = false;
    for (let index = 0; index < max; index += 1) {
      const observation = await this.act(options.action);
      if (isNavigationBoundary(observation)) {
        stoppedOnBoundary = true;
        break;
      }
      const source = observation.speechEvents.find((event) => event.source)?.source;
      const navigator = source ? undefined : (await this.state()).navigator;
      const key = source
        ? `${source.bus}:${source.path}`
        : [navigator?.id, observation.speech.trim(), observation.braille.trim()]
            .filter(Boolean)
            .join('\u001f');
      if (options.stopOnRepeat !== false && key && seen.has(key)) {
        stoppedOnRepeat = true;
        break;
      }
      if (key) seen.add(key);
      observations.push(observation);
      if (options.screenshots) {
        screenshots.push(await this.captureScreenshot(`${options.name}-${index + 1}`));
      }
    }
    return {
      observations,
      screenshots,
      stoppedOnRepeat,
      stoppedOnBoundary,
      stopReason: stoppedOnBoundary ? 'boundary' : stoppedOnRepeat ? 'repeat' : 'max',
    };
  }

  async capturePageElements(
    options: {
      maxPerKind?: number;
      screenshots?: boolean;
    } = {},
  ): Promise<Readonly<Record<string, ScanResult>>> {
    const max = options.maxPerKind ?? 100;
    if (!Number.isInteger(max) || max < 1 || max > 500) {
      throw new Error('capturePageElements maxPerKind must be an integer between 1 and 500');
    }
    const groups = [
      ['headings', 'nextHeading', 'previousHeading', 'heading'],
      ['landmarks', 'nextLandmark', 'previousLandmark', 'landmark'],
      ['articles', 'nextArticle', 'previousArticle', 'article'],
      ['figures', 'nextFigure', 'previousFigure', 'figure'],
      ['groupings', 'nextGrouping', 'previousGrouping', 'grouping'],
      ['tabs', 'nextTab', 'previousTab', 'tab'],
      ['menu-items', 'nextMenuItem', 'previousMenuItem', 'menuItem'],
      ['toggle-buttons', 'nextToggleButton', 'previousToggleButton', 'toggleButton'],
      ['progress-bars', 'nextProgressBar', 'previousProgressBar', 'progressBar'],
      ['references', 'nextReference', 'previousReference', 'reference'],
      ['math', 'nextMathFormula', 'previousMathFormula', 'math'],
      ['vertical-paragraphs', 'nextVerticalParagraph', 'previousVerticalParagraph', undefined],
      ['same-style-text', 'nextSameStyle', 'previousSameStyle', undefined],
      ['different-style-text', 'nextDifferentStyle', 'previousDifferentStyle', undefined],
      ['buttons', 'nextButton', 'previousButton', 'button'],
      ['form-fields', 'nextFormField', 'previousFormField', 'formField'],
      ['links', 'nextLink', 'previousLink', 'link'],
      ['visited-links', 'nextVisitedLink', 'previousVisitedLink', 'visitedLink'],
      ['unvisited-links', 'nextUnvisitedLink', 'previousUnvisitedLink', 'unvisitedLink'],
      ['lists', 'nextList', 'previousList', 'list'],
      ['list-items', 'nextListItem', 'previousListItem', 'listItem'],
      ['tables', 'nextTable', 'previousTable', 'table'],
      ['graphics', 'nextImage', 'previousImage', 'graphic'],
      ['checkboxes', 'nextCheckbox', 'previousCheckbox', 'checkBox'],
      ['radio-buttons', 'nextRadioButton', 'previousRadioButton', 'radioButton'],
      ['combo-boxes', 'nextCombobox', 'previousCombobox', 'comboBox'],
      ['edit-fields', 'nextEntry', 'previousEntry', 'edit'],
      ['text-paragraphs', 'nextParagraph', 'previousParagraph', 'textParagraph'],
      ['frames', 'nextFrame', 'previousFrame', 'frame'],
      ['separators', 'nextSeparator', 'previousSeparator', 'separator'],
      ['block-quotes', 'nextBlockQuote', 'previousBlockQuote', 'blockQuote'],
      ['embedded-objects', 'nextEmbeddedObject', 'previousEmbeddedObject', 'embeddedObject'],
      ['annotations', 'nextAnnotation', 'previousAnnotation', 'annotation'],
      ['spelling-errors', 'nextSpellingError', 'previousSpellingError', 'error'],
      ['non-link-text', 'nextNotLinkBlock', 'previousNotLinkBlock', 'notLinkBlock'],
    ] as const;
    const results: Record<string, ScanResult> = {};
    const screenshotsEnabled = options.screenshots ?? true;
    for (const [name, nextAction, previousAction, target] of groups) {
      const start = await this.act('documentStart');
      const browse = (await this.state()).browse;
      const includeStart =
        target !== undefined && browse?.quickNavigationTargets?.includes(target) === true;
      const startScreenshots =
        includeStart && screenshotsEnabled
          ? [await this.captureScreenshot(`${name}-1`)]
          : [];
      if (includeStart && max === 1) {
        results[name] = {
          observations: [start],
          screenshots: startScreenshots,
          stoppedOnRepeat: false,
          stoppedOnBoundary: false,
          stopReason: 'max',
        };
        continue;
      }

      const before = await this.scan({
        action: previousAction,
        name: `${name}-before-start`,
        max: max - (includeStart ? 1 : 0),
        screenshots: screenshotsEnabled,
        stopOnRepeat: true,
      });
      const beforeObservations = [...before.observations].reverse();
      const beforeScreenshots = [...before.screenshots].reverse();
      const observations = [
        ...beforeObservations,
        ...(includeStart ? [start] : []),
      ];
      const screenshots = [
        ...beforeScreenshots,
        ...startScreenshots,
      ];
      const remaining = max - observations.length;

      let after: ScanResult | undefined;
      if (remaining > 0 && before.stopReason !== 'max') {
        // A failed reverse quick-navigation command may still change native
        // screen-reader browse state. Re-establish the origin unconditionally.
        await this.act('documentStart');
        after = await this.scan({
          action: nextAction,
          name: `${name}-after-start`,
          max: remaining,
          screenshots: screenshotsEnabled,
          stopOnRepeat: true,
        });
        observations.push(...after.observations);
        screenshots.push(...after.screenshots);
      }

      const stoppedOnRepeat = before.stoppedOnRepeat || (after?.stoppedOnRepeat ?? false);
      const stoppedOnBoundary =
        before.stoppedOnBoundary && (after?.stoppedOnBoundary ?? false);
      results[name] = {
        observations,
        screenshots,
        stoppedOnRepeat,
        stoppedOnBoundary,
        stopReason: stoppedOnBoundary ? 'boundary' : stoppedOnRepeat ? 'repeat' : 'max',
      };
    }
    const manifest = Object.fromEntries(
      Object.entries(results).map(([name, result]) => [
        name,
        {
          stopReason: result.stopReason,
          items: result.observations.map((observation, index) => ({
            index: index + 1,
            screenshot: result.screenshots[index]
              ? basename(result.screenshots[index]!)
              : undefined,
            speech: observation.speech,
            braille: observation.braille,
            provenance: [
              ...new Set(observation.events.flatMap((event) => event.provenance ?? [])),
            ].sort(),
          })),
        },
      ]),
    );
    await attachEvidenceFile(
      this.testInfo,
      'screen-reader-page-elements.json',
      `${JSON.stringify(manifest, null, 2)}\n`,
      'application/json',
    );
    return results;
  }

  async nextHeading(): Promise<ScreenReaderObservation> {
    return await this.act('nextHeading');
  }

  async documentStart(): Promise<ScreenReaderObservation> {
    return await this.act('documentStart');
  }

  async documentEnd(): Promise<ScreenReaderObservation> {
    return await this.act('documentEnd');
  }

  async previousHeading(): Promise<ScreenReaderObservation> {
    return await this.act('previousHeading');
  }

  async nextLandmark(): Promise<ScreenReaderObservation> {
    return await this.act('nextLandmark');
  }

  async nextFocusable(): Promise<ScreenReaderObservation> {
    return await this.act('nextFocusable');
  }

  async activate(): Promise<ScreenReaderObservation> {
    return await this.act('activate');
  }

  async reportDetails(): Promise<ScreenReaderObservation> {
    return await this.act('reportDetails');
  }

  async elementsList(): Promise<ScreenReaderObservation> {
    return await this.act('elementsList');
  }

  async brailleRoute(cell = 0): Promise<ScreenReaderObservation> {
    return await this.brailleCellAction('brailleRoute', cell);
  }

  async brailleFormatting(cell = 0): Promise<ScreenReaderObservation> {
    return await this.brailleCellAction('brailleReportFormatting', cell);
  }

  private async brailleCellAction(
    action: 'brailleRoute' | 'brailleReportFormatting',
    cell: number,
  ): Promise<ScreenReaderObservation> {
    if (!Number.isInteger(cell) || cell < 0 || cell > 199) {
      throw new Error('braille cell must be an integer from 0 to 199');
    }
    if (this.health.protocolVersion !== 2) {
      throw new Error('braille cell routing requires a protocol v2 adapter');
    }
    if (!this.supportedActions.has(action)) {
      throw new Error(
        `${this.health.screenReader.name} runtime does not support screen-reader action ${action}`,
      );
    }
    const label = `${SCREEN_READER_ACTIONS[action]} ${cell}`;
    return await playwrightTest.step(`Screen reader: ${label}`, async () => {
      await this.show(label, 'Listening...');
      const response = await this.client.perform(action, String(cell));
      if (response.delivery !== 'structured') {
        throw new Error(
          `${this.health.screenReader.name} ${action} response did not confirm structured delivery`,
        );
      }
      const observation = this.observation(
        response.events ?? [],
        response.timedOut ?? false,
        action,
        label,
      );
      await this.afterObservation(observation);
      return observation;
    });
  }

  async findText(query: string): Promise<ScreenReaderObservation> {
    const normalized = query.trim();
    if (normalized.length === 0 || Buffer.byteLength(normalized) > 500) {
      throw new Error('findText query must contain 1 to 500 bytes');
    }
    if (this.health.protocolVersion !== 2) {
      throw new Error('findText structured query input requires a protocol v2 adapter');
    }
    if (!this.supportedActions.has('find')) {
      throw new Error(
        `${this.health.screenReader.name} runtime does not support screen-reader action find`,
      );
    }
    const label = `Find: ${normalized}`;
    return await playwrightTest.step(`Screen reader: ${label}`, async () => {
      await this.show(label, 'Listening...');
      const response = await this.client.perform('find', normalized);
      if (response.delivery !== 'structured') {
        throw new Error(
          `${this.health.screenReader.name} find response did not confirm structured query delivery`,
        );
      }
      const observation = this.observation(
        response.events ?? [],
        response.timedOut ?? false,
        'find',
        label,
      );
      await this.afterObservation(observation);
      return observation;
    });
  }

  async returnToPage(maxGestures = 6): Promise<void> {
    if (!Number.isInteger(maxGestures) || maxGestures < 1 || maxGestures > 20) {
      throw new Error('returnToPage maxGestures must be an integer between 1 and 20');
    }
    // HooVDA can retain the previous tab's native focus while Playwright brings
    // another CDP Page forward. Conversely, sending F6 while this Page already
    // owns native focus moves focus into browser chrome. Chromium reports
    // document.hasFocus() even while its address bar and tab strip are focused,
    // so use native runtime focus and reject a stale document from another Page
    // by comparing its accessible name with this Page's non-empty title.
    await this.page.bringToFront();
    await this.page.waitForTimeout(this.options.quietMs);
    const pageContextReady = async (): Promise<boolean> => {
      const state = await this.client.state();
      if (!state.focus.webContentFocused) return false;
      if (state.focus.role !== 'document web' && state.focus.role !== 'document frame') return true;
      if (state.focus.documentUrlSha256 !== undefined) {
        const pageURLSHA256 = createHash('sha256').update(this.page.url()).digest('hex');
        if (state.focus.documentUrlSha256 !== pageURLSHA256) return false;
        this.verifiedPageDocumentFocusId = state.focus.id ?? null;
        return true;
      }
      const title = (await this.page.title()).trim();
      if (title.length === 0) return true;
      if (state.focus.name === title) {
        this.verifiedPageDocumentFocusId = state.focus.id ?? null;
        return true;
      }
      return (
        state.focus.name === null &&
        state.focus.id !== undefined &&
        state.focus.id !== null &&
        state.focus.id === this.verifiedPageDocumentFocusId
      );
    };
    if (await pageContextReady()) return;
    for (let attempt = 0; attempt < maxGestures; attempt += 1) {
      await this.act('returnToPage');
      if (await pageContextReady()) return;
    }
    throw new Error(
      `web-content focus was not verified after ${maxGestures} screen-reader F6 gestures`,
    );
  }

  async ensureBrowseMode(): Promise<void> {
    await this.ensureCursorMode('browse');
  }

  async ensureFocusMode(): Promise<void> {
    await this.ensureCursorMode('focus');
  }

  private async ensureCursorMode(expected: 'browse' | 'focus'): Promise<void> {
    const before = await this.client.state();
    if (before.cursorMode === expected) return;
    if (before.cursorMode !== 'browse' && before.cursorMode !== 'focus') {
      throw new Error(`screen-reader cursor mode is unavailable; expected ${expected}`);
    }
    await this.act('toggleFocusMode');
    const after = await this.client.state();
    if (after.cursorMode !== expected) {
      throw new Error(
        `screen-reader cursor mode did not become ${expected}; got ${after.cursorMode ?? 'unknown'}`,
      );
    }
  }

  async finish(): Promise<void> {
    let evidenceError: unknown;
    try {
      if (!this.pageAriaSnapshotCaptured && !this.page.isClosed()) {
        await this.captureAriaSnapshot();
      }
      await attachEvidenceFile(
        this.testInfo,
        'screen-reader-flow.txt',
        this.transcript(),
        'text/plain',
      );
      await attachEvidenceFile(
        this.testInfo,
        'screen-reader-flow.json',
        `${JSON.stringify(
          {
            protocolVersion: this.health.protocolVersion,
            screenReader: this.health.screenReader,
            observations: this.entries.map((entry) => entry.observation),
          },
          null,
          2,
        )}\n`,
        'application/json',
      );
    } catch (error) {
      evidenceError = error;
    }
    const artifacts = await this.client.finishSession();
    for (const artifact of artifacts) {
      await attachBinaryEvidenceFile(this.testInfo, artifact);
    }
    if (evidenceError) throw evidenceError;
  }

  private async collect(
    afterSequence: number,
    action: ScreenReaderObservation['action'],
    label: string,
  ): Promise<ScreenReaderObservation> {
    const response = await this.client.readEvents(afterSequence, {
      timeoutMs: this.options.actionTimeoutMs,
      quietMs: this.options.quietMs,
    });
    return this.observation(
      response.events,
      response.timedOut,
      action,
      label,
    );
  }

  private async quietCursor(): Promise<number> {
    const deadline = Date.now() + this.options.actionTimeoutMs;
    let cursor = await this.client.cursor();
    let quietWindows = 0;
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(this.options.quietMs);
      const next = await this.client.cursor();
      if (next === cursor) {
        quietWindows += 1;
      } else {
        cursor = next;
        quietWindows = 0;
      }
      // One fixed delay can end immediately before Chromium publishes a
      // page-load focus or live-region registration event. Two unchanged
      // cursor windows establish that accessibility output has actually
      // settled before the observed DOM operation begins.
      if (quietWindows === 2) return cursor;
    }
    throw new Error('screen-reader output did not settle before observed operation');
  }

  private observation(
    events: readonly ScreenReaderEvent[],
    timedOut: boolean,
    action: ScreenReaderObservation['action'],
    label: string,
  ): ScreenReaderObservation {
    const speechEvents = events.filter((event): event is SpeechEvent => event.kind === 'speech');
    const brailleEvents = events.filter((event): event is BrailleEvent => event.kind === 'braille');
    return {
      action,
      label,
      events,
      speechEvents,
      brailleEvents,
      speech: speechEvents
        .map((event) => event.text)
        .join(' ')
        .trim(),
      braille: brailleEvents
        .map((event) => event.text)
        .join(' ')
        .trim(),
      timedOut,
    };
  }

  private async afterObservation(observation: ScreenReaderObservation): Promise<void> {
    this.entries.push({ index: this.entries.length + 1, observation });
    await this.show(observation.label, formatOverlayOutput(observation));
    if (this.options.actionScreenshots === 'on') {
      await this.captureScreenshot(`${this.entries.length}-${observation.action}`);
    }
  }

  private async show(action: string, speech: string): Promise<void> {
    if (!this.options.overlay || this.page.isClosed()) return;
    try {
      await updateOverlay(this.page, action, speech);
    } catch (error) {
      if (this.page.isClosed()) return;
      await this.page
        .waitForLoadState('domcontentloaded', { timeout: 1_000 })
        .catch(() => undefined);
      if (this.page.isClosed()) return;
      try {
        await installOverlay(this.page);
        await updateOverlay(this.page, action, speech);
      } catch {
        throw error;
      }
    }
  }

  private async captureScreenshot(name: string, locator?: Locator): Promise<string> {
    this.screenshotIndex += 1;
    const filename = `${String(this.screenshotIndex).padStart(3, '0')}-${slug(name)}.png`;
    const path = this.testInfo.outputPath('screenreader', filename);
    await mkdir(dirname(path), { recursive: true });
    let temporaryOverlay = false;
    if (!this.options.overlay) {
      const observation = this.lastObservation();
      await ensureOverlay(this.page);
      await updateOverlay(
        this.page,
        observation?.label ?? 'Screen-reader capture',
        observation ? formatOverlayOutput(observation) : '(no captured output)',
      );
      temporaryOverlay = true;
    }
    let restore: (() => Promise<void>) | undefined;
    if (locator) {
      const state = await locator.evaluate((element) => {
        if (!(element instanceof HTMLElement)) return undefined;
        const original = {
          outline: element.style.outline,
          outlineOffset: element.style.outlineOffset,
        };
        element.style.setProperty('outline', '4px solid #ffb86c', 'important');
        element.style.setProperty('outline-offset', '4px', 'important');
        return original;
      });
      if (state) {
        restore = async () => {
          await locator.evaluate((element, original) => {
            if (!(element instanceof HTMLElement)) return;
            element.style.outline = original.outline;
            element.style.outlineOffset = original.outlineOffset;
          }, state);
        };
      }
    }
    try {
      await this.page.screenshot({ path, animations: 'disabled' });
    } finally {
      await restore?.().catch(() => undefined);
      if (temporaryOverlay && !this.page.isClosed()) {
        await removeOverlay(this.page).catch(() => undefined);
      }
    }
    await this.testInfo.attach(`screen-reader-${slug(name)}`, {
      path,
      contentType: 'image/png',
    });
    return path;
  }

  private async relabelLastObservation(
    observation: ScreenReaderObservation,
    action: 'focus' | 'observe',
    label: string,
  ): Promise<ScreenReaderObservation> {
    const relabeled = { ...observation, action, label };
    const last = this.entries.at(-1);
    if (last) last.observation = relabeled;
    await this.show(label, formatOverlayOutput(relabeled));
    return relabeled;
  }
}

function isDeepActiveElement(element: Element): boolean {
  let active: Element | null = document.activeElement;
  while (active instanceof HTMLElement && active.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active === element;
}

async function assertNativeViewport(page: Page): Promise<void> {
  const geometry = await page.evaluate(() => ({
    innerWidth,
    innerHeight,
    outerWidth,
    outerHeight,
  }));
  if (
    geometry.outerWidth <= 0 ||
    geometry.outerHeight <= 0 ||
    geometry.innerWidth > geometry.outerWidth ||
    geometry.innerHeight >= geometry.outerHeight
  ) {
    throw new Error(
      `NVDA requires Playwright's native browser viewport; use defineConfig from @openhoo/hoosaidthat or set use.viewport=null (${JSON.stringify(geometry)})`,
    );
  }
}

async function redactProtectedAriaValues(
  page: Page,
  yaml: string,
  timeout: number,
): Promise<string> {
  let redacted = yaml;
  const protectedControls = page.locator(
    'input[type="password"], input[autocomplete="current-password" i], input[autocomplete="new-password" i]',
  );
  const count = await protectedControls.count();
  for (let index = 0; index < count; index += 1) {
    const control = protectedControls.nth(index);
    const [protectedSnapshot, protectedValue] = await Promise.all([
      control.ariaSnapshot({ timeout }).then((value) => value.trim()),
      control.inputValue({ timeout }),
    ]);
    // Locator snapshots can differ from their page-level representation. Remove
    // the complete protected subtree first, then scrub the literal value as a
    // fail-closed fallback. Never put protected content in an error message.
    if (protectedSnapshot) {
      redacted = redacted.replaceAll(protectedSnapshot, '- textbox: [redacted]');
    }
    if (protectedValue) {
      redacted = redacted.replaceAll(protectedValue, '[redacted]');
      if (redacted.includes(protectedValue)) {
        throw new Error('failed to redact a protected control from the ARIA snapshot');
      }
    }
  }
  return redacted;
}

function slug(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return normalized.slice(0, 80) || 'capture';
}

function formatOverlayOutput(observation: ScreenReaderObservation): string {
  const speech =
    observation.speech || (observation.timedOut ? '(no speech before timeout)' : '(no speech)');
  return observation.braille ? `${speech}\nBraille: ${observation.braille}` : speech;
}

function isNavigationBoundary(observation: ScreenReaderObservation): boolean {
  if (
    observation.events.some(
      (event) => event.reason === 'navigationBoundary' || event.reason === 'tableBoundary',
    )
  ) {
    return true;
  }
  return /(?:^|\b)(?:no (?:next|previous|more)|not supported in this document|keine? (?:weitere|vorherige|unterstützung)|kein (?:weiterer|vorheriger)|nicht unterstützt)(?:\b|$)/iu.test(
    `${observation.speech}\n${observation.braille}`,
  );
}

async function attachEvidenceFile(
  testInfo: TestInfo,
  filename: string,
  body: string,
  contentType: string,
): Promise<void> {
  const path = testInfo.outputPath('screenreader', filename);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, { encoding: 'utf8', mode: 0o600 });
  await testInfo.attach(filename, { path, contentType });
}

async function attachBinaryEvidenceFile(
  testInfo: TestInfo,
  artifact: { name: string; contentType: string; body: Uint8Array },
): Promise<void> {
  const extensions: Readonly<Record<string, string>> = {
    'application/json': 'json',
    'audio/wav': 'wav',
    'video/webm': 'webm',
  };
  const extension = extensions[artifact.contentType];
  if (!extension || !/^screenreader-(events|document|audio|video)$/.test(artifact.name)) {
    throw new Error(`unsupported screen-reader artifact ${artifact.name}`);
  }
  const path = testInfo.outputPath('screenreader', `${artifact.name}.${extension}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, artifact.body, { mode: 0o600 });
  await testInfo.attach(artifact.name, {
    path,
    contentType: artifact.contentType,
  });
}
