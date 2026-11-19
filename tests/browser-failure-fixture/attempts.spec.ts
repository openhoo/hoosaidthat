import { test as readerTest, expect } from '../../src/index.js';

// Exercise the public page fixture; native speech is not involved in this failure.
const test = readerTest.extend({
  browser: [async ({ playwright }, use) => {
    const browser = await playwright.chromium.launch();
    try { await use(browser); } finally { await browser.close(); }
  }, { scope: 'worker' }],
});

test('a failed module leaves the shell loaded', async ({ page }, testInfo) => {
  await page.route('**/*', async route => {
    if (route.request().resourceType() === 'document') {
      return await route.fulfill({ contentType: 'text/html',
        body: '<h1>Shell</h1><script type="module" src="/private-name.svg?import&token=sensitive-query"></script>' });
    }
    if (testInfo.retry === 0) return await route.abort('internetdisconnected');
    return await route.fulfill({ contentType: 'text/javascript', body: "document.querySelector('h1').textContent = 'Ready'" });
  });
  await page.goto('https://private-host.invalid/');
  await expect(page.getByRole('heading')).toHaveText('Ready', { timeout: 300 });
});
