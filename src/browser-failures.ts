import { createHmac, randomBytes } from 'node:crypto';
import type { Page, Request, Response, TestInfo } from '@playwright/test';

const active = new WeakMap<Page, () => void>();
const extensions = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'svg', 'css', 'html', 'json', 'wasm', 'png', 'jpg', 'webp', 'woff', 'woff2']);
const errorNames = new Set(['Error', 'TypeError', 'SyntaxError', 'ReferenceError', 'RangeError', 'URIError', 'EvalError', 'AggregateError']);

export function markReaderGesture(page: Page): void { active.get(page)?.(); }

/** Collect metadata while the test owns the page. Never request another page load. */
export function watchBrowserFailures(page: Page) {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  let firstReaderGestureAtMs: number | null = null;
  active.set(page, () => { firstReaderGestureAtMs ??= elapsed(); });
  const events: Record<string, string | number | boolean>[] = [];
  const seen = { documentOrScript: 0, other: 0 };
  // IDs relate repeated requests within this attempt, without disclosing URLs
  // or supporting dictionary attacks using a published hash of a private path.
  const key = randomBytes(32);
  function resource(url: string) {
    if (url.length > 8192 || !/^https?:\/\//i.test(url)) return {};
    let parsed: URL;
    try { parsed = new URL(url); } catch { return {}; }
    const extension = /\.([a-z0-9]{1,5})$/i.exec(parsed.pathname)?.[1]?.toLowerCase();
    return {
      resourceId: createHmac('sha256', key).update(url).digest('hex').slice(0, 16),
      ...(extension && extensions.has(extension) ? { extension } : {}),
      ...(parsed.searchParams.has('import') ? { importQuery: true } : {}),
    };
  }
  function reserve(important: boolean) {
    // Keep the earliest document/script failures even after a burst of unrelated failures.
    return important ? ++seen.documentOrScript <= 16 : ++seen.other <= 8;
  }
  const moment = () => ({ elapsedMs: elapsed(), beforeFirstReaderGesture: firstReaderGestureAtMs === null });
  function record(request: Request, details: { kind: 'http-error'; status: number } | { kind: 'request-failed'; code: string }) {
    const resourceType = request.resourceType();
    if (reserve(resourceType === 'document' || resourceType === 'script')) {
      events.push({ ...moment(), ...details, resourceType, ...resource(request.url()) });
    }
  }
  const failed = (request: Request) => {
    const text = request.failure()?.errorText ?? '';
    const code = /^(?:net::)?(ERR_[A-Z0-9_]{1,64})(?:$|[ ;])/.exec(text)?.[1] ?? 'unknown';
    record(request, { kind: 'request-failed', code });
  };
  const response = (response: Response) => {
    if (response.status() >= 400) record(response.request(), { kind: 'http-error', status: response.status() });
  };
  const pageError = (error: Error) => {
    if (reserve(false)) events.push({ ...moment(), kind: 'page-error', name: errorNames.has(error.name) ? error.name : 'Error' });
  };
  page.on('requestfailed', failed);
  page.on('response', response);
  page.on('pageerror', pageError);
  return async function finish(testInfo: Pick<TestInfo, 'testId' | 'status' | 'retry' | 'attach'>): Promise<void> {
    active.delete(page);
    page.off('requestfailed', failed);
    page.off('response', response);
    page.off('pageerror', pageError);
    if (testInfo.status !== 'failed' && testInfo.status !== 'timedOut' && testInfo.status !== 'interrupted') return;
    const report = {
      schemaVersion: 1, testId: testInfo.testId, retry: testInfo.retry, status: testInfo.status, firstReaderGestureAtMs,
      seen, omitted: seen.documentOrScript + seen.other - events.length, events,
    };
    await testInfo.attach('screen-reader-browser-failures.json', {
      contentType: 'application/json', body: Buffer.from(JSON.stringify(report, null, 2)),
    });
  };
}
