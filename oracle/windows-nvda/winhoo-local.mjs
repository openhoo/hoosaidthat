// Local control from the test process inside the dedicated Windows guest.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';

export function localDesktop(env = process.env) {
  if (!env.HST_WINHOO_GUEST) return undefined;
  if (process.platform !== 'win32' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(env.HST_WINHOO_GUEST)) {
    throw new Error('The WinHoo guest runner requires its owned Windows desktop');
  }
  const desktop = { uuid: env.HST_WINHOO_GUEST };
  requireDesktop(desktop);
  return desktop;
}

export function requireDesktop(desktop) {
  const json = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
  const owner = json('C:/ProgramData/WinHoo/owner.json');
  const app = json('C:/ProgramData/HooSaidThat/winhoo-owner.json');
  if (owner.uuid !== desktop.uuid || app.uuid !== desktop.uuid ||
      owner.account !== 'HstOracle' || userInfo().username.toLowerCase() !== 'hstoracle') {
    throw new Error('The interactive test account or desktop owner changed');
  }
}

export function localControl(desktop, command, timeout) {
  if (!['status', 'locale-en-US', 'locale-de-DE'].includes(command)) throw new Error('Unsupported desktop control command');
  requireDesktop(desktop);
  return spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', 'C:/HooSaidThat/ssh-dispatch.ps1'],
    { env: { ...process.env, SSH_ORIGINAL_COMMAND: command }, encoding: 'utf8', timeout, maxBuffer: 1024*1024, windowsHide: true });
}
