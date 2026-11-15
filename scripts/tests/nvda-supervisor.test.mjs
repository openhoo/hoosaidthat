import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dispatcher = readFileSync(new URL('../../oracle/windows-nvda/oem/hoosaidthat/ssh-dispatch.ps1', import.meta.url), 'utf8');
const matches = [...dispatcher.matchAll(/\[string\]\$process\.CommandLine -match '([^']+)'\) \{\s*\$role = 'runtime-supervisor'/g)];
assert.equal(matches.length, 1, 'Die tatsächliche Supervisor-Regex muss eindeutig aus dem Dispatcher stammen.');
assert.ok(matches[0][1].startsWith('(?i)'), 'Die PowerShell-Regex muss Groß- und Kleinschreibung ignorieren.');
const supervisor = new RegExp(matches[0][1].slice(4), 'i');

test('NVDA-Diagnose erkennt den beobachteten vollständig zitierten Supervisor-Aufruf', () => {
  const observed = String.raw`"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" "-NoLogo" "-NoProfile" "-NonInteractive" "-ExecutionPolicy" "Bypass" "-File" "C:\HooSaidThat\start-runtime.ps1"`;
  assert.ok(supervisor.test(observed), observed);
});

test('NVDA-Diagnose erkennt unzitierte und gemischt zitierte File-Argumente', () => {
  for (const command of [
    String.raw`powershell.exe -NoProfile -File C:\HooSaidThat\start-runtime.ps1`,
    String.raw`powershell.exe -File "C:\HooSaidThat\start-runtime.ps1"`,
    String.raw`powershell.exe "-File" C:\HooSaidThat\start-runtime.ps1`,
    String.raw`powershell.exe "-fIlE" "c:\hoosaidthat\START-RUNTIME.PS1"`,
  ]) {
    assert.ok(supervisor.test(command), command);
  }
});

test('NVDA-Diagnose verwirft andere Befehle und Scriptpfade', () => {
  for (const command of [
    String.raw`powershell.exe -Command C:\HooSaidThat\start-runtime.ps1`,
    String.raw`powershell.exe -File C:\HooSaidThat\stop-runtime.ps1`,
    String.raw`powershell.exe -File C:\Other\start-runtime.ps1`,
    String.raw`powershell.exe --File C:\HooSaidThat\start-runtime.ps1`,
    String.raw`powershell.exe -File:C:\HooSaidThat\start-runtime.ps1`,
    String.raw`powershell.exe "-File C:\HooSaidThat\start-runtime.ps1"`,
  ]) {
    assert.equal(supervisor.test(command), false, command);
  }
});

test('NVDA-Diagnose verwechselt Pfadsuffixe nicht mit dem Supervisor-Script', () => {
  for (const command of [
    String.raw`powershell.exe -File C:\HooSaidThat\start-runtime.ps1.bak`,
    String.raw`powershell.exe "-File" "C:\HooSaidThat\start-runtime.ps1.bak"`,
    String.raw`powershell.exe -File C:\HooSaidThat\start-runtime.ps1\other.ps1`,
    String.raw`powershell.exe "-File" "C:\HooSaidThat\start-runtime.ps1"suffix`,
  ]) {
    assert.equal(supervisor.test(command), false, command);
  }
});

test('NVDA-Diagnose verwirft unvollständige Zitate an File und Scriptpfad', () => {
  for (const command of [
    String.raw`powershell.exe "-File C:\HooSaidThat\start-runtime.ps1`,
    String.raw`powershell.exe -File" C:\HooSaidThat\start-runtime.ps1`,
    String.raw`powershell.exe -File "C:\HooSaidThat\start-runtime.ps1`,
    String.raw`powershell.exe -File C:\HooSaidThat\start-runtime.ps1"`,
    String.raw`powershell.exe "-File" "C:\HooSaidThat\start-runtime.ps1`,
  ]) {
    assert.equal(supervisor.test(command), false, command);
  }
});
