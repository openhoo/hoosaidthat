import { expect, test } from '@openhoo/hoosaidthat';

const pageMarkup = `<!doctype html><html lang="en"><title>JAWS shopping list</title>
<h1>Shopping list</h1><h2>Delivery choices</h2>
<label><input type="checkbox" id="gift">Gift wrap</label>
<table><caption>Order items</caption><thead><tr><th>Fruit</th><th>Quantity</th></tr></thead>
<tbody><tr><td>Apricots</td><td>Seven</td></tr></tbody></table></html>`;

test('JAWS desktop quick keys reach a heading level and navigate cells in the virtual buffer', async ({ page, screenReader }) => {
  await page.goto('data:text/html,' + encodeURIComponent(pageMarkup));
  await screenReader.returnToPage();
  await screenReader.documentStart();
  const heading = await screenReader.act('nextHeading2');
  expect(heading.speech).toMatch(/Delivery choices/i);
  await screenReader.act('nextTable');
  const row = await screenReader.act('nextTableRow');
  expect(row.speech).toMatch(/Apricots/i);
  const cell = await screenReader.act('nextTableColumn');
  expect(cell.speech).toMatch(/Seven/i);
});

test('JAWS announces the focused checkbox and reports its checked state after native activation', async ({ page, screenReader }) => {
  await page.goto('data:text/html,' + encodeURIComponent(pageMarkup));
  const checkbox = page.getByRole('checkbox', { name: 'Gift wrap' });
  await expect(checkbox).not.toBeChecked();
  const before = await screenReader.focus(checkbox);
  expect(before.speech).toMatch(/Gift wrap/i);
  await screenReader.act('activateWithSpace');
  await expect(checkbox).toBeChecked();
  const after = await screenReader.act('readCurrent');
  expect(after.speech).toMatch(/Gift wrap/i);
  expect(after.speech).toMatch(/\bchecked\b/i);
  expect(after.speech).not.toMatch(/\b(?:not checked|unchecked)\b/i);
});
