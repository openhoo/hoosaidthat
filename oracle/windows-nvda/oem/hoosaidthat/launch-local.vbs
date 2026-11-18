' Run the WinHoo desktop supervisor without opening a console over Chrome.
Option Explicit
Dim shell, exe, supervisor
Set shell = CreateObject("WScript.Shell")
exe = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
supervisor = "C:\HooSaidThat\start-runtime.ps1"
WScript.Quit shell.Run("""" & exe & """ -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & supervisor & """", 0, True)
