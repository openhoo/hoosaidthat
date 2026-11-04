#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const oracle=join(project,'oracle/macos-voiceover');
const lock=JSON.parse(readFileSync(join(oracle,'runtime-lock.json'),'utf8'));
const root=resolve(process.env.HST_VOICEOVER_RUNTIME_ROOT ?? join(homedir(),'VMs/hoosaidthat-voiceover'));
const shared=join(root,'shared');
const tart=process.env.HST_TART_BIN ?? 'tart';
const vm=process.env.HST_VOICEOVER_VM ?? 'hoosaidthat-voiceover';
const environment={...process.env,TART_HOME:process.env.TART_HOME ?? join(root,'tart')};
const command=process.argv[2] ?? 'status';
const commandTimeoutMs=Number(process.env.HST_VOICEOVER_COMMAND_TIMEOUT_MS ?? 30*60000);
let vmProcess, lease, owned=false, interrupted=false;
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{ interrupted=true; vmProcess?.kill('SIGTERM'); });
function run(binary,args,options={}) {
  const result=spawnSync(binary,args,{env:environment,stdio:'inherit',...options});
  if(result.error || result.status!==0) throw new Error(`${binary} failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}`);
  return result;
}
function output(binary,args,options={}) { return run(binary,args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],...options}).stdout.trim(); }
function doctor() {
  if(process.platform!=='darwin' || process.arch!=='arm64') throw new Error('Isolated VoiceOver requires a macOS Apple Silicon virtualization host');
  if(!/^hoosaidthat-[a-z0-9-]{1,60}$/.test(vm)) throw new Error('HST_VOICEOVER_VM must be a dedicated hoosaidthat-* guest');
  if(!Number.isSafeInteger(commandTimeoutMs)||commandTimeoutMs<1000||commandTimeoutMs>4*60*60000) throw new Error('invalid HST_VOICEOVER_COMMAND_TIMEOUT_MS');
  const version=output(tart,['--version']);
  console.log(JSON.stringify({tart:version,vm,root,image:lock.tart.image,hostDesktopAutomation:false,hostAudio:false}));
}
async function acquireLease() {
  lease=createServer(socket=>socket.destroy());
  await new Promise((resolve,reject)=>{lease.once('error',()=>reject(new Error('VoiceOver VM is already owned by another job')));lease.listen(39974,'127.0.0.1',resolve);});
}
function stage() {
  mkdirSync(join(shared,'payload'),{recursive:true,mode:0o700});
  mkdirSync(join(shared,'results'),{recursive:true,mode:0o700});
  writeFileSync(join(shared,'guest-only-marker'),'Hoosaidthat isolated VoiceOver guest\n',{mode:0o600});
  if(!existsSync(join(shared,'control-token'))) writeFileSync(join(shared,'control-token'),`${randomBytes(32).toString('base64url')}\n`,{flag:'wx',mode:0o600});
  for(const file of ['runtime-lock.json','provision.sh','permissions.py','run-check.sh']) cpSync(join(oracle,file),join(shared,'payload',file));
  const result=output('npm',['pack','--json','--pack-destination',join(shared,'payload')],{cwd:project});
  const filename=JSON.parse(result)[0]?.filename;
  if(!filename || !/^[\w.@-]+\.tgz$/.test(filename)) throw new Error('invalid npm package filename');
  renameSync(join(shared,'payload',filename),join(shared,'payload/hoosaidthat.tgz'));
  if(!existsSync(join(root,'askpass'))) writeFileSync(join(root,'askpass'),'#!/bin/sh\nprintf "%s\\n" admin\n',{mode:0o700,flag:'wx'});
}
function initialize() {
  stage();
  const guests=JSON.parse(output(tart,['list','--format','json']));
  const existing=guests.find(item=>item.Name===vm || item.name===vm);
  if(existing?.Running || existing?.running) throw new Error('Dedicated VoiceOver guest is already running; stop its owner before starting another job');
  if(!existing) {
    const fs=statfsSync(root);
    if(Number(fs.bavail)*Number(fs.bsize)<55*1024**3) throw new Error('First macOS VM pull requires at least 55 GiB free; an existing initialized guest can be reused');
    run(tart,['clone',lock.tart.image,vm]);
  }
  run(tart,['set',vm,'--memory','6144','--cpu','4']);
}
function address() {
  const ip=output(tart,['ip',vm,'--wait','120'],{timeout:130000});
  if(!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || ip.split('.').some(part=>+part>255)) throw new Error('Tart did not return a guest IPv4 address');
  return ip;
}
function ssh(ip,script,options={}) {
  // Public bootstrap credentials belong to this fresh Cirrus test image only.
  // The host key is retained in this guest's private runtime directory.
  return run('ssh',['-o','StrictHostKeyChecking=accept-new','-o',`UserKnownHostsFile=${join(root,'known_hosts')}`,
    '-o','ConnectTimeout=10','-o','NumberOfPasswordPrompts=1','-o','PubkeyAuthentication=no',`admin@${ip}`,script],
  {env:{...environment,SSH_ASKPASS:join(root,'askpass'),SSH_ASKPASS_REQUIRE:'force',DISPLAY:'hoosaidthat'},timeout:commandTimeoutMs,...options});
}
async function main() {
  doctor();
  if(['init','run','stop'].includes(command)) await acquireLease();
  switch(command) {
    case 'doctor': break;
    case 'init': initialize(); console.log('Isolated VoiceOver VM initialized.'); break;
    case 'status': run(tart,['list']); break;
    case 'stop': run(tart,['stop',vm]); break;
    case 'run': {
      initialize();
      // Never connect a graphical window, host audio, clipboard, or USB devices.
      vmProcess=spawn(tart,['run',vm,'--no-graphics','--no-audio','--no-clipboard','--no-usb-accessories',`--dir=hoosaidthat:${shared}`],{env:environment,stdio:['ignore','inherit','inherit']});
      owned=true;
      vmProcess.once('error',error=>console.error(`VM launch failed: ${error.message}`));
      const ip=address();
      if(interrupted) throw new Error('VoiceOver VM job interrupted');
      ssh(ip,"bash '/Volumes/My Shared Files/hoosaidthat/payload/provision.sh'");
      ssh(ip,"bash '/Volumes/My Shared Files/hoosaidthat/payload/run-check.sh'");
      console.log(`Native VoiceOver test evidence: ${join(shared,'results')}`);
      break;
    }
    default: throw new Error('usage: voiceover-macos.mjs doctor|init|run|status|stop');
  }
}
try { await main(); } catch(error) { console.error(error.message); process.exitCode=1; }
finally {
  if(owned) { try { run(tart,['stop',vm]); } catch { process.exitCode=1; } }
  if(lease?.listening) await new Promise(resolve=>lease.close(resolve));
}
