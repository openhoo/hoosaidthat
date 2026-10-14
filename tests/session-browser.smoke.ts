import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, type Page, type TestInfo } from '@playwright/test';
import { ScreenReaderSession } from '../src/session.js';

// Explicit browser smoke: excluded from the default *.test.js unit gate.
function screenshotSession(page: Page, directory: string, overlay: boolean): ScreenReaderSession {
  const session = Object.create(ScreenReaderSession.prototype) as ScreenReaderSession;
  Object.defineProperties(session, {
    page: { value: page },
    options: { value: { overlay, actionTimeoutMs: 5_000 } },
    screenshotIndex: { value: 0, writable: true },
    entries: { value: [] },
    testInfo: { value: {
      outputPath: (...parts: string[]) => join(directory, ...parts),
      attach: async () => undefined,
    } satisfies Pick<TestInfo, 'outputPath' | 'attach'> },
  });
  return session;
}

test('element evidence preserves page styles, cleans failed overlays, and masks frame passwords', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const directory = await mkdtemp(join(tmpdir(), 'hoosaidthat-session-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const page = await browser.newPage();
  page.setDefaultTimeout(5_000);
  await page.setContent(`<button id="target" style="outline: 2px solid green !important; outline-offset: 3px !important">Target</button>
    <input id="main-secret" autocomplete="section-login current-password" value="never-visible">
    <iframe srcdoc='<input id="frame-secret" type="password" value="also-private"><input autocomplete="section-change new-password" value="iframe-secret-text">'></iframe>`);
  const session = screenshotSession(page, directory, true);
  await session.captureCurrent('highlight', page.locator('#target'));
  const priorities = await page.locator('#target').evaluate(element => [
    (element as HTMLElement).style.getPropertyPriority('outline'),
    (element as HTMLElement).style.getPropertyPriority('outline-offset'),
  ]);
  assert.deepEqual(priorities, ['important', 'important']);
  const screenshot = page.screenshot.bind(page);
  page.screenshot = async (options) => {
    await page.locator('#target').evaluate(element => {
      const replacement = document.createElement('button');
      replacement.id = 'target';
      replacement.textContent = 'Replacement';
      replacement.style.setProperty('outline', '2px solid red', 'important');
      element.replaceWith(replacement);
    });
    return await screenshot(options);
  };
  try {
    await session.captureCurrent('replacement', page.locator('#target'));
  } finally {
    page.screenshot = screenshot;
  }
  assert.equal(await page.locator('#target').evaluate(element =>
    (element as HTMLElement).style.getPropertyValue('outline')), 'red solid 2px');
  const aria = await session.captureAriaSnapshot();
  assert(!aria.includes('never-visible'));
  const framedAria = await session.captureAriaSnapshot('frame', page.frameLocator('iframe').locator('body'));
  assert(!framedAria.includes('iframe-secret-text'), 'Explicit iframe ARIA captures redact password autocomplete values');
  const image = await session.captureCurrent('secrets');
  const imageData = `data:image/png;base64,${(await readFile(image)).toString('base64')}`;
  const main = await page.locator('#main-secret').boundingBox();
  const framed = await page.frameLocator('iframe').locator('#frame-secret').boundingBox();
  assert(main && framed);
  const colors = await page.evaluate(async ({ imageData, points }) => {
    const image = new Image();
    image.src = imageData;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    return points.map(({ x, y }) => [...context.getImageData(x, y, 1, 1).data]);
  }, { imageData, points: [main, framed].map(bounds => ({ x: bounds.x + 5, y: bounds.y + 5 })) });
  assert.deepEqual(colors, [[255, 0, 255, 255], [255, 0, 255, 255]]);
  const temporaryOverlaySession = screenshotSession(page, directory, false);
  page.setDefaultTimeout(300);
  await assert.rejects(() => temporaryOverlaySession.captureCurrent('missing', page.locator('#missing')));
  assert.equal(await page.locator('#__hoosaidthat_screenreader_overlay__').count(), 0);
});

