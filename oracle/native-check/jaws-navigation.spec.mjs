import { expect, test } from '@openhoo/hoosaidthat';

// Put two distinct targets of every type between plain text markers. Hearing
// the second name and then the first distinguishes a working Shift chord from
// a key that repeats, skips to the next type, or reaches a document boundary.
const groups = {
  'heading levels': Object.fromEntries(Array.from({ length: 6 }, (_, index) => {
    const level = index + 1;
    return [`Heading${level}`, name => `<h${level}>${name}</h${level}>`];
  })),
  'form controls': {
    Button: name => `<button>${name}</button>`,
    Checkbox: name => `<label><input type="checkbox">${name}</label>`,
    RadioButton: name => `<label><input type="radio" name="shipping">${name}</label>`,
    Entry: name => `<input aria-label="${name}">`,
  },
  'page content': {
    Image: name => `<img alt="${name}" width="48" height="48" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='48'%3E%3Crect width='48' height='48'/%3E%3C/svg%3E">`,
    ListItem: name => `<ul><li>${name}</li></ul>`,
    UnvisitedLink: name => `<a href="#${name}">${name}</a>`,
  },
};

for (const [group, cases] of Object.entries(groups)) {
  test(`JAWS quick keys move to the next and previous target: ${group}`, async ({ page, screenReader }) => {
    test.setTimeout(240_000);
    for (const [type, render] of Object.entries(cases)) {
      await test.step(type, async () => {
        const markup = `<!doctype html><html lang="en"><title>Navigation check: ${type}</title>
          <p>Start of route</p><div>${render('Orchid')}</div><div>${render('Cedar')}</div><p>End of route</p></html>`;
        await page.goto('data:text/html,' + encodeURIComponent(markup));
        await screenReader.returnToPage();
        await screenReader.documentStart();
        expect((await screenReader.act(`next${type}`)).speech).toMatch(/\bOrchid\b/i);
        expect((await screenReader.act(`next${type}`)).speech).toMatch(/\bCedar\b/i);
        expect((await screenReader.act(`previous${type}`)).speech).toMatch(/\bOrchid\b/i);
      });
    }
  });
}
