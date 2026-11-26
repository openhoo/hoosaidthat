import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveOptions } from '../src/types.js';
import { buildContainerArguments } from '../src/runtime.js';
import { isRuntimeBootstrapURL, NATIVE_BOOTSTRAP_URL } from '../src/bootstrap.js';

for (const screenReader of ['voiceover', 'jaws'] as const) {
  test(`${screenReader} has a distinct external native profile`, () => {
    const options = resolveOptions({ screenReader, controlEndpoint: 'http://127.0.0.1:3003',
      cdpEndpoint: 'http://127.0.0.1:9225', controlToken: 'native-test-token' });
    assert.equal(options.profile, `${screenReader}-web`);
    assert.equal(options.runtime, 'external');
    assert.equal(options.actionTimeoutMs, 15000);
    assert.throws(() => resolveOptions({ screenReader, profile: 'nvda-web-2026.1.1' }), /profile/);
    assert.throws(() => resolveOptions({ screenReader, runtime: 'docker' }), /requires runtime "external"/);
    assert.throws(() => resolveOptions({ screenReader }), /external runtime requires/);
    assert.throws(() => buildContainerArguments(options, {
      containerName: 'native', token: 'test', controlPort: 3003, cdpPort: 9225,
    }), /cannot be launched as a Linux container/);
  });
}

test('native bootstrap retirement matches only the exact owned page', () => {
  assert.equal(isRuntimeBootstrapURL(NATIVE_BOOTSTRAP_URL), true);
  assert.equal(isRuntimeBootstrapURL(NATIVE_BOOTSTRAP_URL + 'unowned'), false);
});


test('JAWS rejects unsupported locales and layouts before connecting to the guest', () => {
  assert.throws(() => resolveOptions({ screenReader: 'jaws', locale: 'de-DE' }), /locale "en-US"/);
  assert.throws(() => resolveOptions({ screenReader: 'jaws', keyboardLayout: 'laptop' }), /keyboardLayout "desktop"/);
});

test('the worker reads the current token from the private file when connecting', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hst-native-token-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const controlTokenFile = join(directory, 'credential');
  const options = { screenReader: 'jaws' as const, controlEndpoint: 'http://127.0.0.1:3004',
    cdpEndpoint: 'http://127.0.0.1:9226', controlTokenFile };
  for (const token of ['fixture-first'.padEnd(43, '1'), 'fixture-rotated'.padEnd(43, '2')]) {
    writeFileSync(controlTokenFile, token + '\n', { mode: 0o600 });
    assert.equal(resolveOptions(options).controlToken, token);
    assert(!JSON.stringify(options).includes(token));
  }
  writeFileSync(controlTokenFile, 'this is not a credential'.repeat(3));
  assert.throws(() => resolveOptions(options), /Invalid native control token file/);
});
