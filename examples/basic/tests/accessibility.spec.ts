import { expect, test } from '@openhoo/hoosaidthat';

test('real screen reader announces structure, controls, and updates', async ({
  page,
  screenReader,
}) => {
  await page.goto('/');

  await screenReader.returnToPage();
  await screenReader.documentStart();
  const firstHeading = await screenReader.nextHeading();
  await expect(screenReader).toHaveSpoken(/Checkout.*heading/i);
  expect(firstHeading.speech).toMatch(/Checkout.*heading/i);
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

  if (screenReader.health.screenReader.name === 'hoovda') {
    const details = await screenReader.reportDetails();
    expect(details.speech).toBe('Payment continues only after order review.');
    expect(details.braille).toBe('Payment continues only after order review.');
  }

  await screenReader.activate();
  await expect(screenReader).toHaveSpoken(/Order review ready/i);
  expect(screenReader.spokenText()).not.toContain('Receipt timestamp updated');

  expect(screenReader.transcript()).toContain('Order review ready');
  if (screenReader.health.screenReader.name === 'hoovda') {
    expect(screenReader.regressionTranscript()).toMatchSnapshot('checkout-flow.hoovda.txt');
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
  expect(screenReader.regressionTranscript()).toMatchSnapshot('page-elements.hoovda.txt');
});

test('matches pinned NVDA aria-details speech and braille oracle', async ({
  page,
  screenReader,
}) => {
  test.skip(
    screenReader.health.screenReader.name !== 'hoovda',
    'NVDA compatibility oracle applies to HooVDA only',
  );
  await page.setContent(`
    <!doctype html><html lang="en-US"><head><meta charset="utf-8"><title>ARIA details oracle</title></head>
    <body>
      <div role="application">
        <button>focus in app</button>
        <p>this is an application, it contains a button with details</p>
        <button aria-details="button-details">push me</button>
      </div>
      <div id="button-details" role="note"><p>Press to self-destruct</p></div>
    </body></html>
  `);
  await screenReader.returnToPage();
  await screenReader.focus(page.getByRole('button', { name: 'focus in app' }));
  const focus = await screenReader.focus(page.getByRole('button', { name: 'push me' }));
  expect(focus.speech).toBe('push me  button  has details');
  expect(focus.braille).toBe('push me btn details');
  const details = await screenReader.reportDetails();
  expect(details.speech).toBe('Press to self-destruct');
  expect(details.braille).toBe('Press to self-destruct');
  expect(screenReader.regressionTranscript()).toMatchSnapshot('nvda-aria-details-oracle.hoovda.txt');
});

test('supports elements-list and bounded find flow', async ({ page, screenReader }) => {
  test.skip(
    screenReader.health.screenReader.name !== 'hoovda',
    'Structured find and elements-list evidence require HooVDA',
  );
  await page.goto('/');
  await screenReader.returnToPage();
  const elements = await screenReader.elementsList();
  expect(elements.speech).toMatch(/Elements list.*links.*headings.*form fields/i);
  const found = await screenReader.findText('Accessibility toolkit');
  expect(found.speech).toContain('Accessibility toolkit');
  const boundary = await screenReader.act('findNext');
  expect(boundary.events.some(({ reason }) => reason === 'navigationBoundary')).toBe(true);
  const previousBoundary = await screenReader.act('findPrevious');
  expect(previousBoundary.events.some(({ reason }) => reason === 'navigationBoundary')).toBe(true);
});
