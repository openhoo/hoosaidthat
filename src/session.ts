import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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
  type ScreenReaderEvent,
  type ScreenReaderHealth,
  type ScreenReaderObservation,
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
  private currentCursor = 0;

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
      if (
        sibling !== page &&
        sibling.url().startsWith('file:///opt/hoosaidthat/bootstrap.html')
      ) {
        await sibling.close();
      }
    }
    const [health, capabilities] = await Promise.all([
      client.health(),
      client.capabilities(),
    ]);
    if (health.screenReader.name.toLowerCase() !== options.screenReader) {
      throw new Error(
        `runtime screen reader mismatch: requested ${options.screenReader}, got ${health.screenReader.name}`,
      );
    }
    if (health.profile && health.profile !== options.profile) {
      throw new Error(`runtime profile mismatch: requested ${options.profile}, got ${health.profile}`);
    }
    if (health.locale && health.locale !== options.locale) {
      throw new Error(`runtime locale mismatch: requested ${options.locale}, got ${health.locale}`);
    }
    if (health.keyboardLayout && health.keyboardLayout !== options.keyboardLayout) {
      throw new Error(
        `runtime keyboard layout mismatch: requested ${options.keyboardLayout}, got ${health.keyboardLayout}`,
      );
    }
    await client.beginSession(testInfo.testId, options.recording === 'on');
    let cursor: number;
    try {
      cursor = await client.cursor();
    } catch (error) {
      await client.finishSession().catch(() => undefined);
      throw error;
    }
    const supportedActions = new Set(
      capabilities.actions.map((capability) => capability.action),
    );
    const session = new ScreenReaderSession(
      page,
      client,
      options,
      testInfo,
      health,
      supportedActions,
    );
    session.currentCursor = cursor;
    if (options.overlay) {
      await installOverlay(page);
      await updateOverlay(page, 'Screen reader ready', `${health.screenReader.name} ${health.screenReader.version}`);
    }
    await attachEvidenceFile(
      testInfo,
      'screen-reader-runtime.json',
      `${JSON.stringify(health, null, 2)}\n`,
      'application/json',
    );
    return session;
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
            response.lastSequence,
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
    throw new Error(`${label} target was not reached after 100 physical Tab gestures`);
  }

  async observe<T>(
    label: string,
    operation: () => Promise<T>,
    action: 'focus' | 'observe' = 'observe',
  ): Promise<ScreenReaderObservation> {
    return await playwrightTest.step(`Screen reader: ${label}`, async () => {
      const afterSequence = await this.client.cursor();
      await this.show(label, 'Listening...');
      await operation();
      const observation = await this.collect(afterSequence, action, label);
      await this.afterObservation(observation);
      return observation;
    });
  }

  async checkpoint(): Promise<number> {
    return await this.client.cursor();
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
          if (
            observation.action === 'activate' ||
            observation.action === 'activateWithSpace'
          ) {
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

  async captureElement(name: string, locator: Locator): Promise<ScreenReaderObservation> {
    const observation = await this.focus(locator, `Focus ${name}`);
    await this.captureScreenshot(name, locator);
    return observation;
  }

  async captureElements(
    captures: readonly ElementCapture[],
  ): Promise<readonly ScreenReaderObservation[]> {
    const observations: ScreenReaderObservation[] = [];
    const manifest: Array<{ name: string; speech: string; braille: string; timedOut: boolean }> = [];
    for (const capture of captures) {
      const observation = await this.captureElement(capture.name, capture.locator);
      observations.push(observation);
      manifest.push({
        name: capture.name,
        speech: observation.speech,
        braille: observation.braille,
        timedOut: observation.timedOut,
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
      if (
        observation.events.some(
          (event) =>
            event.reason === 'navigationBoundary' || event.reason === 'tableBoundary',
        )
      ) {
        stoppedOnBoundary = true;
        break;
      }
      observations.push(observation);
      if (options.screenshots) {
        screenshots.push(await this.captureScreenshot(`${options.name}-${index + 1}`));
      }
      const source = observation.speechEvents.find((event) => event.source)?.source;
      const key = source
        ? `${source.bus}:${source.path}`
        : observation.speech.trim();
      if (options.stopOnRepeat !== false && key && seen.has(key)) {
        stoppedOnRepeat = true;
        break;
      }
      if (key) seen.add(key);
    }
    return {
      observations,
      screenshots,
      stoppedOnRepeat,
      stoppedOnBoundary,
      stopReason: stoppedOnBoundary ? 'boundary' : stoppedOnRepeat ? 'repeat' : 'max',
    };
  }

  async capturePageElements(options: {
    maxPerKind?: number;
    screenshots?: boolean;
  } = {}): Promise<Readonly<Record<string, ScanResult>>> {
    const max = options.maxPerKind ?? 100;
    if (!Number.isInteger(max) || max < 1 || max > 500) {
      throw new Error('capturePageElements maxPerKind must be an integer between 1 and 500');
    }
    const groups = [
      ['headings', 'nextHeading'],
      ['landmarks', 'nextLandmark'],
      ['buttons', 'nextButton'],
      ['form-fields', 'nextFormField'],
      ['links', 'nextLink'],
      ['lists', 'nextList'],
      ['tables', 'nextTable'],
      ['graphics', 'nextImage'],
    ] as const;
    const results: Record<string, ScanResult> = {};
    for (const [name, action] of groups) {
      await this.act('documentStart');
      results[name] = await this.scan({
        action,
        name,
        max,
        screenshots: options.screenshots ?? true,
        stopOnRepeat: true,
      });
    }
    await attachEvidenceFile(
      this.testInfo,
      'screen-reader-page-elements.json',
      `${JSON.stringify(results, null, 2)}\n`,
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

  async findText(query: string): Promise<ScreenReaderObservation> {
    const normalized = query.trim();
    if (normalized.length === 0 || Buffer.byteLength(normalized) > 500) {
      throw new Error('findText query must contain 1 to 500 bytes');
    }
    if (this.health.screenReader.name !== 'hoovda') {
      throw new Error('findText structured query input requires HooVDA');
    }
    if (!this.supportedActions.has('find')) {
      throw new Error('HooVDA runtime does not support screen-reader action find');
    }
    const label = `Find: ${normalized}`;
    return await playwrightTest.step(`Screen reader: ${label}`, async () => {
      await this.show(label, 'Listening...');
      const response = await this.client.perform('find', normalized);
      if (response.delivery !== 'structured') {
        throw new Error('HooVDA find response did not confirm structured query delivery');
      }
      const observation = this.observation(
        response.events ?? [],
        response.timedOut ?? false,
        'find',
        label,
        response.lastSequence,
      );
      await this.afterObservation(observation);
      return observation;
    });
  }

  async returnToPage(maxGestures = 6): Promise<void> {
    if (!Number.isInteger(maxGestures) || maxGestures < 1 || maxGestures > 20) {
      throw new Error('returnToPage maxGestures must be an integer between 1 and 20');
    }
    // A CDP-connected browser can retain the runtime bootstrap tab as its X11
    // foreground tab even while Playwright operates a different Page. Make the
    // fixture Page foreground first, then allow AT-SPI focus/graph events to
    // settle before trusting runtime focus state.
    await this.page.bringToFront();
    await this.page.waitForTimeout(this.options.quietMs);
    const pageContextReady = async (): Promise<boolean> => {
      const state = await this.client.state();
      if (state.focus.webContentFocused) return true;
      // Chromium sometimes reports its selected tab wrapper as the final
      // AT-SPI focus object even though the active document and HooVDA browse
      // buffer remain live. Require all independent signals before accepting
      // that known browser event-ordering case.
      return (
        this.health.screenReader.name === 'hoovda' &&
        state.focus.browserWindowActive &&
        state.cursorMode === 'browse' &&
        state.virtualBufferActive === true &&
        (await this.page.evaluate(() => document.hasFocus()))
      );
    };
    if (await pageContextReady()) return;
    for (let attempt = 0; attempt < maxGestures; attempt += 1) {
      await this.act('returnToPage');
      if (await pageContextReady()) return;
    }
    throw new Error(
      `web-content focus was not verified after ${maxGestures} physical F6 gestures`,
    );
  }

  async finish(): Promise<void> {
    let evidenceError: unknown;
    try {
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
      response.lastSequence,
    );
  }

  private observation(
    events: readonly ScreenReaderEvent[],
    timedOut: boolean,
    action: ScreenReaderObservation['action'],
    label: string,
    lastSequence: number,
  ): ScreenReaderObservation {
    this.currentCursor = Math.max(this.currentCursor, lastSequence);
    const speechEvents = events.filter(
      (event): event is SpeechEvent => event.kind === 'speech',
    );
    const brailleEvents = events.filter(
      (event): event is BrailleEvent => event.kind === 'braille',
    );
    return {
      action,
      label,
      events,
      speechEvents,
      brailleEvents,
      speech: speechEvents.map((event) => event.text).join(' ').trim(),
      braille: brailleEvents.map((event) => event.text).join(' ').trim(),
      timedOut,
    };
  }

  private async afterObservation(observation: ScreenReaderObservation): Promise<void> {
    this.entries.push({ index: this.entries.length + 1, observation });
    await this.show(
      observation.label,
      formatOverlayOutput(observation),
    );
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

function slug(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return normalized.slice(0, 80) || 'capture';
}

function formatOverlayOutput(observation: ScreenReaderObservation): string {
  const speech = observation.speech ||
    (observation.timedOut ? '(no speech before timeout)' : '(no speech)');
  return observation.braille ? `${speech}\nBraille: ${observation.braille}` : speech;
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
  await testInfo.attach(artifact.name, { path, contentType: artifact.contentType });
}
