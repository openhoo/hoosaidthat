import assert from 'node:assert/strict';
import test from 'node:test';
import { buildContainerArguments } from '../src/runtime.js';
import { resolveOptions } from '../src/types.js';

for (const screenReader of ['orca', 'hoovda'] as const) {
  test(`${screenReader} uses only native Linux container arguments`, () => {
    const options = resolveOptions({
      screenReader,
      image: `hoosaidthat-${screenReader}:test`,
    });
    const args = buildContainerArguments(options, {
      containerName: `reader-${screenReader}`,
      token: 'secret',
      controlPort: 31001,
      cdpPort: 31002,
    });
    assert.deepEqual(args.slice(-1), [`hoosaidthat-${screenReader}:test`]);
    assert(args.includes('--network=host'));
    assert(args.includes('linux/amd64'));
    assert(args.includes('HST_CONTROL_PORT=31001'));
    assert(args.includes('HST_CDP_PORT=31002'));
    assert(args.includes('HOOVDA_PROFILE=nvda-web-2026.1.1'));
    assert(!args.some((argument) => /windows|wine|kvm|qemu/i.test(argument)));
    assert(!args.includes('--device'));
  });
}

test('NVDA cannot be rendered into Linux container arguments', () => {
  const options = resolveOptions({
    screenReader: 'nvda',
    controlEndpoint: 'http://127.0.0.1:3002',
    cdpEndpoint: 'http://127.0.0.1:9224',
    controlToken: 'secret',
  });
  assert.throws(
    () =>
      buildContainerArguments(options, {
        containerName: 'reader-nvda',
        token: 'secret',
        controlPort: 3002,
        cdpPort: 9224,
      }),
    /cannot be launched as a Linux container/,
  );
});
