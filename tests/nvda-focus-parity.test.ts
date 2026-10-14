import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

// npm test builds the shipped parity suite before running unit tests. Execute
// its actual preparation functions and semantic map without registering a
// Playwright suite or connecting to a screen-reader runtime.
const compiled = readFileSync(resolve('dist/oracle/parity/nvda-parity.spec.js'), 'utf8');

function section(startMarker: string, endMarker: string, includeEnd = false): string {
  const start = compiled.indexOf(startMarker);
  const end = compiled.indexOf(endMarker, start);
  assert(start >= 0 && end > start, `compiled parity section missing: ${startMarker}`);
  return compiled.slice(start, end + (includeEnd ? endMarker.length : 0));
}

const parity = runInNewContext([
  section('async function focusFixture(', 'async function prepareAction('),
  section('async function prepareAction(', 'async function installFixture('),
  section('const semanticExpectations = new Map(', '\n]);', true),
  '({ focusFixture, prepareAction, semanticExpectations })',
].join('\n')) as {
  focusFixture(screenReader: unknown, locator: unknown, label?: string): Promise<unknown>;
  prepareAction(page: unknown, screenReader: unknown, action: string): Promise<void>;
  semanticExpectations: Map<string, RegExp>;
};

async function preparedFocus(action: string): Promise<{ role: string; name: string } | undefined> {
  let focused: { role: string; name: string } | undefined;
  const page = {
    bringToFront: async () => undefined,
    getByRole: (role: string, options: { name: string }) => ({ role, name: options.name }),
  };
  const screenReader = {
    focus: async (locator: { role: string; name: string }) => { focused = locator; },
  };
  await parity.prepareAction(page, screenReader, action);
  return focused;
}

test('parity keyboard focus uses the public native helper and preserves its observation and label', async () => {
  const locator = {
    focus: async () => { throw new Error('DOM focus cannot synchronize the NVDA browse caret'); },
  };
  const observation = { action: 'focus', speech: 'Update live region button' };
  let called = false;
  const screenReader = {
    focus: async (target: unknown, label: string) => {
      assert.equal(target, locator);
      assert.equal(label, 'Focus live-region fixture');
      called = true;
      return observation;
    },
  };
  assert.equal(
    await parity.focusFixture(screenReader, locator, 'Focus live-region fixture'),
    observation,
  );
  assert.equal(called, true);
});

test('previousFocusable parity starts from the nonprotected successor of Details action', async () => {
  assert.deepEqual(await preparedFocus('previousFocusable'), {
    role: 'button', name: 'Activate action',
  });
});

test('previousFocusable semantic proof requires the backward target name and rejects redaction', () => {
  const expected = parity.semanticExpectations.get('previousFocusable');
  assert(expected, 'previousFocusable must keep a command-specific semantic oracle');
  assert(expected.test('Details action button'));
  assert.equal(expected.test('[redacted]'), false);
  assert.equal(expected.test('Parity password'), false);
  assert.equal(expected.test('Activate action button'), false);
});

test('activateWithSpace parity continues to prepare its checkbox target', async () => {
  assert.deepEqual(await preparedFocus('activateWithSpace'), {
    role: 'checkbox', name: 'Parity check',
  });
});
