# Executed by the WinHoo guest agent in the dedicated JAWS Windows VM.
# The host substitutes a digest of a fixed list of file hashes; no caller input
# supplies a path, program or script to execute.
$ErrorActionPreference = 'Stop'
$root = 'C:\HooSaidThat-JAWS'
$payload = Join-Path '\\host.lan\Data\updates' '__HST_UPDATE_SHA256__'
$checked = '__HST_UPDATE_SHA256__'
$files = @('hoosaidthat.tgz', 'runtime-lock.json', 'start-runtime.ps1', 'run-check.ps1')
$stage = Join-Path $root ('update-' + [Guid]::NewGuid().ToString('N'))
$taskName = 'HooSaidThat JAWS'
$task = Get-ScheduledTask -TaskName $taskName
if ($task.Principal.UserId -notmatch '(?:^|\\)HstJaws$') { throw 'The runtime task does not belong to HstJaws.' }
$mutex = [Threading.Mutex]::new($false,'Global\HooSaidThatJawsUpdate')
if (!$mutex.WaitOne(0)) { throw 'A reader update is already in progress.' }
try {
  New-Item -ItemType Directory $stage | Out-Null
  $hashes = @()
  foreach ($file in $files) {
    Copy-Item -LiteralPath (Join-Path $payload $file) -Destination (Join-Path $stage $file)
    $hashes += (Get-FileHash -LiteralPath (Join-Path $stage $file) -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::ASCII.GetBytes([string]::Join(':', $hashes))
    $digest = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant()
  } finally { $sha.Dispose() }
  if ($digest -cne $checked) { throw 'Staged JAWS package or runtime scripts changed in transit.' }
  $current = Get-Content "$root\runtime-lock.json" -Raw | ConvertFrom-Json
  $next = Get-Content "$stage\runtime-lock.json" -Raw | ConvertFrom-Json
  foreach ($p in @('jaws','chrome','node')) {
    if ($current.$p.sha256 -cne $next.$p.sha256) { throw "The $p version changed; provision a new reader guest for those pins." }
  }
  $node = "$root\node\node-v$($current.node.version)-win-x64"
  $env:Path = "$node;$env:Path"
  $app = Join-Path $stage 'app'
  New-Item -ItemType Directory $app | Out-Null
  Copy-Item -LiteralPath "$stage\hoosaidthat.tgz" -Destination "$app\hoosaidthat.tgz"
  Push-Location $app
  try {
    # A fresh npm project must resolve the new tarball, even at the same version.
    & "$node\npm.cmd" install --ignore-scripts --no-audit --no-fund '.\hoosaidthat.tgz' '@playwright/test@1.62.1' *> "$stage\install.log"
    if ($LASTEXITCODE -ne 0) { throw 'Installing the staged HooSaidThat package failed.' }
    if (!(Test-Path 'node_modules\@openhoo\hoosaidthat\scripts\native-screen-reader.mjs')) { throw 'Staged package has no native bridge.' }
  } finally { Pop-Location }
  Stop-ScheduledTask -TaskName $taskName
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while ((Get-ScheduledTask -TaskName $taskName).State -eq 'Running') {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Reader task failed to stop; current app retained.' }
    Start-Sleep -Milliseconds 500
  }
  $old = Join-Path $stage 'previous'
  New-Item -ItemType Directory $old | Out-Null
  try {
    foreach ($f in @('start-runtime.ps1','run-check.ps1')) { Copy-Item -LiteralPath "$root\$f" -Destination "$old\$f" }
    Move-Item -LiteralPath "$root\app" -Destination "$old\app"
    Move-Item -LiteralPath $app -Destination "$root\app"
    foreach ($f in @('start-runtime.ps1','run-check.ps1')) { Copy-Item -LiteralPath "$stage\$f" -Destination "$root\$f" -Force }
    Start-ScheduledTask -TaskName $taskName
  } catch {
    $errorMessage=$_.Exception.Message
    if (Test-Path "$old\app") {
      if (Test-Path "$root\app") { Move-Item -LiteralPath "$root\app" -Destination "$stage\rejected" }
      Move-Item -LiteralPath "$old\app" -Destination "$root\app"
      foreach ($f in @('start-runtime.ps1','run-check.ps1')) { Copy-Item -LiteralPath "$old\$f" -Destination "$root\$f" -Force }
    }
    Start-ScheduledTask -TaskName $taskName
    throw $errorMessage
  }
  [Console]::WriteLine("Installed reader update $checked")
  Remove-Item -LiteralPath $stage -Recurse -Force
} finally {
  # Preserve a failed isolated update directory and log for diagnosis.
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
