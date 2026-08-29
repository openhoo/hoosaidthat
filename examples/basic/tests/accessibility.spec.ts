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
    {
      name: 'email',
      locator: page.getByRole('textbox', { name: 'Email', exact: true }),
    },
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

test('exports screen reader output images for page structures', async ({ page, screenReader }) => {
  test.setTimeout(120_000);
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
  expect(Object.keys(results)).toEqual([
    'headings',
    'landmarks',
    'articles',
    'figures',
    'groupings',
    'tabs',
    'menu-items',
    'toggle-buttons',
    'progress-bars',
    'references',
    'math',
    'vertical-paragraphs',
    'same-style-text',
    'different-style-text',
    'buttons',
    'form-fields',
    'links',
    'visited-links',
    'unvisited-links',
    'lists',
    'list-items',
    'tables',
    'graphics',
    'checkboxes',
    'radio-buttons',
    'combo-boxes',
    'edit-fields',
    'text-paragraphs',
    'frames',
    'separators',
    'block-quotes',
    'embedded-objects',
    'annotations',
    'spelling-errors',
    'non-link-text',
  ]);
  expect(
    results.headings.observations.some(({ speech }) => /Checkout.*heading/i.test(speech)),
  ).toBe(true);
  expect(results.buttons.observations.some(({ speech }) => /Continue.*button/i.test(speech))).toBe(
    true,
  );
  expect(
    results.landmarks.observations.some(({ speech }) => /banner.*landmark|landmark.*banner/i.test(speech)),
  ).toBe(true);
  expect(
    results['form-fields'].observations.some(({ speech }) => /Email.*(entry|edit)/i.test(speech)),
  ).toBe(true);
  expect(
    results.links.observations.some(({ speech }) => /Skip to checkout.*link/i.test(speech)),
  ).toBe(true);
  expect(results.lists.observations.some(({ speech }) => /list/i.test(speech))).toBe(true);
  expect(
    results.tables.observations.some(({ speech }) => /Order totals.*table/i.test(speech)),
  ).toBe(true);
  expect(
    results.graphics.observations.some(({ speech }) =>
      /OpenHoo parcel mark.*(image|graphic)/i.test(speech),
    ),
  ).toBe(true);
  for (const [name, result] of Object.entries(results)) {
    expect(result.screenshots).toHaveLength(result.observations.length);
    expect(['boundary', 'repeat', 'max'], `${name} export stop reason`).toContain(
      result.stopReason,
    );
  }
  for (const name of [
    'headings',
    'landmarks',
    'buttons',
    'form-fields',
    'links',
    'lists',
    'tables',
    'graphics',
  ] as const) {
    expect(results[name].stoppedOnBoundary, `${name} export boundary`).toBe(true);
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
    <!doctype html><html lang="${screenReader.health.locale ?? 'en-US'}"><head><meta charset="utf-8"><title>ARIA details oracle</title></head>
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
  const locale = screenReader.health.locale ?? 'en-US';
  const keyboardLayout = screenReader.health.keyboardLayout ?? 'desktop';
  if (locale === 'de-DE') {
    expect(focus.speech).toBe('push me  Schalter  Hat Details');
    expect(focus.braille).toBe('push me sltr Details');
  } else {
    expect(focus.speech).toBe('push me  button  has details');
    expect(focus.braille).toBe('push me btn details');
  }
  const details = await screenReader.reportDetails();
  expect(details.speech).toBe('Press to self-destruct');
  expect(details.braille).toBe('Press to self-destruct');
  expect(screenReader.regressionTranscript()).toMatchSnapshot(
    `nvda-aria-details-oracle-${locale.toLowerCase()}-${keyboardLayout}.hoovda.txt`,
  );
});

test('matches pinned NVDA browse navigation oracle', async ({ page, screenReader }) => {
  test.skip(
    screenReader.health.screenReader.name !== 'hoovda' ||
      screenReader.health.locale !== 'en-US' ||
      screenReader.health.keyboardLayout !== 'desktop',
    'Pinned upstream speech assertions are en-US HooVDA evidence',
  );
  await page.setContent(`
    <!doctype html><html lang="en-US"><head><meta charset="utf-8"><title>Browse navigation oracle</title></head>
    <body>
      <article aria-labelledby="label" aria-describedby="description">
        <h1>Quick Nav Target</h1>
        <div id="label">Some name.</div>
        <div id="description">A bunch of text.</div>
      </article>
      <p>Header</p>
      <p>Liberal MP: 1904–1908</p>
      <p>.</p>
      <p>…</p>
      <p>5.</p>
      <p>test....</p>
      <p>a.b</p>
      <p></p>
      <p>Hello, world!</p>
      <p>He replied, "That's wonderful."</p>
      <p>He replied, "That's wonderful".</p>
      <p>He replied, "That's wonderful."[4]</p>
      <p>Предложение по-русски.</p>
      <p>我不会说中文！</p>
      <p>Bye-bye, world!</p>
    </body></html>
  `);
  await screenReader.returnToPage();
  await screenReader.documentStart();
  const heading = await screenReader.act('nextHeading');
  expect(heading.speech).toBe('Quick Nav Target  heading  level 1');
  const expectedParagraphs = [
    'Hello, world!',
    "He replied,  That's wonderful.",
    "He replied,  That's wonderful .",
    "He replied,  That's wonderful.  4",
    'Предложение по-русски.',
    '我不会说中文',
    'Bye-bye, world!',
  ];
  for (const expected of expectedParagraphs) {
    expect((await screenReader.act('nextParagraph')).speech).toBe(expected);
  }
  expect((await screenReader.act('nextParagraph')).speech).toBe('no next text paragraph');
  for (const expected of expectedParagraphs.slice(0, -1).reverse()) {
    expect((await screenReader.act('previousParagraph')).speech).toBe(expected);
  }
  expect((await screenReader.act('previousParagraph')).speech).toBe('no previous text paragraph');
  expect(screenReader.regressionTranscript()).toMatchSnapshot(
    'nvda-browse-navigation-oracle-en-us-desktop.hoovda.txt',
  );
});

test('matches pinned NVDA table navigation oracle', async ({ page, screenReader }) => {
  test.skip(
    screenReader.health.screenReader.name !== 'hoovda' ||
      screenReader.health.locale !== 'en-US' ||
      screenReader.health.keyboardLayout !== 'desktop',
    'Pinned upstream speech assertions are en-US HooVDA evidence',
  );
  await page.setContent(`
    <!doctype html><html lang="en-US"><head><meta charset="utf-8"><title>Table navigation oracle</title></head>
    <body>
      <p>Paragraph</p>
      <div style="display:table">
        <table>
          <thead><tr><th>First heading</th><th>Second heading</th></tr></thead>
          <tbody><tr><td>First content cell</td><td>Second content cell</td></tr></tbody>
        </table>
      </div>
    </body></html>
  `);
  await screenReader.returnToPage();
  await screenReader.documentStart();
  const table = await screenReader.act('nextTable');
  expect(table.speech).toBe('table  with 2 rows and 2 columns  row 1  column 1  First heading');
  const row = await screenReader.act('nextTableRow');
  expect(row.speech).toBe('row 2  First content cell');
  expect(screenReader.regressionTranscript()).toMatchSnapshot(
    'nvda-table-navigation-oracle-en-us-desktop.hoovda.txt',
  );
});

test('matches source-pinned NVDA live-region behavior oracle', async ({ page, screenReader }) => {
  test.skip(
    screenReader.health.screenReader.name !== 'hoovda' ||
      screenReader.health.locale !== 'en-US' ||
      screenReader.health.keyboardLayout !== 'desktop',
    'HooVDA source-pinned live-region evidence uses en-US',
  );
  await page.setContent(`
    <!doctype html><html lang="en-US"><head><meta charset="utf-8"><title>Live region oracle</title></head>
    <body>
      <button id="update">Update status</button>
      <div id="status" role="alert"></div>
      <script>
        document.querySelector('#update').addEventListener('click', () => {
          document.querySelector('#status').textContent = 'Order review ready';
        });
      </script>
    </body></html>
  `);
  await screenReader.returnToPage();
  await screenReader.focus(page.getByRole('button', { name: 'Update status' }));
  const update = await screenReader.activate();
  expect(update.speech).toBe('Order review ready');
  expect(screenReader.regressionTranscript()).toMatchSnapshot(
    'nvda-live-region-oracle-en-us-desktop.hoovda.txt',
  );
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
