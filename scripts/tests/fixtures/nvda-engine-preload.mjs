// OS and engine seam for the real controller subprocess. No VM or external command can run.
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

const { HST_NVDA_RUNTIME_ROOT: root, HST_TEST_SCENARIO: scenario, HST_TEST_MANAGED: managed } = process.env;
const name = 'hoosaidthat-nvda-oracle',
  id = 'a'.repeat(64);
const calls = [];
let started = false,
  postStartStates = 0;
process.on('exit', () => fs.writeFileSync(join(root, 'calls.json'), JSON.stringify(calls)));
const originalRead = fs.readFileSync,
  originalExists = fs.existsSync;
Object.defineProperty(process, 'platform', { value: managed ? 'darwin' : 'linux' });
fs.existsSync = (path) => ['/dev/kvm', '/dev/net/tun'].includes(path) || originalExists(path);
fs.readFileSync = (path, ...args) =>
  path === '/proc/meminfo' ? 'MemAvailable: 17000000 kB' : originalRead(path, ...args);
fs.statfsSync = () => ({ bavail: 200 * 1024 ** 2, bsize: 1024 });
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const lost = {
  status: 1,
  stdout: '',
  stderr: 'failed to connect to the docker API: dial unix docker.sock: connect: no such file or directory',
};
const state = ['stopped', 'absent', 'paused'].includes(scenario) ? scenario : 'running';
cp.spawnSync = (program, args, options) => {
  calls.push([program, ...args]);
  if (program === 'ssh' && args.at(-1) === 'shutdown')
    return ok(
      JSON.stringify({
        schema: 'hoosaidthat.nvda-ssh-control',
        version: 1,
        command: 'shutdown',
        status: 'ready',
      }),
    );
  if ((program === 'ssh' && args[0] === '-V') || (program === 'ssh-keygen' && args[0] === '-?')) return ok();
  if (program === 'python3' && args[0] === '--version') return ok('Python 3.12');
  assert.ok(['podman', 'docker'].includes(program), 'unexpected command: ' + program);
  if (['version', 'compose'].includes(args[0])) return ok();
  if (args[0] === 'info') return ok('{"MemTotal":17179869184}');
  if (args[0] === 'inspect' && args.includes('{{json .Mounts}}'))
    return ok(
      JSON.stringify([
        { Type: 'bind', Source: join(root, 'state'), Destination: '/storage' },
        { Type: 'bind', Source: join(root, 'shared'), Destination: '/shared' },
      ]),
    );
  if (['ps', 'inspect'].includes(args[0])) {
    if (started) postStartStates++;
    if (scenario === 'engine-loss' || (scenario === 'mid-run-loss' && started)) return lost;
    if (scenario === 'engine-timeout') {
      if (args[0] === 'ps') assert.ok(options.timeout > 0 && options.timeout <= 5000);
      return {
        status: null,
        stdout: '',
        stderr: '',
        error: Object.assign(new Error('engine timeout'), { code: 'ETIMEDOUT' }),
      };
    }
    if (args[0] === 'inspect')
      return state === 'absent'
        ? { ...lost, stderr: 'no such container' }
        : ok(args.includes('{{.State.Running}}') ? String(state === 'running') : state);
    const currentId = scenario === 'replaced' && started && postStartStates >= 2 ? 'b'.repeat(64) : id;
    if (scenario === 'malformed') return ok(name + '\tunknown-output');
    // A substring match from the daemon must never be considered the oracle.
    const neighbor = ['f'.repeat(64), name + '-other', 'running'].join('\t');
    return ok(
      (state === 'absent'
        ? ''
        : [currentId, name, state === 'stopped' ? 'exited' : state].join('\t') + '\n') +
        neighbor +
        '\n',
    );
  }
  if (args[0] === 'exec') {
    if (args.includes('stat')) return ok('1 1'); // real disk guard triggers normal cleanup
    if (scenario === 'exec-loss') return lost;
    if (args.includes('test')) return { status: 1, stdout: '', stderr: '' };
    return ok(scenario === 'booting' ? 'starting' : scenario === 'ended' ? 'ended' : 'running');
  }
  if (args[0] === 'logs') return lost;
  assert.fail('unexpected engine command: ' + args);
};
cp.execFileSync = (program, args) => {
  calls.push([program, ...args]);
  if (program === 'python3') {
    assert.ok(['up', 'stop', 'down', 'build', 'restart'].includes(args.at(-1)));
    if (args.at(-1) === 'up') started = true;
    return '';
  }
  assert.equal(program, 'podman');
  assert.equal(args[0], 'compose');
  return '';
};
globalThis.fetch = async () => {
  throw new Error('unexpected HTTP probe');
};
syncBuiltinESMExports();
