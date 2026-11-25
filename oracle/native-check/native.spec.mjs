import { expect, test } from '@openhoo/hoosaidthat';
const markup = `<html lang="en"><title>Native screen reader check</title>
<h1>Order instructions</h1><p>Review the order before continuing.</p><main><h2>Checkout summary</h2>
<button id="continue">Continue checkout</button><div role="status" aria-live="polite" id="status"></div>
<script>document.getElementById('continue').onclick=()=>setTimeout(()=>document.getElementById('status').textContent='Checkout is ready',500);</script></main></html>`;
// Both NVDA output hooks report asynchronously. A late display write is
// evidence only after this command started and only if it has real cells.
async function expectNativeFrame(client, cursor, command, expected) {
  await expect.poll(async () => {
    const { events } = await client.readEvents(cursor, { timeoutMs: 400, quietMs: 80 });
    const started = events.find(event => event.kind === 'commandStarted' && event.command === command);
    if (!started) return '';
    const frame = events.filter(event => event.kind === 'braille' && event.sequence > started.sequence).at(-1);
    return frame?.provenance === 'screenReaderOutput' && !frame.redacted && frame.cells.some(cell => cell !== 0)
      ? frame.text : '';
  }, { timeout: 8000, message: `NVDA display after ${command}` }).toMatch(expected);
}

test('native heading and keyboard focus produce reader speech', async ({ page, screenReader, screenReaderClient, screenReaderResolvedOptions }) => {
  await page.goto(`data:text/html,${encodeURIComponent(markup)}`);
  await screenReader.returnToPage();
  const nvda = screenReaderResolvedOptions.screenReader === 'nvda';
  if (nvda) await screenReader.ensureBrowseMode();
  const beforeStart = nvda ? await screenReader.checkpoint() : 0;
  await screenReader.documentStart();
  if (nvda) await expectNativeFrame(screenReaderClient, beforeStart, 'documentStart', /Order instructions/i);
  const beforeHeading = nvda ? await screenReader.checkpoint() : 0;
  await screenReader.nextHeading();
  await expect(screenReader).toHaveSpoken(/Checkout summary/i);
  if (nvda) await expectNativeFrame(screenReaderClient, beforeHeading, 'nextHeading', /Checkout summary/i);
  await screenReader.focus(page.getByRole('button', { name:'Continue checkout' }));
  await expect(screenReader).toHaveSpoken(/Continue checkout/i);
});
test('native reader captures an asynchronous live region', async ({ page, screenReader }) => {
  await page.goto(`data:text/html,${encodeURIComponent(markup)}`);
  await screenReader.returnToPage();
  await screenReader.focus(page.getByRole('button', { name:'Continue checkout' }));
  const checkpoint = await screenReader.checkpoint();
  await screenReader.observe('Checkout status', async () => page.getByRole('button', { name:'Continue checkout' }).click());
  await expect.poll(async () => {
    const observation = await screenReader.readFrom(checkpoint, 'Await checkout announcement');
    return observation.speech;
  }, { timeout: 15000 }).toMatch(/Checkout is ready/i);
});
