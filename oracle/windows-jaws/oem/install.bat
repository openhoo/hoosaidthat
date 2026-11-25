@echo off
if not exist "%ProgramData%\HooSaidThat-JAWS" mkdir "%ProgramData%\HooSaidThat-JAWS"
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\OEM\provision.ps1 >"%ProgramData%\HooSaidThat-JAWS\provision.log" 2>&1
exit /b %ERRORLEVEL%
