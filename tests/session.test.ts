import assert from 'node:assert/strict';
import test from 'node:test';
import { ScreenReaderSession } from '../src/session.js';

interface ReturnToPageHarness {
  session: ScreenReaderSession;
  gestures(): number;
  setDocumentFocus(id: string, name: string | null): void;
}

function returnToPageHarness(initial: {
  webContentFocused: boolean;
  role: string;
  name: string | null;
  id?: string;
  documentUrlSha256?: string;
}): ReturnToPageHarness {
  let webContentFocused = initial.webContentFocused;
  let role = initial.role;
  let name = initial.name;
  let id = initial.id;
  let documentUrlSha256 = initial.documentUrlSha256;
  let gestures = 0;
  const session = Object.create(ScreenReaderSession.prototype) as ScreenReaderSession;
  Object.defineProperties(session, {
    page: {
      value: {
        bringToFront: async () => undefined,
        waitForTimeout: async () => undefined,
        title: async () => 'Exact focus fixture',
        url: () => 'about:blank',
      },
    },
    client: {
      value: {
        state: async () => ({
          focus: { id, documentUrlSha256, webContentFocused, role, name },
        }),
      },
    },
    options: { value: { quietMs: 0 } },
    act: {
      value: async () => {
        gestures += 1;
        webContentFocused = true;
        role = 'document web';
        name = 'Exact focus fixture';
        id = 'target-document';
        documentUrlSha256 = '4fa72d735a519ee13d4174f6b71c7ea92a1faa30cb445faf2dcacdf1ac343354';
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
