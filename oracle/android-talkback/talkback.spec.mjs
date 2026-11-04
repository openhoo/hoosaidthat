import { expect, test } from '@openhoo/hoosaidthat';

const markup = `<html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>TalkBack checkout</title><h1>Start</h1><main><h2>Checkout summary</h2>
<a href="#continue">Checkout link</a><button id="continue">Continue checkout</button>
<div role="status" aria-live="polite" id="status"></div>
<script>document.getElementById('continue').onclick=()=>setTimeout(()=>document.getElementById('status').textContent='Checkout is ready',500);</script>
</main></html>`;

test('real TalkBack navigates headings and activates a button', async ({ page, screenReader }) => {
  await page.goto(`data:text/html,${encodeURIComponent(markup)}`);
  await screenReader.returnToPage();
  await screenReader.documentStart();
  await screenReader.nextHeading();
  await expect(screenReader).toHaveSpoken(/Checkout summary/i);
  await screenReader.nextButton();
  await expect(screenReader).toHaveSpoken(/Continue checkout/i);
  await screenReader.activate();
  await expect(screenReader).toHaveSpoken(/Checkout is ready/i);
});

test('real TalkBack captures asynchronous live-region speech', async ({ page, screenReader }) => {
  await page.goto(`data:text/html,${encodeURIComponent(markup)}`);
  await screenReader.returnToPage();
  await screenReader.observe('Checkout status', async () => {
    await page.getByRole('button', { name: 'Continue checkout' }).click();
  });
  await expect(screenReader).toHaveSpoken(/Checkout is ready/i);
});
