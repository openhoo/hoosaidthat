import assert from 'node:assert/strict';
import test from 'node:test';
import { ScreenReaderSession } from '../src/session.js';

interface ReturnToPageHarness {
  session: ScreenReaderSession;
  gestures(): number;
}

function returnToPageHarness(initial: {
  webContentFocused: boolean;
  role: string;
  name: string;
}): ReturnToPageHarness {
  let webContentFocused = initial.webContentFocused;
  let role = initial.role;
  let name = initial.name;
  let gestures = 0;
  const session = Object.create(ScreenReaderSession.prototype) as ScreenReaderSession;
  Object.defineProperties(session, {
    page: {
      value: {
        bringToFront: async () => undefined,
        waitForTimeout: async () => undefined,
        title: async () => 'Exact focus fixture',
      },
    },
    client: {
      value: {
        state: async () => ({ focus: { webContentFocused, role, name } }),
      },
    },
    options: { value: { quietMs: 0 } },
    act: {
      value: async () => {
        gestures += 1;
        webContentFocused = true;
        role = 'document web';
        name = 'Exact focus fixture';
        return {};
      },
    },
  });
  return { session, gestures: () => gestures };
}

test('returnToPage preserves focus when exact document and runtime agree', async () => {
  const harness = returnToPageHarness({
    webContentFocused: true,
    role: 'document web',
    name: 'Exact focus fixture',
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
