import { expect, test } from '@openhoo/hoosaidthat';

test('real screen reader announces structure, controls, and updates', async ({
  page,
  screenReader,
}) => {
  await page.goto('/');

  await screenReader.returnToPage();
  await screenReader.nextHeading();
  await expect(screenReader).toHaveSpoken(/Checkout.*heading/i);
  await screenReader.captureCurrent(
    'checkout-heading',
    page.getByRole('heading', { name: 'Checkout' }),
  );

  const [email, continueButton] = await screenReader.captureElements([
    { name: 'email', locator: page.getByLabel('Email') },
    {
      name: 'continue-button',
      locator: page.getByRole('button', { name: 'Continue' }),
    },
  ]);
  expect(email?.speech).toMatch(/Email.*(entry|edit)/i);
  expect(continueButton?.speech).toMatch(/Continue.*button/i);
  await expect(screenReader).toHaveSpoken(/Continue.*button/i);

  await screenReader.activate();
  await expect(screenReader).toHaveSpoken(/Order review ready/i);
  expect(screenReader.spokenText()).not.toContain('Receipt timestamp updated');

  expect(screenReader.transcript()).toContain('Order review ready');
  if (screenReader.health.screenReader.name === 'hoovda') {
    expect(screenReader.transcript()).toMatchSnapshot('checkout-flow.hoovda.txt');
  }
});

test('exports screen reader output images for page structures', async ({
  page,
  screenReader,
}) => {
  test.skip(
    screenReader.health.screenReader.name !== 'hoovda',
    'HooVDA page export requires documentStart and expanded quick navigation',
  );
  await page.goto('/');
  await screenReader.returnToPage();

  const results = await screenReader.capturePageElements({
    maxPerKind: 10,
    screenshots: true,
  });
  expect(results.headings.observations.some(({ speech }) => /Checkout.*heading/i.test(speech))).toBe(true);
  expect(results.buttons.observations.some(({ speech }) => /Continue.*button/i.test(speech))).toBe(true);
  expect(results.landmarks.observations.length).toBeGreaterThan(0);
  expect(results['form-fields'].observations.some(({ speech }) => /Email.*(entry|edit)/i.test(speech))).toBe(true);
  expect(results.links.observations.some(({ speech }) => /Skip to checkout.*link/i.test(speech))).toBe(true);
  expect(results.lists.observations.some(({ speech }) => /list/i.test(speech))).toBe(true);
  expect(results.tables.observations.some(({ speech }) => /Order totals.*table/i.test(speech))).toBe(true);
  expect(results.graphics.observations.some(({ speech }) => /OpenHoo parcel mark.*(image|graphic)/i.test(speech))).toBe(true);
  for (const result of Object.values(results)) {
    expect(result.screenshots).toHaveLength(result.observations.length);
    expect(result.stoppedOnBoundary).toBe(true);
  }
  expect(screenReader.transcript()).toMatchSnapshot('page-elements.hoovda.txt');
});
