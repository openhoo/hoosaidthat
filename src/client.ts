import { createHash } from 'node:crypto';
import type {
  BrailleEvent,
  DownloadedArtifact,
  KeyboardLayout,
  RuntimeArtifact,
  RuntimeEndpoints,
  ScreenReaderAction,
  ScreenReaderCapabilities,
  ScreenReaderEvent,
  ScreenReaderHealth,
  ScreenReaderLocale,
  ScreenReaderName,
  ScreenReaderProfile,
  ScreenReaderPresentationSettings,
  ScreenReaderRuntimeObject,
  ScreenReaderState,
  SpeechEvent,
} from './types.js';
import { SCREEN_READER_ACTIONS, STRUCTURED_SCREEN_READER_ACTIONS } from './types.js';

const MAX_JSON_RESPONSE_BYTES = 128 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 4 * 1024;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;

interface ActionResponse {
  action: ScreenReaderAction;
  afterSequence: number;
  lastSequence: number;
  events?: ScreenReaderEvent[];
  timedOut?: boolean;
  delivery: 'physical' | 'emulated' | 'structured';
}

interface EventsResponse {
  events: ScreenReaderEvent[];
  lastSequence: number;
  timedOut: boolean;
}

interface SessionResponse {
  id: string;
  startSequence: number;
}

export interface ReadEventsOptions {
  timeoutMs: number;
  quietMs: number;
}

export interface ScreenReaderClientConfiguration {
  profile: ScreenReaderProfile;
  locale: ScreenReaderLocale;
  keyboardLayout: KeyboardLayout;
}

export class ScreenReaderProtocolError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ScreenReaderProtocolError';
  }
}

export class HttpScreenReaderClient {
  readonly controlEndpoint: string;
  readonly controlToken: string;
  readonly screenReaderName: ScreenReaderName;
  readonly actionTimeoutMs: number;
  readonly configuration: ScreenReaderClientConfiguration | undefined;

  private sessionId: string | undefined;

  constructor(
    endpoints: RuntimeEndpoints,
    screenReaderName: ScreenReaderName = 'orca',
    actionTimeoutMs = 5_000,
    configuration?: ScreenReaderClientConfiguration,
  ) {
    let endpointLength = endpoints.controlEndpoint.length;
    while (endpointLength > 0 && endpoints.controlEndpoint.charCodeAt(endpointLength - 1) === 47) {
      endpointLength -= 1;
    }
    this.controlEndpoint = endpoints.controlEndpoint.slice(0, endpointLength);
    this.controlToken = endpoints.controlToken;
    this.screenReaderName = screenReaderName;
    this.actionTimeoutMs = actionTimeoutMs;
    this.configuration = configuration;
  }

  async health(timeoutMs = 5_000): Promise<ScreenReaderHealth> {
    if (this.usesV2()) {
      const value = await this.requestJSON('/v2/health', { timeoutMs });
      if (!isV2Health(value, this.screenReaderName)) {
        throw new ScreenReaderProtocolError(`invalid ${this.adapterLabel()} health response`);
      }
      return {
        protocolVersion: 2,
        status: 'ready',
        screenReader: {
          name: this.screenReaderName,
          version: value.version,
          capture:
            this.screenReaderName === 'nvda'
              ? 'nvda-presentation-hooks'
              : 'hoovda-structured-presentation',
        },
        profile: value.profile,
        locale: value.locale,
        keyboardLayout: value.keyboardLayout,
        ...(isObject(value.browser) &&
        typeof value.browser.name === 'string' &&
        typeof value.browser.version === 'string' &&
        isBoundedInteger(value.browser.cdpPort, 1, 65_535)
          ? {
              browser: {
                name: value.browser.name,
                version: value.browser.version,
                cdpPort: value.browser.cdpPort,
              },
            }
          : {}),
        platform: this.screenReaderName === 'nvda' ? 'windows' : 'linux',
      };
    }
    const value = await this.requestJSON('/v1/health', { timeoutMs });
    if (!isV1Health(value)) {
      throw new ScreenReaderProtocolError('invalid screen-reader health response');
    }
    return value;
  }

  async beginSession(testId: string, recording: boolean): Promise<SessionResponse | undefined> {
    if (!this.usesV2()) return undefined;
    if (this.sessionId) {
      throw new ScreenReaderProtocolError(
        `${this.adapterLabel()} client already has an active session`,
      );
    }
    if (this.screenReaderName === 'nvda' && !this.configuration) {
      throw new ScreenReaderProtocolError(
        'NVDA client requires profile, locale, and keyboard layout',
      );
    }
    if (
      typeof testId !== 'string' ||
      Buffer.byteLength(testId) < 1 ||
      Buffer.byteLength(testId) > 500
    ) {
      throw new ScreenReaderProtocolError('testId must contain 1 to 500 bytes');
    }
    const value = await this.requestJSON('/v2/sessions', {
      method: 'POST',
      body: JSON.stringify({
        testId,
        recording,
        ...(this.screenReaderName === 'nvda' ? this.configuration : {}),
      }),
    });
    if (
      !isObject(value) ||
      typeof value.id !== 'string' ||
      !SESSION_ID_PATTERN.test(value.id) ||
      !isSequence(value.startSequence)
    ) {
      throw new ScreenReaderProtocolError(`invalid ${this.adapterLabel()} session response`);
    }
    this.sessionId = value.id;
    return { id: value.id, startSequence: value.startSequence };
  }

  async state(): Promise<ScreenReaderState> {
    if (this.usesV2()) {
      const value = await this.requestJSON(`${this.sessionPath()}/state`);
      if (!isHooVDAState(value)) {
        throw new ScreenReaderProtocolError(`invalid ${this.adapterLabel()} state response`);
      }
      const focus = runtimeObject(value.focus);
      const mouse = runtimeMouse(value.mouse);
      const speech = runtimeSpeech(value.speechMode, value.speechPaused);
      return {
        protocolVersion: 2,
        lastSequence: value.lastSequence,
        cursorMode: value.cursor.mode,
        virtualBufferActive: value.cursorInDocument,
        focus: {
          id: focus?.id ?? null,
          ...(focus?.documentUrlSha256
            ? { documentUrlSha256: focus.documentUrlSha256 }
            : {}),
          browserWindowActive: value.browserWindowActive,
          webContentFocused: value.webContentFocused,
          role: focus?.role ?? null,
          name: focus?.name ?? null,
        },
        browse: runtimeObject(value.browse),
        navigator: runtimeObject(value.navigator),
        review: runtimeObject(value.review),
        ...(mouse ? { mouse } : {}),
        ...(speech ? { speech } : {}),
      };
    }
    const value = await this.requestJSON('/v1/state');
    if (!isV1State(value)) {
      throw new ScreenReaderProtocolError('invalid screen-reader state response');
    }
    return value;
  }

  async capabilities(): Promise<ScreenReaderCapabilities> {
    if (this.usesV2()) {
      const value = await this.requestJSON('/v2/actions');
      if (!isObject(value) || !Array.isArray(value.commands)) {
        throw new ScreenReaderProtocolError(`invalid ${this.adapterLabel()} capabilities response`);
      }
      const actions: Array<{ action: ScreenReaderAction; label: string }> = [];
      const seen = new Set<string>();
      for (const command of value.commands) {
        if (
          !isObject(command) ||
          typeof command.id !== 'string' ||
          !(command.id in SCREEN_READER_ACTIONS) ||
          typeof command.label !== 'string' ||
          command.label.length === 0 ||
          seen.has(command.id)
        ) {
          throw new ScreenReaderProtocolError(`invalid ${this.adapterLabel()} command catalog`);
        }
        seen.add(command.id);
        actions.push({
          action: command.id as ScreenReaderAction,
          label: command.label,
        });
      }
      return { protocolVersion: 2, actions };
    }
    const value = await this.requestJSON('/v1/actions');
    if (!isV1Capabilities(value)) {
      throw new ScreenReaderProtocolError('invalid screen-reader capabilities response');
    }
    return value;
  }

  async cursor(): Promise<number> {
    return (await this.state()).lastSequence;
  }

  async presentationSettings(): Promise<ScreenReaderPresentationSettings> {
    this.requireV2Session('presentation settings');
    const value = await this.requestJSON(`${this.sessionPath()}/settings`);
    if (!isPresentationSettings(value)) {
      throw new ScreenReaderProtocolError(`invalid ${this.adapterLabel()} settings response`);
    }
    return value;
  }

  async setPresentationSettings(
    settings: ScreenReaderPresentationSettings,
  ): Promise<ScreenReaderPresentationSettings> {
    this.requireV2Session('presentation settings');
    if (!isPresentationSettings(settings)) {
      throw new ScreenReaderProtocolError('presentation settings are invalid');
    }
    const value = await this.requestJSON(`${this.sessionPath()}/settings`, {
      method: 'POST',
      body: JSON.stringify(settings),
    });
    if (!isPresentationSettings(value)) {
      throw new ScreenReaderProtocolError(`invalid ${this.adapterLabel()} settings response`);
    }
    return value;
  }

  async resetPresentationSettings(): Promise<ScreenReaderPresentationSettings> {
    this.requireV2Session('presentation settings');
    const value = await this.requestJSON(`${this.sessionPath()}/settings/reset`, {
      method: 'POST',
      body: '{}',
    });
    if (!isPresentationSettings(value)) {
      throw new ScreenReaderProtocolError(`invalid ${this.adapterLabel()} settings response`);
    }
    return value;
  }

  async perform(action: ScreenReaderAction, argument?: string): Promise<ActionResponse> {
    if (action === 'find' && argument === undefined) {
      throw new ScreenReaderProtocolError('find requires a query; use findText()');
    }
    if (argument !== undefined) {
      if (action !== 'find' && action !== 'brailleRoute' && action !== 'brailleReportFormatting') {
        throw new ScreenReaderProtocolError(`${action} does not accept a structured argument`);
      }
      if (Buffer.byteLength(argument) < 1 || Buffer.byteLength(argument) > 500) {
        throw new ScreenReaderProtocolError(
          'structured action argument must contain 1 to 500 bytes',
        );
      }
    }
    if (this.usesV2()) {
      const value = await this.requestJSON(`${this.sessionPath()}/actions`, {
        method: 'POST',
        body: JSON.stringify({
          command: action,
          ...(argument === undefined ? {} : { argument }),
        }),
        timeoutMs: this.actionTimeoutMs + 2_000,
      });
      if (
        !isObject(value) ||
        value.command !== action ||
        !isSequence(value.beforeSequence) ||
        !isSequence(value.cursor) ||
        typeof value.timedOut !== 'boolean' ||
        (value.delivery !== 'physical' &&
          value.delivery !== 'emulated' &&
          value.delivery !== 'structured') ||
        (argument === undefined &&
          value.delivery !==
            (STRUCTURED_SCREEN_READER_ACTIONS.has(action)
              ? 'structured'
              : this.screenReaderName === 'nvda'
                ? 'emulated'
                : 'physical')) ||
        (argument !== undefined && value.delivery !== 'structured') ||
        !Array.isArray(value.events)
      ) {
        throw new ScreenReaderProtocolError(`invalid ${this.adapterLabel()} action response`);
      }
      const events = normalizeEvents(value.events, value.beforeSequence);
      verifyCursor(value.cursor, value.beforeSequence, events);
      return {
        action,
        afterSequence: value.beforeSequence,
        lastSequence: value.cursor,
        events,
        timedOut: value.timedOut,
        delivery: value.delivery,
      };
    }
    if (argument !== undefined) {
      throw new ScreenReaderProtocolError(
        'structured action arguments require a protocol v2 adapter',
      );
    }
    const value = await this.requestJSON('/v1/actions', {
      method: 'POST',
      body: JSON.stringify({ action }),
    });
    if (
      !isObject(value) ||
      value.protocolVersion !== 1 ||
      value.action !== action ||
      !isSequence(value.afterSequence)
    ) {
      throw new ScreenReaderProtocolError('invalid screen-reader action response');
    }
    return {
      action,
      afterSequence: value.afterSequence,
      lastSequence: value.afterSequence,
      delivery: 'physical',
    };
  }

  async readEvents(afterSequence: number, options: ReadEventsOptions): Promise<EventsResponse> {
    validateEventQuery(afterSequence, options);
    const query = new URLSearchParams({
      after: String(afterSequence),
      timeoutMs: String(options.timeoutMs),
      quietMs: String(options.quietMs),
    });
    if (this.usesV2()) {
      const value = await this.requestJSON(`${this.sessionPath()}/events?${query.toString()}`, {
        timeoutMs: options.timeoutMs + 2_000,
      });
      if (
        !isObject(value) ||
        !Array.isArray(value.events) ||
        !isSequence(value.cursor) ||
        typeof value.timedOut !== 'boolean'
      ) {
        throw new ScreenReaderProtocolError(`invalid ${this.adapterLabel()} events response`);
      }
      const normalized = normalizeEvents(value.events, afterSequence);
      verifyCursor(value.cursor, afterSequence, normalized);
      return {
        events: normalized,
        lastSequence: value.cursor,
        timedOut: value.timedOut,
      };
    }
    const value = await this.requestJSON(`/v1/events?${query.toString()}`, {
      timeoutMs: options.timeoutMs + 2_000,
    });
    if (
      !isObject(value) ||
      value.protocolVersion !== 1 ||
      !Array.isArray(value.events) ||
      !isSequence(value.lastSequence) ||
      typeof value.timedOut !== 'boolean'
    ) {
      throw new ScreenReaderProtocolError('invalid screen-reader events response');
    }
    const events: ScreenReaderEvent[] = [];
    let previousSequence = afterSequence;
    for (const event of value.events) {
      if (!isV1SpeechEvent(event) || event.sequence <= previousSequence) {
        throw new ScreenReaderProtocolError('speech events were not strictly ordered');
      }
      previousSequence = event.sequence;
      events.push(event);
    }
    verifyCursor(value.lastSequence, afterSequence, events);
    return {
      events,
      lastSequence: value.lastSequence,
      timedOut: value.timedOut,
    };
  }

  async finishSession(): Promise<DownloadedArtifact[]> {
    if (!this.usesV2() || !this.sessionId) return [];
    const sessionId = this.sessionId;
    const finishPath = `/v2/sessions/${encodeURIComponent(sessionId)}/finish`;
    const finishDeadline = Date.now() + 30_000;
    let value: unknown;
    for (;;) {
      try {
        value = await this.requestJSON(finishPath, {
          method: 'POST',
          body: '{}',
          timeoutMs: Math.max(1, finishDeadline - Date.now()),
        });
        break;
      } catch (error) {
        if (
          !(error instanceof ScreenReaderProtocolError) ||
          !(
            (error.status === 409 &&
              error.message.includes('another session operation is active')) ||
            (error.status === undefined &&
              error.message.startsWith('screen-reader request failed:'))
          ) ||
          Date.now() >= finishDeadline
        ) {
          throw error;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
    }
    // A successful finish response means the remote session is no longer
    // active. Clear local ownership before validating or downloading evidence
    // so a malformed manifest cannot poison the next test in this worker.
    this.sessionId = undefined;
    if (!isObject(value) || value.sessionId !== sessionId || !Array.isArray(value.artifacts)) {
      throw new ScreenReaderProtocolError(`invalid ${this.adapterLabel()} finish response`);
    }
    const artifacts = value.artifacts.map(parseArtifact);
    if (new Set(artifacts.map((artifact) => artifact.name)).size !== artifacts.length) {
      throw new ScreenReaderProtocolError(
        `${this.adapterLabel()} artifact manifest contained duplicate names`,
      );
    }
    const downloaded: DownloadedArtifact[] = [];
    for (const artifact of artifacts) {
      const body = await this.requestBytes(
        `/v2/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifact.name)}`,
        30_000,
        artifact.bytes,
      );
      if (body.byteLength !== artifact.bytes) {
        throw new ScreenReaderProtocolError(`artifact ${artifact.name} byte count mismatch`);
      }
      const digest = createHash('sha256').update(body).digest('hex');
      if (digest !== artifact.sha256) {
        throw new ScreenReaderProtocolError(`artifact ${artifact.name} SHA-256 mismatch`);
      }
      downloaded.push({ ...artifact, body });
    }
    return downloaded;
  }

  private sessionPath(): string {
    if (!this.sessionId) {
      throw new ScreenReaderProtocolError(`${this.adapterLabel()} test session has not started`);
    }
    return `/v2/sessions/${encodeURIComponent(this.sessionId)}`;
  }

  private requireV2Session(feature: string): void {
    if (!this.usesV2()) {
      throw new ScreenReaderProtocolError(`${feature} require a protocol v2 adapter`);
    }
    this.sessionPath();
  }

  private usesV2(): boolean {
    return this.screenReaderName === 'hoovda' || this.screenReaderName === 'nvda';
  }

  private adapterLabel(): string {
    return this.screenReaderName === 'nvda' ? 'NVDA' : 'HooVDA';
  }

  private async requestJSON(
    path: string,
    options: {
      method?: 'GET' | 'POST';
      body?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<unknown> {
    const response = await this.request(path, options);
    const text = decodeUtf8(
      await readBoundedResponse(response, MAX_JSON_RESPONSE_BYTES),
      'screen-reader JSON response',
    );
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ScreenReaderProtocolError('screen-reader response was not JSON');
    }
  }

  private async requestBytes(
    path: string,
    timeoutMs: number,
    maximumBytes: number,
  ): Promise<Uint8Array> {
    const response = await this.request(path, { timeoutMs });
    return await readBoundedResponse(response, maximumBytes);
  }

  private async request(
    path: string,
    options: { method?: 'GET' | 'POST'; body?: string; timeoutMs?: number },
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.controlEndpoint}${path}`, {
        method: options.method ?? 'GET',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${this.controlToken}`,
          ...(options.body ? { 'content-type': 'application/json' } : {}),
        },
        ...(options.body ? { body: options.body } : {}),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
    } catch (error) {
      throw new ScreenReaderProtocolError(
        `screen-reader request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      const text = decodeUtf8(
        await readBoundedResponse(response, MAX_ERROR_RESPONSE_BYTES),
        'screen-reader error response',
      );
      throw new ScreenReaderProtocolError(
        `screen-reader request failed (${response.status}): ${text.slice(0, 500)}`,
        response.status,
      );
    }
    return response;
  }
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maximumBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new ScreenReaderProtocolError(`screen-reader response exceeded ${maximumBytes} bytes`);
    }
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new ScreenReaderProtocolError(
          `screen-reader response exceeded ${maximumBytes} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function decodeUtf8(value: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    throw new ScreenReaderProtocolError(`${label} was not UTF-8`);
  }
}

function normalizeEvents(values: unknown[], afterSequence: number): ScreenReaderEvent[] {
  const result: ScreenReaderEvent[] = [];
  let previousSequence = afterSequence;
  for (const value of values) {
    if (!isHooVDAEvent(value) || value.sequence <= previousSequence) {
      throw new ScreenReaderProtocolError(
        'protocol v2 events were malformed or not strictly ordered',
      );
    }
    previousSequence = value.sequence;
    if (
      (value.causalCommand !== undefined && typeof value.causalCommand !== 'string') ||
      (value.text !== undefined && typeof value.text !== 'string') ||
      (value.reason !== undefined && typeof value.reason !== 'string') ||
      (value.provenance !== undefined && !isEventProvenance(value.provenance)) ||
      (value.redacted !== undefined && typeof value.redacted !== 'boolean') ||
      (value.priority !== undefined &&
        (typeof value.priority !== 'string' || value.priority.length > 100))
    ) {
      throw new ScreenReaderProtocolError('protocol v2 event fields were malformed');
    }
    const base = {
      sequence: value.sequence,
      monotonicNs: value.monotonicNs,
      kind: value.kind,
      command: typeof value.causalCommand === 'string' ? value.causalCommand : '',
      text: typeof value.text === 'string' ? value.text : '',
      ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
      ...(value.source === undefined ? {} : { source: parseSource(value.source) }),
      ...(isEventProvenance(value.provenance) ? { provenance: value.provenance } : {}),
      ...(typeof value.redacted === 'boolean' ? { redacted: value.redacted } : {}),
    };
    if (value.kind === 'braille') {
      if (
        typeof value.text !== 'string' ||
        (value.brailleCursor !== undefined && !isSequence(value.brailleCursor))
      ) {
        throw new ScreenReaderProtocolError('protocol v2 braille event was malformed');
      }
      const cells = parseBase64(value.brailleCells);
      result.push({
        ...base,
        kind: 'braille',
        cells,
        cursor: integerOrZero(value.brailleCursor),
      });
    } else if (value.kind === 'speech') {
      if (
        typeof value.text !== 'string' ||
        (value.speechCommands !== undefined &&
          (!Array.isArray(value.speechCommands) || !value.speechCommands.every(isSpeechCommand)))
      ) {
        throw new ScreenReaderProtocolError('protocol v2 speech event was malformed');
      }
      result.push({
        ...base,
        kind: 'speech',
        ...(Array.isArray(value.speechCommands) ? { speechCommands: value.speechCommands } : {}),
      });
    } else if (value.kind === 'focus') {
      if (value.text !== undefined && typeof value.text !== 'string') {
        throw new ScreenReaderProtocolError('protocol v2 focus event was malformed');
      }
      result.push({ ...base, kind: 'focus' });
    } else if (value.kind === 'mode') {
      if (typeof value.mode !== 'string' || value.mode.length === 0) {
        throw new ScreenReaderProtocolError('protocol v2 mode event was malformed');
      }
      result.push({
        ...base,
        kind: 'mode',
        mode: typeof value.mode === 'string' ? value.mode : '',
      });
    } else if (value.kind === 'audio') {
      if (!isSequence(value.audioOffsetNs) || !isSequence(value.audioDurationNs)) {
        throw new ScreenReaderProtocolError('protocol v2 audio event was malformed');
      }
      result.push({
        ...base,
        kind: 'audio',
        audioOffsetNs: integerOrZero(value.audioOffsetNs),
        audioDurationNs: integerOrZero(value.audioDurationNs),
      });
    } else if (value.kind === 'liveRegion') {
      if (
        typeof value.text !== 'string' ||
        (value.priority !== undefined &&
          value.priority !== 'polite' &&
          value.priority !== 'assertive')
      ) {
        throw new ScreenReaderProtocolError('protocol v2 live-region event was malformed');
      }
      result.push({
        ...base,
        kind: 'liveRegion',
        ...(typeof value.priority === 'string' && value.priority
          ? { priority: value.priority }
          : {}),
      });
    } else {
      result.push({ ...base, kind: value.kind });
    }
  }
  return result;
}

function isEventProvenance(value: unknown): value is NonNullable<ScreenReaderEvent['provenance']> {
  return (
    value === 'screenReaderOutput' ||
    value === 'screenReaderEvent' ||
    value === 'accessibilityEvent' ||
    value === 'adapterLifecycle' ||
    value === 'synthesizedAudio'
  );
}

function parseSource(value: unknown): { bus: string; path: string } {
  if (
    !isObject(value) ||
    typeof value.bus !== 'string' ||
    value.bus.length === 0 ||
    typeof value.path !== 'string' ||
    !value.path.startsWith('/')
  ) {
    throw new ScreenReaderProtocolError('protocol v2 event source was malformed');
  }
  return { bus: value.bus, path: value.path };
}

function parseBase64(value: unknown): number[] {
  if (
    typeof value !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new ScreenReaderProtocolError('protocol v2 braille cells were malformed');
  }
  return [...Buffer.from(value, 'base64')];
}

function isHooVDAEvent(value: unknown): value is Record<string, unknown> & {
  sequence: number;
  monotonicNs: number;
  kind:
    | 'speech'
    | 'braille'
    | 'focus'
    | 'mode'
    | 'audio'
    | 'commandStarted'
    | 'commandSettled'
    | 'liveRegion';
} {
  return (
    isObject(value) &&
    isSequence(value.sequence) &&
    isSequence(value.monotonicNs) &&
    typeof value.kind === 'string' &&
    [
      'speech',
      'braille',
      'focus',
      'mode',
      'audio',
      'commandStarted',
      'commandSettled',
      'liveRegion',
    ].includes(value.kind)
  );
}

function parseArtifact(value: unknown): RuntimeArtifact {
  if (
    !isObject(value) ||
    typeof value.name !== 'string' ||
    typeof value.contentType !== 'string' ||
    !isSequence(value.bytes) ||
    typeof value.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.sha256)
  ) {
    throw new ScreenReaderProtocolError('invalid protocol v2 artifact manifest');
  }
  const contracts: Readonly<Record<string, { contentType: string; maxBytes: number }>> = {
    'screenreader-events': {
      contentType: 'application/json',
      maxBytes: 100_000_000,
    },
    'screenreader-document': {
      contentType: 'application/json',
      maxBytes: 100_000_000,
    },
    'screenreader-audio': { contentType: 'audio/wav', maxBytes: 1_000_000_000 },
    'screenreader-video': {
      contentType: 'video/webm',
      maxBytes: 1_000_000_000,
    },
  };
  const contract = contracts[value.name];
  if (
    !contract ||
    value.contentType !== contract.contentType ||
    value.bytes < 1 ||
    value.bytes > contract.maxBytes
  ) {
    throw new ScreenReaderProtocolError('invalid protocol v2 artifact contract');
  }
  return {
    name: value.name,
    contentType: value.contentType,
    bytes: value.bytes,
    sha256: value.sha256,
  };
}

function validateEventQuery(afterSequence: number, options: ReadEventsOptions): void {
  if (!isSequence(afterSequence)) {
    throw new ScreenReaderProtocolError('afterSequence must be a non-negative safe integer');
  }
  if (!isBoundedInteger(options.timeoutMs, 1, 30_000)) {
    throw new ScreenReaderProtocolError('timeoutMs must be an integer between 1 and 30000');
  }
  if (!isBoundedInteger(options.quietMs, 1, 5_000)) {
    throw new ScreenReaderProtocolError('quietMs must be an integer between 1 and 5000');
  }
}

function verifyCursor(
  cursor: number,
  afterSequence: number,
  events: readonly ScreenReaderEvent[],
): void {
  const previousSequence = events.at(-1)?.sequence ?? afterSequence;
  if (cursor < previousSequence || cursor < afterSequence) {
    throw new ScreenReaderProtocolError('events response cursor moved backwards');
  }
}

function isV1SpeechEvent(value: unknown): value is SpeechEvent {
  return (
    isObject(value) &&
    isSequence(value.sequence) &&
    isSequence(value.monotonicNs) &&
    value.kind === 'speech' &&
    typeof value.text === 'string' &&
    typeof value.command === 'string'
  );
}

function isV1Health(value: unknown): value is ScreenReaderHealth {
  if (!isObject(value) || value.protocolVersion !== 1 || value.status !== 'ready') return false;
  const screenReader = value.screenReader;
  const browser = value.browser;
  return (
    isObject(screenReader) &&
    screenReader.name === 'orca' &&
    screenReader.capture === 'speech-dispatcher-output-module' &&
    typeof screenReader.version === 'string' &&
    screenReader.version.length > 0 &&
    isObject(browser) &&
    typeof browser.name === 'string' &&
    typeof browser.version === 'string' &&
    isBoundedInteger(browser.cdpPort, 1, 65_535) &&
    value.platform === 'linux'
  );
}

function isV2Health(
  value: unknown,
  expected: ScreenReaderName,
): value is {
  protocolVersion: '2.0';
  status: 'ok';
  version: string;
  profile: 'nvda-web-2026.1.1';
  locale: 'en-US' | 'de-DE';
  keyboardLayout: 'desktop' | 'laptop';
  ready: true;
  screenReader?: string;
  browser?: unknown;
} {
  return (
    isObject(value) &&
    value.protocolVersion === '2.0' &&
    value.status === 'ok' &&
    (expected !== 'nvda' || value.screenReader === 'nvda') &&
    (expected !== 'hoovda' ||
      value.screenReader === undefined ||
      value.screenReader === 'hoovda') &&
    typeof value.version === 'string' &&
    value.version.length > 0 &&
    (expected !== 'nvda' || value.version === '2026.1.1') &&
    value.profile === 'nvda-web-2026.1.1' &&
    (value.locale === 'en-US' || value.locale === 'de-DE') &&
    (value.keyboardLayout === 'desktop' || value.keyboardLayout === 'laptop') &&
    value.ready === true &&
    (expected !== 'nvda' ||
      (isObject(value.browser) &&
        value.browser.name === 'chrome' &&
        typeof value.browser.version === 'string' &&
        value.browser.version.length > 0 &&
        isBoundedInteger(value.browser.cdpPort, 1, 65_535)))
  );
}

function isV1Capabilities(value: unknown): value is ScreenReaderCapabilities {
  if (!isObject(value) || value.protocolVersion !== 1 || !Array.isArray(value.actions))
    return false;
  const seen = new Set<string>();
  return value.actions.every((item) => {
    if (
      !isObject(item) ||
      typeof item.action !== 'string' ||
      !(item.action in SCREEN_READER_ACTIONS) ||
      typeof item.label !== 'string' ||
      item.label.length === 0 ||
      seen.has(item.action)
    )
      return false;
    seen.add(item.action);
    return true;
  });
}

function isV1State(value: unknown): value is ScreenReaderState {
  if (!isObject(value) || value.protocolVersion !== 1 || !isSequence(value.lastSequence))
    return false;
  const focus = value.focus;
  return (
    isObject(focus) &&
    typeof focus.browserWindowActive === 'boolean' &&
    typeof focus.webContentFocused === 'boolean' &&
    (typeof focus.role === 'string' || focus.role === null) &&
    (typeof focus.name === 'string' || focus.name === null)
  );
}

const PRESENTATION_BOOLEAN_KEYS = [
  'reportKeyboardShortcuts',
  'reportObjectPositionInformation',
  'reportObjectDescriptions',
  'reportDynamicContentChanges',
  'reportAriaDescription',
  'reportDetails',
  'reportFontName',
  'reportFontSize',
  'reportColor',
  'reportStyle',
  'reportTables',
  'includeLayoutTables',
  'reportTableCellCoordinates',
  'reportLinks',
  'reportLinkType',
  'reportGraphics',
  'reportComments',
  'reportBookmarks',
  'reportLists',
  'reportHeadings',
  'reportBlockQuotes',
  'reportGroupings',
  'reportLandmarks',
  'reportArticles',
  'reportFrames',
  'reportFigures',
  'reportClickable',
] as const;

function isPresentationSettings(value: unknown): value is ScreenReaderPresentationSettings {
  if (!isObject(value)) return false;
  const expectedKeys = new Set<string>([
    ...PRESENTATION_BOOLEAN_KEYS,
    'speechSymbolLevel',
    'brailleTether',
    'fontAttributeReporting',
    'reportSpellingErrors',
    'reportTableHeaders',
  ]);
  if (
    Object.keys(value).length !== expectedKeys.size ||
    Object.keys(value).some((key) => !expectedKeys.has(key))
  ) {
    return false;
  }
  if (PRESENTATION_BOOLEAN_KEYS.some((key) => typeof value[key] !== 'boolean')) return false;
  if (!['none', 'some', 'most', 'all', 'character'].includes(value.speechSymbolLevel as string)) {
    return false;
  }
  if (!['auto', 'focus', 'review'].includes(value.brailleTether as string)) return false;
  if (
    !['off', 'speech', 'braille', 'speechAndBraille'].includes(
      value.fontAttributeReporting as string,
    )
  ) {
    return false;
  }
  if (!['off', 'rowsAndColumns', 'rows', 'columns'].includes(value.reportTableHeaders as string)) {
    return false;
  }
  if (!Array.isArray(value.reportSpellingErrors)) return false;
  const channels = value.reportSpellingErrors;
  return (
    new Set(channels).size === channels.length &&
    channels.every(
      (channel) => channel === 'speech' || channel === 'sound' || channel === 'braille',
    )
  );
}

function isHooVDAState(value: unknown): value is {
  lastSequence: number;
  browserWindowActive: boolean;
  webContentFocused: boolean;
  cursorInDocument: boolean;
  cursor: { mode: string };
  focus?: unknown;
  browse?: unknown;
  navigator?: unknown;
  review?: unknown;
  mouse?: unknown;
  speechMode?: unknown;
  speechPaused?: unknown;
} {
  if (
    !isObject(value) ||
    !isSequence(value.lastSequence) ||
    typeof value.browserWindowActive !== 'boolean' ||
    typeof value.webContentFocused !== 'boolean' ||
    typeof value.cursorInDocument !== 'boolean' ||
    !isObject(value.cursor) ||
    typeof value.cursor.mode !== 'string' ||
    value.cursor.mode.length < 1 ||
    value.cursor.mode.length > 100
  ) {
    return false;
  }
  for (const key of ['focus', 'browse', 'navigator', 'review'] as const) {
    if (key in value && !isRuntimeObjectWire(value[key])) return false;
  }
  if ('mouse' in value && !isRuntimeMouseWire(value.mouse)) return false;
  const hasSpeechMode = 'speechMode' in value;
  const hasSpeechPaused = 'speechPaused' in value;
  if (hasSpeechMode !== hasSpeechPaused) return false;
  return (
    !hasSpeechMode ||
    (typeof value.speechMode === 'string' &&
      value.speechMode.length >= 1 &&
      value.speechMode.length <= 100 &&
      typeof value.speechPaused === 'boolean')
  );
}

function runtimeObject(value: unknown): ScreenReaderRuntimeObject | null {
  if (value === undefined || value === null) return null;
  if (!isRuntimeObjectWire(value) || !isObject(value)) {
    throw new ScreenReaderProtocolError('protocol v2 runtime object was malformed');
  }
  if (
    typeof value.bus === 'string' &&
    value.bus.length > 0 &&
    typeof value.path === 'string' &&
    value.path.startsWith('/')
  ) {
    return {
      id: `${value.bus}:${value.path}`,
      role: null,
      name: null,
      location: null,
    };
  }
  const location = value.location;
  return {
    ...(typeof value.id === 'string' ? { id: value.id } : {}),
    ...(typeof value.documentUrlSha256 === 'string'
      ? { documentUrlSha256: value.documentUrlSha256 }
      : {}),
    role: typeof value.role === 'string' ? value.role : null,
    name: typeof value.name === 'string' ? value.name : null,
    ...(typeof value.visited === 'boolean' ? { visited: value.visited } : {}),
    ...(value.redacted === true ? { redacted: true } : {}),
    ...(Array.isArray(value.quickNavigationTargets)
      ? { quickNavigationTargets: value.quickNavigationTargets as string[] }
      : {}),
    location: isObject(location)
      ? (location as NonNullable<ScreenReaderState['navigator']>['location'])
      : null,
  };
}

function runtimeMouse(value: unknown): ScreenReaderState['mouse'] {
  if (value === undefined) return undefined;
  if (!isRuntimeMouseWire(value) || !isObject(value)) {
    throw new ScreenReaderProtocolError('protocol v2 mouse state was malformed');
  }
  if (!Number.isSafeInteger(value.x) || !Number.isSafeInteger(value.y)) {
    return undefined;
  }
  return {
    x: value.x as number,
    y: value.y as number,
    object: runtimeObject(value.object) ?? null,
  };
}

function isRuntimeObjectWire(value: unknown): boolean {
  if (value === null) return true;
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  if (keys.every((key) => key === 'bus' || key === 'path')) {
    return (
      typeof value.bus === 'string' &&
      value.bus.length >= 1 &&
      value.bus.length <= 4_096 &&
      typeof value.path === 'string' &&
      value.path.startsWith('/') &&
      value.path.length <= 4_096
    );
  }
  if (
    keys.some(
      (key) =>
        key !== 'id' &&
        key !== 'documentUrlSha256' &&
        key !== 'role' &&
        key !== 'name' &&
        key !== 'location' &&
        key !== 'visited' &&
        key !== 'redacted' &&
        key !== 'quickNavigationTargets',
    )
  ) {
    return false;
  }
  if (
    value.id !== undefined &&
    (typeof value.id !== 'string' || value.id.length < 1 || value.id.length > 200)
  ) {
    return false;
  }
  if (
    value.documentUrlSha256 !== undefined &&
    (typeof value.documentUrlSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.documentUrlSha256))
  ) {
    return false;
  }
  if (value.visited !== undefined && typeof value.visited !== 'boolean') return false;
  if (value.redacted !== undefined && typeof value.redacted !== 'boolean') return false;
  if (
    value.quickNavigationTargets !== undefined &&
    (!Array.isArray(value.quickNavigationTargets) ||
      value.quickNavigationTargets.length > 100 ||
      new Set(value.quickNavigationTargets).size !== value.quickNavigationTargets.length ||
      !value.quickNavigationTargets.every(
        (target) => typeof target === 'string' && target.length >= 1 && target.length <= 100,
      ))
  ) {
    return false;
  }
  if (
    (value.role !== undefined &&
      value.role !== null &&
      (typeof value.role !== 'string' || value.role.length > 10_000)) ||
    (value.name !== undefined &&
      value.name !== null &&
      (typeof value.name !== 'string' || value.name.length > 100_000))
  ) {
    return false;
  }
  const location = value.location;
  return (
    location === undefined ||
    location === null ||
    (isObject(location) &&
      Object.keys(location).length === 4 &&
      Number.isSafeInteger(location.left) &&
      Number.isSafeInteger(location.top) &&
      Number.isSafeInteger(location.width) &&
      Number.isSafeInteger(location.height))
  );
}

function isRuntimeMouseWire(value: unknown): boolean {
  return (
    isObject(value) &&
    Object.keys(value).every((key) => key === 'x' || key === 'y' || key === 'object') &&
    Object.keys(value).length === 3 &&
    Number.isSafeInteger(value.x) &&
    Number.isSafeInteger(value.y) &&
    isRuntimeObjectWire(value.object)
  );
}

function runtimeSpeech(mode: unknown, paused: unknown): ScreenReaderState['speech'] {
  if (typeof mode !== 'string' || mode.length === 0 || typeof paused !== 'boolean') {
    return undefined;
  }
  return { mode, paused };
}

function isSpeechCommand(value: unknown): value is { kind: string; value?: string } {
  return (
    isObject(value) &&
    typeof value.kind === 'string' &&
    (value.value === undefined || typeof value.value === 'string')
  );
}

function integerOrZero(value: unknown): number {
  return isSequence(value) ? value : 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}
