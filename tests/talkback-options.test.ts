import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveOptions } from '../src/types.js';
import { buildContainerArguments } from '../src/runtime.js';

for (const screenReader of ['talkback'] as const) {
  test(`${screenReader} has a distinct external native profile`, () => {
    const options = resolveOptions({ screenReader, controlEndpoint: 'http://127.0.0.1:3003',
      cdpEndpoint: 'http://127.0.0.1:9225', controlToken: 'native-test-token' });
    assert.equal(options.profile, `${screenReader}-web`);
    assert.equal(options.runtime, 'external');
    assert.equal(options.actionTimeoutMs, 15000);
    assert.throws(() => resolveOptions({ screenReader, profile: 'nvda-web-2026.1.1' }), /profile/);
    assert.throws(() => resolveOptions({ screenReader, runtime: 'docker' }), /requires runtime "external"/i);
    assert.throws(() => resolveOptions({ screenReader }), /external runtime requires/);
    assert.throws(() => buildContainerArguments(options, {
      containerName: 'native', token: 'test', controlPort: 3003, cdpPort: 9225,
    }), /cannot be launched as a Linux container/);
  });
}


test('TalkBack bootstrap retirement matches only its exact owned page', async () => {
  const { isRuntimeBootstrapURL, NATIVE_BOOTSTRAP_URL } = await import('../src/bootstrap.js');
  assert.equal(isRuntimeBootstrapURL(NATIVE_BOOTSTRAP_URL), true);
  assert.equal(isRuntimeBootstrapURL(NATIVE_BOOTSTRAP_URL + 'unowned'), false);
});
