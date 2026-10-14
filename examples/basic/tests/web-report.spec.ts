import { expect, test } from '@openhoo/hoosaidthat';

test.skip(process.env.SCREEN_READER_WEB_REPORT !== 'on', 'Run the dedicated test:e2e:report gate to capture website reports.');

test('annotated website report records changing states and actual reader output', async ({ page, screenReader }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await screenReader.returnToPage();
  await screenReader.documentStart();
  await screenReader.nextHeading();
  await expect(screenReader).toHaveSpoken(/Checkout.*heading/i);
  await screenReader.focus(page.getByRole('textbox', { name: 'Email', exact: true }), 'Email field');
  await screenReader.focus(page.getByRole('button', { name: 'Continue' }), 'Continue to review');
  await screenReader.activate();
  await expect(screenReader).toHaveSpoken(/Order review ready/i);
  await expect(page.getByText('Order review ready', { exact: true })).toBeVisible();
  await screenReader.observe('Open order review dialog', async () => {
    await page.evaluate(() => {
      const dialog = document.createElement('dialog');
      dialog.setAttribute('aria-label', 'Order review');
      dialog.innerHTML = '<h2>Order review</h2><p>Your order is ready.</p><button type="button">Close review</button>';
      document.body.append(dialog);
      dialog.showModal();
    });
  });
  await expect(page.getByRole('dialog', { name: 'Order review', exact: true })).toBeVisible();
  await screenReader.focus(page.getByRole('button', { name: 'Close review' }), 'Dialog close button');
  await expect(screenReader).toHaveSpoken(/Close review.*button/i);
  // Teardown writes the portable HTML with exact samples from finished artifacts.
});
