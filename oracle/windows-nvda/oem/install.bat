@echo off
setlocal EnableExtensions
set "LOG=%ProgramData%\HooSaidThat\provisioning.log"
if not exist "%ProgramData%\HooSaidThat\" mkdir "%ProgramData%\HooSaidThat" >nul 2>&1
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\OEM\provision.ps1" >>"%LOG%" 2>&1
set "RC=%ERRORLEVEL%"
endlocal & exit /b %RC%
