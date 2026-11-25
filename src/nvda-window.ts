import type { Page } from '@playwright/test';

/** Keep the test browser inside the Windows desktop work area. */
export async function fitNvdaWindow(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { windowId, bounds } = await cdp.send('Browser.getWindowForTarget');
    // Windows itself positions maximized and fullscreen windows; their frame
    // can legitimately extend a few pixels past the work area.
    if (bounds.windowState && bounds.windowState !== 'normal') return;
    const { left, top, width, height } = bounds;
    if (left === undefined || top === undefined || width === undefined || height === undefined) {
      throw new Error('Chrome did not report the Windows test window bounds');
    }
    const work = await page.evaluate(() => {
      const display = window.screen as Screen & { availLeft: number; availTop: number };
      return { left: display.availLeft, top: display.availTop, width: display.availWidth, height: display.availHeight };
    });
    if (!Object.values(work).every(Number.isFinite) || work.width <= 0 || work.height <= 0) {
      throw new Error('Chrome did not report the Windows display work area');
    }
    const w = Math.min(width, work.width);
    const h = Math.min(height, work.height);
    const x = Math.max(work.left, Math.min(left, work.left + work.width - w));
    const y = Math.max(work.top, Math.min(top, work.top + work.height - h));
    if (x !== left || y !== top || w !== width || h !== height) {
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: x, top: y, width: w, height: h } });
    }
  } finally {
    await cdp.detach();
  }
}
