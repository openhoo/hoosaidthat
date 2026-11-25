import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readerConfig } from '../windows-reader-docker.mjs';

const cli = fileURLToPath(new URL('../windows-reader-docker.mjs', import.meta.url));
function dockerFixture(t, reader) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hst-reader-fixture-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = readerConfig(reader, {
    root, arch: process.arch === 'x64' ? 'amd64' : 'arm64', acceleration: 'tcg', image: 'sha256:' + 'a'.repeat(64), cloned: false,
  });
  for (const p of ['shared/bootstrap', 'shared/secrets', 'oem']) mkdirSync(join(root, p), { recursive: true });
  writeFileSync(join(root, 'winhoo-docker.json'), JSON.stringify(config));
  writeFileSync(join(root, 'shared/secrets/control-token'), 'a'.repeat(64) + '\n', { mode: 0o600 });
  writeFileSync(join(root, 'oem/runtime-lock.json'), JSON.stringify({ jaws: { version: '1' }, chrome: { version: '2' } }));
  const preload = join(root, 'fixture.mjs');
  writeFileSync(preload, `
    import cp from 'node:child_process';
    import net from 'node:net';
    import { EventEmitter } from 'node:events';
    import { syncBuiltinESMExports } from 'node:module';
    import { appendFileSync, writeFileSync } from 'node:fs';
    import { createHash } from 'node:crypto';
    Object.defineProperty(process, 'platform', {value: 'linux'});
    const cfg = ${JSON.stringify(config)}, id='b'.repeat(64);
    const old=cp.spawnSync;
    cp.spawnSync = (program, args, opts) => {
      if (program !== 'docker') return old(program, args, opts);
      let value;
      switch(args[0]){
        case 'context': value='unix:///fixture'; break;
        case 'info': value={OSType:'linux',Architecture:cfg.architecture,ID:'fixture'}; break;
        case 'image': value=[{Id:cfg.image,Os:'linux',Architecture:cfg.architecture,Config:{Labels:{'io.openhoo.winhoo.desktop.runtime':'winhoo.desktop-runtime/1','io.openhoo.winhoo.desktop.version':'0.4.0','io.openhoo.winhoo.desktop.applications':'none'}}}];break;
        case 'compose': value='compose';break;
        case 'create': case 'rm': case 'volume': value='';break;
        case 'cp':
          writeFileSync(args[2],args[1].endsWith('runtime.json')?JSON.stringify({schema:'winhoo.desktop-runtime/1',kind:'windows-desktop-vm',version:'0.4.0',configurationSchema:'winhoo.desktop/1',controller:'winhoo_desktop.py',controllerBundle:'/usr/share/winhoo/controller',applications:[],guestTools:{hiddenLauncher:'C:\\\\ProgramData\\\\WinHoo\\\\tools\\\\WinHoo.RunHidden.exe'}}):'fixture');
          value='';break;
        case 'ps': value=id;break;
        case 'container': value=[{Id:id,Name:'/'+cfg.name,Image:cfg.image,Config:{Labels:{'io.openhoo.winhoo.desktop':createHash('sha256').update(process.env.TEST_RUNTIME+'/winhoo-docker.json').digest('hex')}},State:{Status:'running',Running:true,StartedAt:process.env.TEST_BOOT},HostConfig:{PortBindings:Object.fromEntries(cfg.ports.map(p=>[p.guest+'/'+p.protocol,[{HostIp:'127.0.0.1',HostPort:String(p.host)}]]))},Mounts:[{Type:'volume',Name:cfg.volume,Destination:'/storage'},{Type:'bind',Source:cfg.shared,Destination:'/shared'},{Type:'bind',Source:cfg.oem,Destination:'/oem',RW:false}]}];break;
        default: throw Error('unexpected '+args[0]);
      }
      return {status:0,stderr:'',stdout:typeof value==='string'?value:JSON.stringify(value)};
    };
    // Verify which child the public command invokes. Never run a real guest
    // command or reserve the reader's standard controller port in this test.
    cp.spawn = (program, args, options) => {
      const child = new EventEmitter();
      const call = [program, args, options.env.HST_NVDA_CONTAINER_ID];
      appendFileSync(process.env.TEST_RUNTIME+'/children.jsonl', JSON.stringify(call)+'\\n');
      setImmediate(() => child.emit('exit', 0));
      return child;
    };
    const server = net.createServer;
    net.createServer = (...args) => {
      const s = server(...args);
      const listen = s.listen.bind(s);
      s.listen = (port, ...rest) => listen(0, ...rest);
      return s;
    };
    syncBuiltinESMExports();
    globalThis.fetch=async url=>{
      if(process.env.TEST_READY!=='yes')throw Error('bridge is starting');
      return Response.json(String(url).endsWith('/v2/health')?{ready:true,status:'ok',protocolVersion:'2.0',screenReader:'jaws',profile:'jaws-web',platform:'windows',capture:'jaws-speech-output',outputSource:'at-driver-interaction.capturedOutput',locale:'en-US',keyboardLayout:'desktop',version:'1',browser:{name:'chrome',version:'2'}}:{Browser:'Chrome/2',webSocketDebuggerUrl:'ws://localhost/devtools/browser/fixture'});
    };
  `);
  const boot = new Date(Date.now() - 120000).toISOString();
  function run(operation, ready, args = []) {
    return spawnSync(process.execPath, ['--import', preload, cli, reader, operation, ...args], {
      cwd: root,
      encoding: 'utf8', timeout: 6500,
      env: { ...process.env, TEST_BOOT: boot, TEST_READY: ready ? 'yes' : 'no', TEST_RUNTIME: root, ['HST_'+reader.toUpperCase()+'_RUNTIME_ROOT']: root, HST_JAWS_READY_TIMEOUT_MS: '1000' },
    });
  }
  return {root, run};
}

test('failed JAWS provisioning remains inspectable and cannot mask live recovery', (t) => {
  const {root, run} = dockerFixture(t, 'jaws');
  const receipt = join(root, 'shared/bootstrap/status.json');
  writeFileSync(receipt, JSON.stringify({ phase: 'failed', error: 'the old startup failed' }));
  const status = run('status', false);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).error, 'the old startup failed');
  const live = run('wait', true);
  assert.equal(live.status, 0, live.stderr);
  assert.match(live.stdout, /JAWS and Chrome ready/);
  assert.match(run('wait', false).stderr, /Guest provisioning failed: the old startup failed/);
  utimesSync(receipt, new Date(0), new Date(0));
  assert.equal(JSON.parse(run('status', false).stdout).previousBoot, true);
  assert.match(run('wait', false).stderr, /readiness timed out: bridge is starting/);
});

test('JAWS readiness rejects a malformed control credential before contacting the bridge', (t) => {
  const {root, run} = dockerFixture(t, 'jaws');
  writeFileSync(join(root, 'shared/secrets/control-token'), 'invalid fixture credential');
  const result = run('wait', true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid JAWS control token file/);
  assert.doesNotMatch(result.stderr, /invalid fixture credential/);
});

test('only public NVDA parity delegates readiness to its bundled runner', t => {
  const {root, run} = dockerFixture(t, 'nvda');
  writeFileSync(join(root, 'winhoo-docker-inputs.json'), '{}');
  const calls = join(root, 'children.jsonl');
  const runner = fileURLToPath(new URL('../nvda-windows.mjs', import.meta.url));
  for (const [op, args, expected] of [
    ['parity', [], [[runner, 'parity']]],
    ['parity-shard', ['de-DE', 'laptop', 'core'], [[runner, 'parity-shard', 'de-DE', 'laptop', 'core']]],
    ['run', ['--', process.execPath, runner, 'parity'], [[runner, 'docker-readiness'], [runner, 'parity']]],
    ['check', [], [[runner, 'docker-readiness', '--native-check'], 'playwright']],
  ]) {
    writeFileSync(calls, '');
    const result = run(op, true, args);
    assert.equal(result.status, 0, result.stderr);
    const children = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(children.map(([program, argv, guest]) => {
      assert.equal(program, process.execPath);
      assert.equal(guest, 'b'.repeat(64));
      return argv[1] === 'test' ? 'playwright' : argv;
    }), expected);
  }
});
