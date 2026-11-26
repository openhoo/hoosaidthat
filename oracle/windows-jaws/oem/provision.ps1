$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = 'C:\HooSaidThat-JAWS'
$status = '\\host.lan\Data\bootstrap\status.json'
function Publish([string]$phase, [string]$errorMessage = '') {
  New-Item -ItemType Directory -Path (Split-Path $status) -Force | Out-Null
  $value = @{ phase=$phase; error=$errorMessage; utc=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText("$status.tmp", $value, [Text.UTF8Encoding]::new($false))
  Move-Item "$status.tmp" $status -Force
}
function Download($spec, [string]$name) {
  $path = Join-Path $root "cache\$name"
  # Preseed the same verified media through WinHoo to avoid repeated network downloads.
  $sharedCache = Join-Path '\\host.lan\Data\cache' $name
  if (!(Test-Path $path) -and (Test-Path -LiteralPath $sharedCache)) {
    Copy-Item -LiteralPath $sharedCache -Destination $path
  }
  if (!(Test-Path $path) -or (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $spec.sha256) {
    Invoke-WebRequest $spec.url -UseBasicParsing -OutFile "$path.download" -TimeoutSec 1800
    if ((Get-FileHash "$path.download" -Algorithm SHA256).Hash.ToLowerInvariant() -cne $spec.sha256) { throw "Integrity mismatch: $name" }
    Move-Item "$path.download" $path -Force
  }
  return $path
}
try {
  New-Item -ItemType Directory -Path "$root\cache" -Force | Out-Null
  Publish 'install-payload'
  Copy-Item C:\OEM\runtime-lock.json "$root\runtime-lock.json" -Force
  Copy-Item C:\OEM\start-runtime.ps1 "$root\start-runtime.ps1" -Force
  Copy-Item C:\OEM\run-check.ps1 "$root\run-check.ps1" -Force
  $lock = Get-Content "$root\runtime-lock.json" -Raw | ConvertFrom-Json
  Publish 'download-applications'
  $jaws = Download $lock.jaws 'jaws-installer.exe'
  $node = Download $lock.node 'node.zip'
  $chrome = Download $lock.chrome 'chrome.zip'
  Publish 'install-node-and-chrome'
  Expand-Archive $node "$root\node" -Force
  Expand-Archive $chrome "$root\browser" -Force
  $nodeDirectory = "$root\node\node-v$($lock.node.version)-win-x64"
  $env:Path = "$nodeDirectory;$env:Path"
  New-Item -ItemType Directory -Path "$root\app" -Force | Out-Null
  Copy-Item C:\OEM\hoosaidthat.tgz "$root\app\hoosaidthat.tgz" -Force
  Push-Location "$root\app"
  try {
    & "$nodeDirectory\npm.cmd" install --ignore-scripts --no-audit --no-fund .\hoosaidthat.tgz '@playwright/test@1.62.1'
    if ($LASTEXITCODE -ne 0) { throw 'Installing Hoosaidthat failed' }
  } finally { Pop-Location }

  Publish 'install-jaws'
  $signature = Get-AuthenticodeSignature $jaws
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'CN=Freedom Scientific Inc\.(,|$)') { throw 'JAWS vendor signature invalid' }
  $jawsRoot = Join-Path $env:ProgramFiles ('Freedom Scientific\JAWS\' + $lock.jaws.version.Split('.')[0])
  if (!(Test-Path "$jawsRoot\RemoteCommandServer.dll") -or !(Test-Path "$jawsRoot\jfw.exe")) {
    # Freedom Scientific's bootstrapper reads additionalsettings.ini beside the installer.
    # This opts into the native AT Driver used by the W3C ARIA-AT JAWS harness.
    Copy-Item C:\OEM\additionalsettings.ini "$root\cache\additionalsettings.ini" -Force
    $installer = Start-Process $jaws -WorkingDirectory "$root\cache" -ArgumentList '/type silent' -Wait -PassThru
    if ($installer.ExitCode -notin @(0,3010)) { throw "JAWS installation failed: $($installer.ExitCode)" }
  }
  if (!(Test-Path "$jawsRoot\jfw.exe") -or !(Test-Path "$jawsRoot\RemoteCommandServer.dll")) {
    throw 'JAWS or its Remote Command Server was not installed. Check the vendor installation log and component selection.'
  }
  Publish 'configure-network-and-startup'
  Set-Service iphlpsvc -StartupType Automatic
  Start-Service iphlpsvc
  foreach ($pair in @(@(3000,3003), @(9222,9225))) {
    & netsh.exe interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$($pair[0]) connectaddress=127.0.0.1 connectport=$($pair[1])
    if ($LASTEXITCODE -ne 0) { throw 'Guest port relay configuration failed' }
    Get-NetFirewallRule -DisplayName "Hoosaidthat JAWS $($pair[0])" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName "Hoosaidthat JAWS $($pair[0])" -Direction Inbound -LocalPort $pair[0] -Protocol TCP -Action Allow | Out-Null
  }
  $action = New-ScheduledTaskAction -Execute PowerShell.exe -Argument "-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $root\start-runtime.ps1"
  $principal = New-ScheduledTaskPrincipal -UserId HstJaws -LogonType Interactive -RunLevel Highest
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User HstJaws
  Register-ScheduledTask -TaskName 'HooSaidThat JAWS' -Action $action -Principal $principal -Trigger $trigger -Force | Out-Null
  Publish 'installed-starting-native-driver'
  Start-ScheduledTask -TaskName 'HooSaidThat JAWS'
} catch {
  Publish 'failed' $_.Exception.Message
  throw
}
