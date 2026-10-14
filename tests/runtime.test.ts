import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildContainerArguments, ScreenReaderRuntime } from '../src/runtime.js';
import { resolveOptions } from '../src/types.js';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

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

test('failed managed container cleanup can be retried and hides its control token', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hoosaidthat-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = `#!/bin/sh
task_dir=${shellQuote(directory)}
printf '%s\\n' "$1" >> "$task_dir/commands"
if [ "$1" = "rm" ] && [ ! -f "$task_dir/remove-attempted" ]; then
  touch "$task_dir/remove-attempted"
  printf '%s' 'engine failed for private-runtime-token' >&2
  exit 1
fi
exit 0
`;
  await writeFile(join(directory, 'docker'), script, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${directory}:${previousPath ?? ''}`;
  t.after(() => { process.env.PATH = previousPath; });
  const runtime = Reflect.construct(ScreenReaderRuntime, [{
    controlEndpoint: 'http://127.0.0.1:1', cdpEndpoint: 'http://127.0.0.1:2',
    controlToken: 'private-runtime-token',
  }, 'docker', 'test-container', false]) as ScreenReaderRuntime;
  await assert.rejects(() => runtime.stop(), (error: unknown) => {
    assert(error instanceof Error);
    assert(!error.message.includes('private-runtime-token'));
    return true;
  });
  await runtime.stop();
  assert.deepEqual((await readFile(join(directory, 'commands'), 'utf8')).trim().split('\n'),
    ['stop', 'rm', 'stop', 'rm']);
  await runtime.stop();
  assert.deepEqual((await readFile(join(directory, 'commands'), 'utf8')).trim().split('\n'),
    ['stop', 'rm', 'stop', 'rm']);
});

test('external runtime readiness failures hide reflected bearer tokens', async (t) => {
  const secret = 'private-readiness-token';
  const server = createServer((request, response) => {
    if (request.url === '/json/version') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:1' }));
    } else {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: `rejected Bearer ${secret}` }));
    }
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const options = resolveOptions({ runtime: 'external', controlEndpoint: endpoint,
    cdpEndpoint: endpoint, controlToken: secret, startupTimeoutMs: 50 });
  await assert.rejects(() => ScreenReaderRuntime.start(options, 0), (error: unknown) => {
    assert(error instanceof Error);
    assert(error.message.includes('control=503'));
    assert(!error.message.includes(secret));
    return true;
  });
});

test('failed container launch still cleans up after diagnostic collection fails', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hoosaidthat-launch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = `#!/bin/sh
task_dir=${shellQuote(directory)}
printf '%s\\n' "$1" >> "$task_dir/commands"
if [ "$1" = "run" ]; then
  for argument in "$@"; do
    case "$argument" in HST_CONTROL_TOKEN=*)
      printf '%s' "\${argument#HST_CONTROL_TOKEN=}" > "$task_dir/token"
      printf '%s' "$argument" >&2
    esac
  done
  exit 1
fi
if [ "$1" = "logs" ]; then exit 1; fi
exit 0
`;
  await writeFile(join(directory, 'docker'), script, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${directory}:${previousPath ?? ''}`;
  t.after(() => { process.env.PATH = previousPath; });
  let failure: Error | undefined;
  await assert.rejects(() => ScreenReaderRuntime.start(resolveOptions({ runtime: 'docker' }), 0),
    (error: unknown) => { assert(error instanceof Error); failure = error; return true; });
  const secret = await readFile(join(directory, 'token'), 'utf8');
  assert(failure && !failure.message.includes(secret));
  assert(failure.message.includes('[redacted]'));
  assert.deepEqual((await readFile(join(directory, 'commands'), 'utf8')).trim().split('\n'),
    ['version', 'run', 'logs', 'stop', 'rm']);
});
