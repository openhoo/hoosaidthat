import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { parseTalkBackArguments, runTalkBackConsumer } from '../talkback-android.mjs';

test('pass child help flags through after the delimiter', () => {
  const prefix = ['run', '--avd', 'HST', '--token-file', 'token'];
  for (const flag of ['--help', '-h']) {
    assert.deepEqual(parseTalkBackArguments([...prefix, '--', 'node', flag]).child, ['node', flag]);
    assert.deepEqual(parseTalkBackArguments([...prefix, flag, '--', 'node']), { help: true });
  }
});

test('propagates an uninterrupted consumer exit status', async () => {
  const code = await runTalkBackConsumer([process.execPath, '-e', 'process.exitCode = 7'], { env: process.env, signal: new AbortController().signal });
  assert.equal(code, 7);
});

test('SIGTERM reaps a nested worker even after its npm-like wrapper exits', { skip: process.platform === 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hst-consumer-tree-'));
  const ready = join(dir, 'worker'), heartbeat = join(dir, 'heartbeat');
  const controller = new AbortController();
  const worker = `const fs=require('node:fs'); let beats=0;
    process.on('SIGTERM', ()=>{});
    setInterval(()=>fs.writeFileSync(process.argv[2], String(++beats)), 15);
    fs.writeFileSync(process.argv[1], String(process.pid));`;
  const wrapper = `const {spawn}=require('node:child_process');
    process.on('SIGTERM', ()=>process.exit(0));
    spawn(process.execPath,['-e',process.argv[1],process.argv[2],process.argv[3]],{stdio:'ignore'});`;
  const result = runTalkBackConsumer([process.execPath, '-e', wrapper, worker, ready, heartbeat], {
    env: process.env, signal: controller.signal, graceMs: 250,
  });
  let workerPid;
  t.after(async () => {
    if (!controller.signal.aborted) controller.abort();
    if (workerPid) { try { process.kill(workerPid, 'SIGKILL'); } catch {} }
    await result; await rm(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 100; i++) {
    try { workerPid = Number(await readFile(ready)); if (Number(await readFile(heartbeat)) > 0) break; } catch {}
    await delay(25);
  }
  assert(workerPid > 1); assert(Number(await readFile(heartbeat)) > 0);
  controller.abort(Object.assign(new Error('test cancellation'), { signal: 'SIGTERM' }));
  assert.equal(await result, 143);
  await delay(60); const stopped = await readFile(heartbeat, 'utf8');
  await delay(100); assert.equal(await readFile(heartbeat, 'utf8'), stopped, 'grandchild continued to run');
});
