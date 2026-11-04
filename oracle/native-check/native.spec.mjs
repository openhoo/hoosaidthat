import { expect, test } from '@openhoo/hoosaidthat';
const markup = `<html lang="en"><title>Native screen reader check</title>
<h1>Start</h1><main><h2>Checkout summary</h2>
<button id="continue">Continue checkout</button><div role="status" aria-live="polite" id="status"></div>
<script>document.getElementById('continue').onclick=()=>setTimeout(()=>document.getElementById('status').textContent='Checkout is ready',500);</script></main></html>`;
test('native heading and keyboard focus produce reader speech', async ({ page, screenReader }) => {
  await page.goto(`data:text/html,${encodeURIComponent(markup)}`);
  await screenReader.returnToPage();
  await screenReader.documentStart();
  await screenReader.nextHeading();
  await expect(screenReader).toHaveSpoken(/Checkout summary/i);
  await screenReader.focus(page.getByRole('button', { name:'Continue checkout' }));
  await expect(screenReader).toHaveSpoken(/Continue checkout/i);
});
test('native reader captures an asynchronous live region', async ({ page, screenReader }) => {
  await page.goto(`data:text/html,${encodeURIComponent(markup)}`);
  await screenReader.returnToPage();
  await screenReader.focus(page.getByRole('button', { name:'Continue checkout' }));
  await screenReader.observe('Checkout status', async () => page.getByRole('button', { name:'Continue checkout' }).click());
  await expect(screenReader).toHaveSpoken(/Checkout is ready/i);
});
