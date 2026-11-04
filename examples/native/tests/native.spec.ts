import { expect, test } from '../../../src/index.js';

const markup = `<html lang="en"><title>Native screen reader check</title>
<h1>Start</h1><main><h2>Checkout summary</h2>
<button id="continue">Continue checkout</button>
<div role="status" id="status" aria-live="polite"></div>
<script>document.getElementById('continue').onclick = () => {
  setTimeout(() => document.getElementById('status').textContent = 'Checkout is ready', 500);
};</script></main></html>`;

test('native heading and keyboard focus produce reader speech', async ({ page, screenReader }) => {
  await page.goto(`data:text/html,${encodeURIComponent(markup)}`);
  await screenReader.returnToPage();
  await screenReader.documentStart();
  await screenReader.nextHeading();
  await expect(screenReader).toHaveSpoken(/Checkout summary/i);
  await screenReader.focus(page.getByRole('button', { name: 'Continue checkout' }));
  await expect(screenReader).toHaveSpoken(/Continue checkout/i);
});

test('native speech captures a live region from an ordinary page action', async ({ page, screenReader }) => {
  await page.goto(`data:text/html,${encodeURIComponent(markup)}`);
  await screenReader.returnToPage();
  await screenReader.focus(page.getByRole('button', { name: 'Continue checkout' }));
  const checkpoint = await screenReader.checkpoint();
  await screenReader.observe('Checkout status', async () => {
    await page.getByRole('button', { name: 'Continue checkout' }).click();
  });
  await expect.poll(async () => {
    const observation = await screenReader.readFrom(checkpoint, 'Await checkout announcement');
    return observation.speech;
  }, { timeout: 15000 }).toMatch(/Checkout is ready/i);
});
