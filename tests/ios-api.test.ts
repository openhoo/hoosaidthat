import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runIPhoneVoiceOver, type IPhoneVoiceOverScenario } from '@openhoo/hoosaidthat/ios';

test('the public iPhone entry point rejects invalid scenarios before starting XCTest', async () => {
  const scenario = {
    url: 'file:///checkout',
    steps: [{ action: 'forward', until: 'Order summary', maxMoves: 3 }],
  } as const satisfies IPhoneVoiceOverScenario;
  const result = runIPhoneVoiceOver(scenario);
  await assert.rejects(result, /HTTP\(S\)/);
});

type ScenarioStep<T extends IPhoneVoiceOverScenario['steps'][number]> = T;
// @ts-expect-error A repeated search must specify a limit.
type MissingLimit = ScenarioStep<{ action: 'forward'; until: 'Pay now' }>;
// @ts-expect-error Reading the current utterance does not move the cursor.
type ImmobileSearch = ScenarioStep<{ action: 'current'; until: 'Pay now'; maxMoves: 3 }>;
