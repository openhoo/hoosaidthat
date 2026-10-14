import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ScreenReaderSession } from '../src/session.js';
import { ScreenReaderProtocolError } from '../src/client.js';
import type { ScreenReaderObservation } from '../src/types.js';
import type { ReportSnapshot } from '../src/report.js';

interface ReturnToPageHarness {
  session: ScreenReaderSession;
  gestures(): number;
  setDocumentFocus(id: string, name: string | null): void;
  setPageURL(url: string): void;
}

function returnToPageHarness(initial: {
  webContentFocused: boolean;
  browserWindowActive?: boolean;
  role: string | null;
  name: string | null;
  id?: string;
  documentUrlSha256?: string;
}): ReturnToPageHarness {
  let webContentFocused = initial.webContentFocused;
  let browserWindowActive = initial.browserWindowActive ?? true;
  let role = initial.role;
  let name = initial.name;
  let id = initial.id;
  let documentUrlSha256 = initial.documentUrlSha256;
  let pageURL = 'about:blank';
  let gestures = 0;
  const session = Object.create(ScreenReaderSession.prototype) as ScreenReaderSession;
  Object.defineProperties(session, {
    page: {
      value: {
        bringToFront: async () => undefined,
        waitForTimeout: async () => undefined,
        title: async () => 'Exact focus fixture',
        url: () => pageURL,
      },
    },
    client: {
      value: {
        state: async () => ({
          focus: { id, documentUrlSha256, browserWindowActive, webContentFocused, role, name },
        }),
      },
    },
    options: { value: { quietMs: 0 } },
    act: {
      value: async () => {
        gestures += 1;
        webContentFocused = true;
        browserWindowActive = true;
        role = 'document web';
        name = 'Exact focus fixture';
        id = 'target-document';
        documentUrlSha256 = createHash('sha256').update(pageURL).digest('hex');
        return {};
      },
    },
  });
  return {
    session,
    gestures: () => gestures,
    setDocumentFocus: (nextId, nextName) => {
      id = nextId;
      name = nextName;
      role = 'document web';
      webContentFocused = true;
    },
    setPageURL: (url) => { pageURL = url; },
  };
}

test('returnToPage preserves focus when exact document and runtime agree', async () => {
  const harness = returnToPageHarness({
    webContentFocused: true,
    role: 'document web',
    name: 'Exact focus fixture',
    id: 'target-document',
  });

  await harness.session.returnToPage();

  assert.equal(harness.gestures(), 0);
});

test('returnToPage rejects stale document focus from another page', async () => {
  const harness = returnToPageHarness({
    webContentFocused: true,
    role: 'document web',
    name: 'Previous page',
  });

  await harness.session.returnToPage();

  assert.equal(harness.gestures(), 1);
});

test('returnToPage preserves native web-element focus', async () => {
  const harness = returnToPageHarness({
    webContentFocused: true,
    role: 'push button',
    name: 'Target button',
  });

  await harness.session.returnToPage();

  assert.equal(harness.gestures(), 0);
});

for (const role of ['document', 'Dokument', ' DOCUMENT ', 'Document Frame']) {
  test(`returnToPage verifies the active page title for native document role ${role}`, async () => {
    const harness = returnToPageHarness({
      webContentFocused: true, role, name: 'Previous page',
    });
    await harness.session.returnToPage();
    assert.equal(harness.gestures(), 1);
  });

  test(`returnToPage preserves matching native document role ${role}`, async () => {
    const harness = returnToPageHarness({
      webContentFocused: true, role, name: 'Exact focus fixture',
    });
    await harness.session.returnToPage();
    assert.equal(harness.gestures(), 0);
  });
}

for (const role of [null, '', '   ', 'unknown', ' UNKNOWN ', 'invalid']) {
  test(`returnToPage rejects unavailable native focus role ${JSON.stringify(role)}`, async () => {
    const harness = returnToPageHarness({
      webContentFocused: true, role, name: 'Exact focus fixture',
      documentUrlSha256: '4fa72d735a519ee13d4174f6b71c7ea92a1faa30cb445faf2dcacdf1ac343354',
    });
    await harness.session.returnToPage();
    assert.equal(harness.gestures(), 1);
  });
}

test('returnToPage rejects a nonbrowser interceptor reporting web focus', async () => {
  const harness = returnToPageHarness({
    webContentFocused: true, browserWindowActive: false,
    role: 'push button', name: 'Target button',
  });
  await harness.session.returnToPage();
  assert.equal(harness.gestures(), 1);
});

test('returnToPage preserves stable NVDA web-element role names', async () => {
  const harness = returnToPageHarness({
    webContentFocused: true, role: 'BUTTON', name: 'Target button',
  });
  await harness.session.returnToPage();
  assert.equal(harness.gestures(), 0);
});

test('returnToPage preserves previously verified document identity with transient empty name', async () => {
  const harness = returnToPageHarness({
    webContentFocused: true,
    role: 'document web',
    name: 'Exact focus fixture',
    id: 'target-document',
  });

  await harness.session.returnToPage();
  harness.setDocumentFocus('target-document', null);
  await harness.session.returnToPage();

  assert.equal(harness.gestures(), 0);
});

test('returnToPage rejects transient empty name from unknown document identity', async () => {
  const harness = returnToPageHarness({
    webContentFocused: true,
    role: 'document web',
    name: 'Exact focus fixture',
    id: 'target-document',
  });

  await harness.session.returnToPage();
  harness.setDocumentFocus('other-document', null);
  await harness.session.returnToPage();

  assert.equal(harness.gestures(), 1);
});

test('returnToPage verifies transient document through page URL digest', async () => {
  const harness = returnToPageHarness({
    webContentFocused: true,
    role: 'document web',
    name: null,
    id: 'transient-document',
    documentUrlSha256: '4fa72d735a519ee13d4174f6b71c7ea92a1faa30cb445faf2dcacdf1ac343354',
  });

  await harness.session.returnToPage();

  assert.equal(harness.gestures(), 0);
});

test('returnToPage rejects document from different page URL digest', async () => {
  const harness = returnToPageHarness({
    webContentFocused: true,
    role: 'document web',
    name: null,
    id: 'other-document',
    documentUrlSha256: '0'.repeat(64),
  });

  await harness.session.returnToPage();

  assert.equal(harness.gestures(), 1);
});

test('returnToPage rejects stale web-element focus from another document URL', async () => {
  const harness = returnToPageHarness({
    webContentFocused: true, role: 'push button', name: 'Previous page button',
    id: 'previous-button', documentUrlSha256: '0'.repeat(64),
  });
  await harness.session.returnToPage();
  assert.equal(harness.gestures(), 1);
});

test('returnToPage expires a verified native document identity after navigation', async () => {
  const harness = returnToPageHarness({
    webContentFocused: true, role: 'document web', name: 'Exact focus fixture',
    id: 'reused-document',
  });
  await harness.session.returnToPage();
  harness.setPageURL('https://example.test/next');
  harness.setDocumentFocus('reused-document', null);
  await harness.session.returnToPage();
  assert.equal(harness.gestures(), 1);
});

test('protocol v2 scan does not confuse page text with a navigation boundary', async () => {
  const session = Object.create(ScreenReaderSession.prototype) as ScreenReaderSession;
  let actions = 0;
  Object.defineProperties(session, {
    health: { value: { protocolVersion: 2 } },
    act: { value: async () => {
      actions += 1;
      const text = 'No more delays heading level 1';
      const event = { kind: 'speech' as const, sequence: actions, monotonicNs: actions,
        command: 'nextHeading', text, source: { bus: ':1.2', path: `/heading/${actions}` } };
      return { action: 'nextHeading', label: 'Next heading', events: [event],
        speechEvents: [event], brailleEvents: [], speech: text, braille: '', timedOut: false } satisfies ScreenReaderObservation;
    } },
  });
  const result = await session.scan({ action: 'nextHeading', name: 'headings', max: 2 });
  assert.equal(result.observations.length, 2);
  assert.equal(result.stopReason, 'max');
});

test('expanded page capture rejects unavailable actions before moving the native cursor', async () => {
  const session = Object.create(ScreenReaderSession.prototype) as ScreenReaderSession;
  let actions = 0;
  Object.defineProperties(session, {
    health: { value: { screenReader: { name: 'orca' } } },
    supportedActions: { value: new Set(['documentStart', 'nextHeading', 'previousHeading']) },
    act: { value: async () => { actions += 1; throw new Error('unexpected cursor movement'); } },
  });
  await assert.rejects(() => session.capturePageElements(), /does not support.*capturePageElements/);
  assert.equal(actions, 0);
});

for (const [command, reason, provenance, shouldAssociate] of [
  ['event', undefined, undefined, false],
  ['nextFocusable', 'liveRegion', 'screenReaderOutput', false],
  ['readCurrent', 'liveRegion', 'screenReaderOutput', false],
  ['nextFocusable', 'nativeStateChange', 'screenReaderOutput', false],
  ['nextFocusable', 'nativeFocus', 'accessibilityEvent', false],
  ['nextFocusable', 'nativeFocus', 'screenReaderOutput', true],
  ['readCurrent', 'report', 'screenReaderOutput', true],
  ['nextFocusable', 'report', 'screenReaderOutput', false],
  ['nextFocusable', undefined, undefined, true],
] as const) test(`explicit focus report fallback filters ${command}/${reason ?? 'absent'}/${provenance ?? 'absent'}`, async () => {
  const speech = { kind: 'speech' as const, sequence: 1, monotonicNs: 1,
    command, ...(reason ? { reason } : {}), ...(provenance ? { provenance } : {}),
    text: 'Observed output' };
  const observation = { action: 'nextFocusable' as const, label: 'Next focusable element',
    events: [speech], speechEvents: [speech], brailleEvents: [],
    speech: speech.text, braille: '', timedOut: false };
  const snapshot: ReportSnapshot = { index: 1, observation, width: 800, height: 600,
    image: 'data:image/png;base64,placeholder', annotations: [{ speech }] };
  const session = Object.create(ScreenReaderSession.prototype) as ScreenReaderSession;
  Object.defineProperties(session, {
    entries: { value: [{ index: 1, observation }] },
    reportSnapshots: { value: [snapshot] },
    show: { value: async () => undefined },
  });
  const internal = session as unknown as { relabelLastObservation: (
    observation: ScreenReaderObservation, action: 'focus', label: string,
    locator: { boundingBox: () => Promise<{ x: number; y: number; width: number; height: number }> },
  ) => Promise<ScreenReaderObservation> };
  await internal.relabelLastObservation(observation, 'focus', 'Focus target', {
    boundingBox: async () => ({ x: 100, y: 100, width: 40, height: 20 }),
  });
  assert.deepEqual(snapshot.annotations[0]?.bounds,
    shouldAssociate ? { x: 100, y: 100, width: 40, height: 20 } : undefined);
  assert.equal(snapshot.annotations[0]?.association,
    shouldAssociate ? 'explicit-focus-target' : undefined);
});

test('report snapshot remains available when optional native geometry fails', async () => {
  const session = Object.create(ScreenReaderSession.prototype) as ScreenReaderSession;
  const observation: ScreenReaderObservation = { action: 'nextHeading', label: 'Next heading',
    events: [], speechEvents: [], brailleEvents: [], speech: '', braille: '', timedOut: false };
  const snapshots: ReportSnapshot[] = [];
  let screenshots = 0;
  Object.defineProperties(session, {
    page: { value: {
      evaluate: async () => ({ width: 800, height: 600 }),
      screenshot: async () => { screenshots += 1; return Buffer.from('image'); },
      frames: () => [], url: () => 'https://example.test/',
    } },
    client: { value: { reportDocument: async () => { throw new Error('geometry unavailable'); } } },
    options: { value: { webReport: 'on', actionScreenshots: 'off' } },
    entries: { value: [] }, reportSnapshots: { value: snapshots },
    show: { value: async () => undefined },
  });
  const internal = session as unknown as { afterObservation: (value: ScreenReaderObservation) => Promise<void> };
  await internal.afterObservation(observation);
  assert.equal(screenshots, 1);
  assert(snapshots[0]?.image);
  assert.equal(snapshots[0]?.error, undefined);
});

test('report snapshot retains speech and image when overlay rendering fails', async () => {
  const session = Object.create(ScreenReaderSession.prototype) as ScreenReaderSession;
  const observation: ScreenReaderObservation = { action: 'nextHeading', label: 'Next heading',
    events: [], speechEvents: [], brailleEvents: [], speech: '', braille: '', timedOut: false };
  const snapshots: ReportSnapshot[] = [];
  Object.defineProperties(session, {
    page: { value: {
      evaluate: async () => ({ width: 800, height: 600 }),
      screenshot: async () => Buffer.from('image'), frames: () => [], url: () => 'https://example.test/',
    } },
    client: { value: { reportDocument: async () => undefined } },
    options: { value: { webReport: 'on', actionScreenshots: 'off' } },
    entries: { value: [] }, reportSnapshots: { value: snapshots },
    show: { value: async () => { throw new Error('overlay context destroyed'); } },
  });
  const internal = session as unknown as { afterObservation: (value: ScreenReaderObservation) => Promise<void> };
  await assert.rejects(() => internal.afterObservation(observation), /overlay context destroyed/);
  assert.equal(snapshots.length, 1);
  assert(snapshots[0]?.image);
  assert.equal(snapshots[0]?.observation, observation);
});

test('finish retains the portable webpage report when recording artifact download fails', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hoosaidthat-report-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const attachments: string[] = [];
  const session = Object.create(ScreenReaderSession.prototype) as ScreenReaderSession;
  Object.defineProperties(session, {
    page: { value: { isClosed: () => true } },
    client: { value: { finishSession: async () => { throw new Error('recording download failed'); } } },
    health: { value: { protocolVersion: 2, status: 'ready', platform: 'linux', screenReader: {
      name: 'hoovda', version: 'test', capture: 'hoovda-structured-presentation',
    } } },
    options: { value: { webReport: 'on' } },
    entries: { value: [] }, reportSnapshots: { value: [] },
    testInfo: { value: { title: 'Retained report',
      outputPath: (...parts: string[]) => join(directory, ...parts),
      attach: async (name: string) => { attachments.push(name); },
    } },
  });
  await assert.rejects(() => session.finish(), /recording download failed/);
  assert(attachments.includes('screen-reader-report.html'));
  assert(attachments.includes('screen-reader-flow.json'));
});

test('finish attaches verified partial artifacts before reporting a download failure', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hoosaidthat-partial-artifacts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const body = Buffer.from('{"audioTimeline":[]}');
  const artifact = { name: 'screenreader-events', contentType: 'application/json', body,
    bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
  const error = new ScreenReaderProtocolError('video unavailable', 503, [artifact]);
  const attachments: string[] = [];
  const session = Object.create(ScreenReaderSession.prototype) as ScreenReaderSession;
  Object.defineProperties(session, {
    page: { value: { isClosed: () => true } },
    client: { value: { finishSession: async () => { throw error; } } },
    health: { value: { protocolVersion: 2, status: 'ready', platform: 'linux', screenReader: {
      name: 'hoovda', version: 'test', capture: 'hoovda-structured-presentation',
    } } },
    options: { value: { webReport: 'on' } }, entries: { value: [] }, reportSnapshots: { value: [] },
    testInfo: { value: { title: 'Partial evidence', outputPath: (...parts: string[]) => join(directory, ...parts),
      attach: async (name: string) => { attachments.push(name); },
    } },
  });
  await assert.rejects(() => session.finish(), failure => failure === error);
  assert(attachments.includes('screenreader-events'));
  assert(attachments.includes('screen-reader-report.html'));
  assert.deepEqual(await readFile(join(directory, 'screenreader', 'screenreader-events.json')), body);
});

test('finish retains captured flow evidence when an ARIA snapshot is unavailable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hoosaidthat-aria-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const attachments: string[] = [];
  const session = Object.create(ScreenReaderSession.prototype) as ScreenReaderSession;
  Object.defineProperties(session, {
    page: { value: { isClosed: () => false } },
    client: { value: { finishSession: async () => [] } },
    health: { value: { protocolVersion: 2, screenReader: { name: 'hoovda', version: 'test' } } },
    options: { value: { webReport: 'off' } }, entries: { value: [] },
    captureAriaSnapshot: { value: async () => { throw new Error('page navigating'); } },
    testInfo: { value: { outputPath: (...parts: string[]) => join(directory, ...parts),
      attach: async (name: string) => { attachments.push(name); },
    } },
  });
  await assert.rejects(() => session.finish(), /page navigating/);
  assert(attachments.includes('screen-reader-flow.txt'));
  assert(attachments.includes('screen-reader-flow.json'));
});
