import { expect, test, type ScreenReaderSession } from '@openhoo/hoosaidthat';
import type { Locator } from '@playwright/test';

const dateContext = 'Choose a date: November 2026';
const dialogTitle = 'Leave consultation?';
const dialogDescription = 'Your appointment remains booked.';
const buttonDescription = 'Check the appointment details before continuing.';

test.beforeEach(async ({ page, screenReader }) => {
  test.skip(
    screenReader.health.screenReader.name !== 'hoovda',
    'Dieser Vertrag prüft die native Fokusansage von HooVDA.',
  );
  await page.goto('/focus-context.html');
});

async function moveFocus(
  screenReader: ScreenReaderSession,
  target: Locator,
  expectedSpeech: string | RegExp,
  action: 'nextFocusable' | 'previousFocusable' | 'activate' = 'nextFocusable',
) {
  const checkpoint = await screenReader.checkpoint();
  await screenReader.act(action);
  // Zuerst den echten Fokus prüfen; keine Fokus- oder Lesegeste korrigiert ihn.
  await expect(target).toBeFocused();
  await expect
    .poll(async () => (await screenReader.readFrom(checkpoint)).speech)
    .toMatch(typeof expectedSpeech === 'string' ? escaped(expectedSpeech) : expectedSpeech);
  return await screenReader.readFrom(checkpoint);
}

function escaped(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

test('Tab-Eintritt nennt die Gruppe vor dem Kind und wiederholt sie erst nach erneutem Eintritt', async ({
  page,
  screenReader,
}) => {
  await screenReader.focus(page.locator('#before-dates'));
  const first = await moveFocus(
    screenReader,
    page.locator('#first-date'),
    /Choose a date: November 2026[\s\S]*16 November/,
  );
  expect(first.speech.match(escaped(dateContext))).not.toBeNull();
  const focus = first.events.find(event => event.kind === 'focus' && event.text === '16 November');
  expect(focus?.source).toBeDefined();
  const speech = first.speechEvents.find(event => event.text.includes(dateContext));
  expect(speech?.reason).toBe('nativeFocus');
  expect(speech?.provenance).toBe('screenReaderOutput');
  expect(speech?.source).toEqual(focus?.source);
  expect(first.events.some(event => event.kind === 'focus' && event.text === dateContext)).toBe(false);

  const sibling = await moveFocus(screenReader, page.locator('#second-date'), '17 November');
  expect(sibling.speech).not.toContain(dateContext);
  await moveFocus(screenReader, page.locator('#after-dates'), 'After date group');
  const reentry = await moveFocus(
    screenReader,
    page.locator('#second-date'),
    /Choose a date: November 2026[\s\S]*17 November/,
    'previousFocusable',
  );
  expect(reentry.speech).toContain(dateContext);
});

test('Tab-Eintritt in ein fieldset nennt die legend vor dem ersten Termin', async ({
  page,
  screenReader,
}) => {
  await screenReader.focus(page.locator('#before-times'));
  await moveFocus(screenReader, page.locator('#first-time'), /Choose a time[\s\S]*10:00/);
  const sibling = await moveFocus(screenReader, page.locator('#second-time'), '10:30');
  expect(sibling.speech).not.toContain('Choose a time');
});

test('Verschachtelte Gruppen werden von außen nach innen vor dem fokussierten Kind angesagt', async ({
  page,
  screenReader,
}) => {
  await screenReader.focus(page.locator('#before-nested'));
  await moveFocus(
    screenReader,
    page.locator('#telephone'),
    /Consultation options[\s\S]*Contact method[\s\S]*Telephone/,
  );
  const sibling = await moveFocus(screenReader, page.locator('#video'), 'Video');
  expect(sibling.speech).not.toContain('Consultation options');
  expect(sibling.speech).not.toContain('Contact method');
});

test('showModal nennt Titel und Beschreibung automatisch vor dem fokussierten Schließen-Schalter', async ({
  page,
  screenReader,
}) => {
  await screenReader.focus(page.locator('#open-dialog'));
  const opened = await moveFocus(
    screenReader,
    page.locator('#close-dialog'),
    /Leave consultation\?[\s\S]*Your appointment remains booked\.[\s\S]*Close leave dialog/,
    'activate',
  );
  await expect(page.locator('#leave-dialog')).toBeVisible();
  expect(opened.speech).toContain(dialogTitle);
  expect(opened.speech).toContain(dialogDescription);
});

test('Ausgeschaltete Gruppenansagen unterdrücken Gruppen, erhalten aber den Dialogtitel', async ({
  page,
  screenReader,
}) => {
  const original = await screenReader.presentationSettings();
  try {
    await screenReader.setPresentationSettings({ ...original, reportGroupings: false });
    await screenReader.focus(page.locator('#before-dates'));
    const grouped = await moveFocus(screenReader, page.locator('#first-date'), '16 November');
    expect(grouped.speech).not.toContain(dateContext);

    await screenReader.focus(page.locator('#open-dialog'));
    await moveFocus(
      screenReader,
      page.locator('#close-dialog'),
      /Leave consultation\?[\s\S]*Close leave dialog/,
      'activate',
    );
  } finally {
    await screenReader.setPresentationSettings(original);
  }
});

test('Eigene Beschreibungen und Dialogbeschreibungen respektieren die Beschreibungseinstellungen', async ({
  page,
  screenReader,
}) => {
  const original = await screenReader.presentationSettings();
  try {
    await screenReader.setPresentationSettings({
      ...original,
      reportObjectDescriptions: true,
      reportAriaDescription: true,
    });
    await screenReader.focus(page.locator('#before-description'));
    await moveFocus(
      screenReader,
      page.locator('#described'),
      /Review booking[\s\S]*Check the appointment details before continuing\./,
    );

    await screenReader.setPresentationSettings({
      ...original,
      reportObjectDescriptions: false,
      reportAriaDescription: false,
    });
    await screenReader.focus(page.locator('#before-description'));
    const described = await moveFocus(screenReader, page.locator('#described'), 'Review booking');
    expect(described.speech).not.toContain(buttonDescription);

    await screenReader.focus(page.locator('#open-dialog'));
    const opened = await moveFocus(
      screenReader,
      page.locator('#close-dialog'),
      /Leave consultation\?[\s\S]*Close leave dialog/,
      'activate',
    );
    expect(opened.speech).not.toContain(dialogDescription);
  } finally {
    await screenReader.setPresentationSettings(original);
  }
});
