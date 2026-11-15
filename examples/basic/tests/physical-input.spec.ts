import { expect, test } from '@openhoo/hoosaidthat';

for (const mode of ['focus', 'browse'] as const) {
  test(`physical radio navigation preserves native focus and selection in ${mode} mode`, async ({
    page,
    screenReader,
  }) => {
    test.skip(
      screenReader.health.screenReader.name !== 'hoovda',
      'This contract exercises HooVDA physical X11 input and its virtual cursor.',
    );
    await page.goto('/physical-input.html');
    const selected = page.locator('#human');
    await screenReader.focus(selected);
    await expect(selected).toBeFocused();
    await expect(selected).toBeChecked();
    if (mode === 'focus') {
      await screenReader.ensureFocusMode();
    } else {
      await screenReader.ensureBrowseMode();
    }

    const before = await screenReader.state();
    expect(before.cursorMode).toBe(mode);
    expect(before.focus?.name).toBe('Human interpreter');
    expect(before.browse?.name).toBe('Human interpreter');
    for (const step of [
      { action: 'nextRadioButton', target: 'No interpreter' },
      { action: 'previousRadioButton', target: 'Human interpreter' },
    ] as const) {
      const observation = await screenReader.act(step.action);
      const after = await screenReader.state();
      expect(after.cursorMode).toBe(mode);
      expect(after.focus?.id).toBe(before.focus?.id);
      await expect(selected).toBeFocused();
      await expect(selected).toBeChecked();
      await expect(page.locator('#automatic')).not.toBeChecked();
      await expect(page.locator('#none')).not.toBeChecked();

      if (mode === 'focus') {
        expect(after.browse?.id).toBe(before.browse?.id);
        expect(
          observation.events.filter(event => ['speech', 'braille', 'audio'].includes(event.kind)),
        ).toEqual([]);
      } else {
        expect(after.browse?.name).toBe(step.target);
        expect(observation.speech).toContain(step.target);
        for (const output of [observation.speechEvents, observation.brailleEvents]) {
          expect(output.some(event =>
            event.text.includes(step.target)
            && event.provenance === 'screenReaderOutput'
            && event.source !== undefined,
          )).toBe(true);
        }
      }
    }
  });
}
