import { readFile } from 'node:fs/promises';
import { test } from '@openhoo/hoosaidthat';
import { androidScenario, runAndroidSteps } from '../../scripts/mobile-scenario.mjs';

test('record the feature with TalkBack', async ({ page, screenReader }) => {
  const scenario = androidScenario(JSON.parse(await readFile(process.env.HST_RECORD_SCENARIO, 'utf8')));
  await page.goto(scenario.url);
  if (scenario.readyText) {
    const label = scenario.readyText;
    await page.getByText(label, { exact: true }).or(page.getByLabel(label, { exact: true }))
      .or(page.getByAltText(label, { exact: true })).filter({ visible: true }).first().waitFor();
  }
  await screenReader.returnToPage();
  await runAndroidSteps(scenario, action => screenReader.act(action));
});
