import { createHash } from 'node:crypto';
import type {
  BrailleEvent,
  DownloadedArtifact,
  RuntimeArtifact,
  RuntimeEndpoints,
  ScreenReaderAction,
  ScreenReaderCapabilities,
  ScreenReaderEvent,
  ScreenReaderHealth,
  ScreenReaderName,
  ScreenReaderState,
  SpeechEvent,
} from './types.js';
import { SCREEN_READER_ACTIONS } from './types.js';

interface ActionResponse {
  action: ScreenReaderAction;
  afterSequence: number;
  lastSequence: number;
  events?: ScreenReaderEvent[];
  timedOut?: boolean;
  delivery: 'physical' | 'structured';
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

export class ScreenReaderProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScreenReaderProtocolError';
  }
}

export class HttpScreenReaderClient {
  readonly controlEndpoint: string;
  readonly controlToken: string;
  readonly screenReaderName: ScreenReaderName;
  readonly actionTimeoutMs: number;

  private sessionId: string | undefined;

  constructor(
    endpoints: RuntimeEndpoints,
    screenReaderName: ScreenReaderName = 'orca',
    actionTimeoutMs = 5_000,
  ) {
    this.controlEndpoint = endpoints.controlEndpoint.replace(/\/$/, '');
    this.controlToken = endpoints.controlToken;
    this.screenReaderName = screenReaderName;
    this.actionTimeoutMs = actionTimeoutMs;
  }

  async health(timeoutMs = 5_000): Promise<ScreenReaderHealth> {
    if (this.screenReaderName === 'hoovda') {
      const value = await this.requestJSON('/v2/health', { timeoutMs });
      if (!isHooVDAHealth(value)) {
        throw new ScreenReaderProtocolError('invalid HooVDA health response');
      }
      return {
        protocolVersion: 2,
        status: 'ready',
        screenReader: {
          name: 'hoovda',
          version: value.version,
          capture: 'hoovda-structured-presentation',
        },
        profile: value.profile,
        locale: value.locale,
        keyboardLayout: value.keyboardLayout,
        platform: 'linux',
      };
    }
    const value = await this.requestJSON('/v1/health', { timeoutMs });
    if (!isV1Health(value)) {
      throw new ScreenReaderProtocolError('invalid screen-reader health response');
    }
    return value;
  }

  async beginSession(testId: string, recording: boolean): Promise<SessionResponse | undefined> {
    if (this.screenReaderName !== 'hoovda') return undefined;
    if (this.sessionId) {
      throw new ScreenReaderProtocolError('HooVDA client already has an active session');
    }
    const value = await this.requestJSON('/v2/sessions', {
      method: 'POST',
      body: JSON.stringify({ testId, recording }),
    });
    if (!isObject(value) || typeof value.id !== 'string' || !isSequence(value.startSequence)) {
      throw new ScreenReaderProtocolError('invalid HooVDA session response');
    }
    this.sessionId = value.id;
    return { id: value.id, startSequence: value.startSequence };
  }

  async state(): Promise<ScreenReaderState> {
    if (this.screenReaderName === 'hoovda') {
      const value = await this.requestJSON(`${this.sessionPath()}/state`);
      if (!isHooVDAState(value)) {
        throw new ScreenReaderProtocolError('invalid HooVDA state response');
      }
      return {
        protocolVersion: 2,
        lastSequence: value.lastSequence,
        cursorMode: value.cursor.mode,
        virtualBufferActive: value.cursorInDocument,
        focus: {
          browserWindowActive: value.browserWindowActive,
          webContentFocused: value.webContentFocused,
          role: null,
          name: null,
        },
      };
    }
    const value = await this.requestJSON('/v1/state');
    if (!isV1State(value)) {
      throw new ScreenReaderProtocolError('invalid screen-reader state response');
    }
    return value;
  }

  async capabilities(): Promise<ScreenReaderCapabilities> {
    if (this.screenReaderName === 'hoovda') {
      const value = await this.requestJSON('/v2/actions');
      if (!isObject(value) || !Array.isArray(value.commands)) {
        throw new ScreenReaderProtocolError('invalid HooVDA capabilities response');
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
          throw new ScreenReaderProtocolError('invalid HooVDA command catalog');
        }
        seen.add(command.id);
        actions.push({ action: command.id as ScreenReaderAction, label: command.label });
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

  async perform(action: ScreenReaderAction, argument?: string): Promise<ActionResponse> {
    if (this.screenReaderName === 'hoovda') {
      const value = await this.requestJSON(`${this.sessionPath()}/actions`, {
        method: 'POST',
        body: JSON.stringify({ command: action, ...(argument === undefined ? {} : { argument }) }),
        timeoutMs: this.actionTimeoutMs + 2_000,
      });
      if (
        !isObject(value) ||
        value.command !== action ||
        !isSequence(value.beforeSequence) ||
        !isSequence(value.cursor) ||
        typeof value.timedOut !== 'boolean' ||
        (value.delivery !== 'physical' && value.delivery !== 'structured') ||
        (argument === undefined && value.delivery !== 'physical') ||
        (argument !== undefined && value.delivery !== 'structured') ||
        !Array.isArray(value.events)
      ) {
        throw new ScreenReaderProtocolError('invalid HooVDA action response');
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
      throw new ScreenReaderProtocolError('structured action arguments require HooVDA');
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
    if (this.screenReaderName === 'hoovda') {
      const value = await this.requestJSON(`${this.sessionPath()}/events?${query.toString()}`, {
        timeoutMs: options.timeoutMs + 2_000,
      });
      if (
        !isObject(value) ||
        !Array.isArray(value.events) ||
        !isSequence(value.cursor) ||
        typeof value.timedOut !== 'boolean'
      ) {
        throw new ScreenReaderProtocolError('invalid HooVDA events response');
      }
      const normalized = normalizeEvents(value.events, afterSequence);
      verifyCursor(value.cursor, afterSequence, normalized);
      return { events: normalized, lastSequence: value.cursor, timedOut: value.timedOut };
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
    return { events, lastSequence: value.lastSequence, timedOut: value.timedOut };
  }

  async finishSession(): Promise<DownloadedArtifact[]> {
    if (this.screenReaderName !== 'hoovda' || !this.sessionId) return [];
    const sessionId = this.sessionId;
    const value = await this.requestJSON(`/v2/sessions/${encodeURIComponent(sessionId)}/finish`, {
      method: 'POST',
      timeoutMs: 30_000,
    });
    if (!isObject(value) || value.sessionId !== sessionId || !Array.isArray(value.artifacts)) {
      throw new ScreenReaderProtocolError('invalid HooVDA finish response');
    }
    const artifacts = value.artifacts.map(parseArtifact);
    if (new Set(artifacts.map((artifact) => artifact.name)).size !== artifacts.length) {
      throw new ScreenReaderProtocolError('HooVDA artifact manifest contained duplicate names');
    }
    const downloaded = await Promise.all(
      artifacts.map(async (artifact) => {
        const body = await this.requestBytes(
          `/v2/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifact.name)}`,
          30_000,
        );
        if (body.byteLength !== artifact.bytes) {
          throw new ScreenReaderProtocolError(`artifact ${artifact.name} byte count mismatch`);
        }
        const digest = createHash('sha256').update(body).digest('hex');
        if (digest !== artifact.sha256) {
          throw new ScreenReaderProtocolError(`artifact ${artifact.name} SHA-256 mismatch`);
        }
        return { ...artifact, body };
      }),
    );
    this.sessionId = undefined;
    return downloaded;
  }

  private sessionPath(): string {
    if (!this.sessionId) {
      throw new ScreenReaderProtocolError('HooVDA test session has not started');
    }
    return `/v2/sessions/${encodeURIComponent(this.sessionId)}`;
  }

  private async requestJSON(
    path: string,
    options: { method?: 'GET' | 'POST'; body?: string; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const response = await this.request(path, options);
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ScreenReaderProtocolError('screen-reader response was not JSON');
    }
  }

  private async requestBytes(path: string, timeoutMs: number): Promise<Uint8Array> {
    const response = await this.request(path, { timeoutMs });
    return new Uint8Array(await response.arrayBuffer());
  }

  private async request(
    path: string,
    options: { method?: 'GET' | 'POST'; body?: string; timeoutMs?: number },
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.controlEndpoint}${path}`, {
        method: options.method ?? 'GET',
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
      const text = await response.text();
      throw new ScreenReaderProtocolError(
        `screen-reader request failed (${response.status}): ${text.slice(0, 500)}`,
      );
    }
    return response;
  }
}

function normalizeEvents(values: unknown[], afterSequence: number): ScreenReaderEvent[] {
  const result: ScreenReaderEvent[] = [];
  let previousSequence = afterSequence;
  for (const value of values) {
    if (!isHooVDAEvent(value) || value.sequence <= previousSequence) {
      throw new ScreenReaderProtocolError('HooVDA events were malformed or not strictly ordered');
    }
    previousSequence = value.sequence;
    if (
      (value.causalCommand !== undefined && typeof value.causalCommand !== 'string') ||
      (value.text !== undefined && typeof value.text !== 'string') ||
      (value.reason !== undefined && typeof value.reason !== 'string')
    ) {
      throw new ScreenReaderProtocolError('HooVDA event fields were malformed');
    }
    const base = {
      sequence: value.sequence,
      monotonicNs: value.monotonicNs,
      kind: value.kind,
      command: typeof value.causalCommand === 'string' ? value.causalCommand : '',
      text: typeof value.text === 'string' ? value.text : '',
      ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
      ...(value.source === undefined ? {} : { source: parseSource(value.source) }),
    };
    if (value.kind === 'braille') {
      if (
        typeof value.text !== 'string' ||
        (value.brailleCursor !== undefined && !isSequence(value.brailleCursor))
      ) {
        throw new ScreenReaderProtocolError('HooVDA braille event was malformed');
      }
      const cells = parseBase64(value.brailleCells);
      result.push({ ...base, kind: 'braille', cells, cursor: integerOrZero(value.brailleCursor) });
    } else if (value.kind === 'speech') {
      if (
        typeof value.text !== 'string' ||
        (value.speechCommands !== undefined &&
          (!Array.isArray(value.speechCommands) || !value.speechCommands.every(isSpeechCommand)))
      ) {
        throw new ScreenReaderProtocolError('HooVDA speech event was malformed');
      }
      result.push({
        ...base,
        kind: 'speech',
        ...(Array.isArray(value.speechCommands)
          ? { speechCommands: value.speechCommands }
          : {}),
      });
    } else if (value.kind === 'focus') {
      if (typeof value.text !== 'string') {
        throw new ScreenReaderProtocolError('HooVDA focus event was malformed');
      }
      result.push({ ...base, kind: 'focus' });
    } else if (value.kind === 'mode') {
      if (typeof value.mode !== 'string' || value.mode.length === 0) {
        throw new ScreenReaderProtocolError('HooVDA mode event was malformed');
      }
      result.push({ ...base, kind: 'mode', mode: typeof value.mode === 'string' ? value.mode : '' });
    } else if (value.kind === 'audio') {
      if (!isSequence(value.audioOffsetNs) || !isSequence(value.audioDurationNs)) {
        throw new ScreenReaderProtocolError('HooVDA audio event was malformed');
      }
      result.push({
        ...base,
        kind: 'audio',
        audioOffsetNs: integerOrZero(value.audioOffsetNs),
        audioDurationNs: integerOrZero(value.audioDurationNs),
      });
    } else {
      result.push({ ...base, kind: value.kind });
    }
  }
  return result;
}

function parseSource(value: unknown): { bus: string; path: string } {
  if (
    !isObject(value) ||
    typeof value.bus !== 'string' ||
    value.bus.length === 0 ||
    typeof value.path !== 'string' ||
    !value.path.startsWith('/')
  ) {
    throw new ScreenReaderProtocolError('HooVDA event source was malformed');
  }
  return { bus: value.bus, path: value.path };
}

function parseBase64(value: unknown): number[] {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new ScreenReaderProtocolError('HooVDA braille cells were malformed');
  }
  return [...Buffer.from(value, 'base64')];
}

function isHooVDAEvent(value: unknown): value is Record<string, unknown> & {
  sequence: number;
  monotonicNs: number;
  kind: 'speech' | 'braille' | 'focus' | 'mode' | 'audio' | 'commandStarted' | 'commandSettled' | 'liveRegion';
} {
  return (
    isObject(value) &&
    isSequence(value.sequence) &&
    isSequence(value.monotonicNs) &&
    typeof value.kind === 'string' &&
    ['speech', 'braille', 'focus', 'mode', 'audio', 'commandStarted', 'commandSettled', 'liveRegion'].includes(value.kind)
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
    throw new ScreenReaderProtocolError('invalid HooVDA artifact manifest');
  }
  const contracts: Readonly<Record<string, { contentType: string; maxBytes: number }>> = {
    'screenreader-events': { contentType: 'application/json', maxBytes: 100_000_000 },
    'screenreader-document': { contentType: 'application/json', maxBytes: 100_000_000 },
    'screenreader-audio': { contentType: 'audio/wav', maxBytes: 1_000_000_000 },
    'screenreader-video': { contentType: 'video/webm', maxBytes: 1_000_000_000 },
  };
  const contract = contracts[value.name];
  if (
    !contract ||
    value.contentType !== contract.contentType ||
    value.bytes < 1 ||
    value.bytes > contract.maxBytes
  ) {
    throw new ScreenReaderProtocolError('invalid HooVDA artifact contract');
  }
  return { name: value.name, contentType: value.contentType, bytes: value.bytes, sha256: value.sha256 };
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

function verifyCursor(cursor: number, afterSequence: number, events: readonly ScreenReaderEvent[]): void {
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

function isHooVDAHealth(value: unknown): value is {
  protocolVersion: '2.0'; status: 'ok'; version: string; profile: 'nvda-web-2026.1.1';
  locale: 'en-US' | 'de-DE'; keyboardLayout: 'desktop' | 'laptop'; ready: true;
} {
  return (
    isObject(value) && value.protocolVersion === '2.0' && value.status === 'ok' &&
    typeof value.version === 'string' && value.version.length > 0 &&
    value.profile === 'nvda-web-2026.1.1' &&
    (value.locale === 'en-US' || value.locale === 'de-DE') &&
    (value.keyboardLayout === 'desktop' || value.keyboardLayout === 'laptop') && value.ready === true
  );
}

function isV1Capabilities(value: unknown): value is ScreenReaderCapabilities {
  if (!isObject(value) || value.protocolVersion !== 1 || !Array.isArray(value.actions)) return false;
  const seen = new Set<string>();
  return value.actions.every((item) => {
    if (!isObject(item) || typeof item.action !== 'string' || !(item.action in SCREEN_READER_ACTIONS) ||
      typeof item.label !== 'string' || item.label.length === 0 || seen.has(item.action)) return false;
    seen.add(item.action);
    return true;
  });
}

function isV1State(value: unknown): value is ScreenReaderState {
  if (!isObject(value) || value.protocolVersion !== 1 || !isSequence(value.lastSequence)) return false;
  const focus = value.focus;
  return isObject(focus) && typeof focus.browserWindowActive === 'boolean' &&
    typeof focus.webContentFocused === 'boolean' &&
    (typeof focus.role === 'string' || focus.role === null) &&
    (typeof focus.name === 'string' || focus.name === null);
}

function isHooVDAState(value: unknown): value is {
  lastSequence: number; browserWindowActive: boolean; webContentFocused: boolean;
  cursorInDocument: boolean; cursor: { mode: string };
} {
  return isObject(value) && isSequence(value.lastSequence) &&
    typeof value.browserWindowActive === 'boolean' && typeof value.webContentFocused === 'boolean' &&
    typeof value.cursorInDocument === 'boolean' &&
    isObject(value.cursor) && typeof value.cursor.mode === 'string';
}

function isSpeechCommand(value: unknown): value is { kind: string; value?: string } {
  return isObject(value) && typeof value.kind === 'string' &&
    (value.value === undefined || typeof value.value === 'string');
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
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
