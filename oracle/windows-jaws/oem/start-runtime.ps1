# Interactive scheduled task, owned only by the dedicated HstJaws Windows user.
$ErrorActionPreference = 'Stop'
if ($env:USERNAME -ine 'HstJaws') { throw 'Start the JAWS bridge only in the interactive HstJaws desktop' }
$root = 'C:\HooSaidThat-JAWS'
function Publish-RuntimeStatus([string]$phase, [string]$errorMessage = '') {
  $status = '\\host.lan\Data\bootstrap\status.json'
  $temporary = "$status.$([Guid]::NewGuid().ToString('N')).tmp"
  $value = @{ phase=$phase; error=$errorMessage; utc=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
  try {
    [IO.File]::WriteAllText($temporary, $value, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $status -Force
  } catch { [Console]::Error.WriteLine('Could not publish JAWS runtime status to the private share.') }
  finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}
function Test-JawsActivationDialog([int[]]$readerPids) {
  try {
    # Only inspect the top-level window identity, never license fields or controls.
    Add-Type -AssemblyName UIAutomationClient
    $children = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
      [System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($w in $children) {
      if ($w.Current.ProcessId -in $readerPids -and $w.Current.Name -ceq 'JAWS Activation') { return $true }
    }
  } catch { }
  return $false
}
$mutex = [Threading.Mutex]::new($false, 'Local\HoosaidthatJawsRuntime')
# Stopping/replacing a scheduled task can abandon its mutex. Windows grants
# ownership to this caller when WaitOne throws AbandonedMutexException.
try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
if (!$acquired) { $mutex.Dispose(); exit 0 }
try {
  Publish-RuntimeStatus 'starting-native-driver'
  $lock = Get-Content "$root\runtime-lock.json" -Raw | ConvertFrom-Json
  $directory = Join-Path $env:ProgramFiles ('Freedom Scientific\JAWS\' + $lock.jaws.version.Split('.')[0])
  $jfw = Join-Path $directory 'jfw.exe'
  if (!(Test-Path $jfw) -or !(Test-Path "$directory\RemoteCommandServer.dll")) { throw 'JAWS with the Remote Command Server component is required' }
  $info = (Get-Item $jfw).VersionInfo
  $actual = '{0}.{1}.{2}.{3}' -f $info.ProductMajorPart,$info.ProductMinorPart,$info.ProductBuildPart,$info.ProductPrivatePart
  if ($actual -cne $lock.jaws.version) { throw 'Installed JAWS version differs from the runtime lock' }
  $session = (Get-Process -Id $PID).SessionId
  $existing = @(Get-Process -Name jfw -ErrorAction SilentlyContinue | Where-Object SessionId -eq $session)
  if ($existing.Count -gt 1 -or ($existing.Count -eq 1 -and $existing[0].Path -ine $jfw)) { throw 'A different JAWS installation is already running' }
  # Use the ARIA-AT harness's exact startup switch. Leave an existing reader alone.
  if (!$existing) { Start-Process $jfw -ArgumentList '/startrcs' }
  $deadline = [DateTime]::UtcNow.AddMinutes(2)
  do {
    $listener = @(Get-NetTCPConnection -LocalPort 9002 -State Listen -ErrorAction SilentlyContinue)
    $jawsPid = @(Get-Process -Name jfw -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $session -and $_.Path -ieq $jfw } | ForEach-Object { $_.Id })
    if ($listener.Count -gt 0 -and @($listener | Where-Object { $_.OwningProcess -in $jawsPid }).Count -eq $listener.Count) { break }
    if ([DateTime]::UtcNow -ge $deadline) {
      if (Test-JawsActivationDialog $jawsPid) { throw 'JAWS Activation is open in the guest. Activate a license that permits automated testing, then run jaws sync.' }
      throw 'JAWS did not open its Remote Command Server; inspect /startrcs and the interactive desktop'
    }
    Start-Sleep -Seconds 1
  } while ($true)
  $node = "$root\node\node-v$($lock.node.version)-win-x64\node.exe"
  $chrome = "$root\browser\chrome-win64\chrome.exe"
  $script = "$root\app\node_modules\@openhoo\hoosaidthat\scripts\native-screen-reader.mjs"
  Publish-RuntimeStatus 'starting-bridge'
  & $node $script --screen-reader jaws --token-file '\\host.lan\Data\secrets\control-token' --browser-executable $chrome *>> "$root\runtime.log"
  if ($LASTEXITCODE -ne 0) { throw 'JAWS bridge exited; see runtime.log in the guest' }
} catch {
  $reason = $_.Exception.Message
  Add-Content "$root\runtime.log" $reason
  # The host can report an actionable startup failure even when the loopback API never opened.
  # Publish only controlled diagnoses; arbitrary native process output stays in the guest.
  $publicReason = if ($reason -like 'JAWS did not open its Remote Command Server*') { 'JAWS did not open its Remote Command Server; inspect licensing, /startrcs and the interactive desktop' }
    elseif ($reason -ceq 'JAWS Activation is open in the guest. Activate a license that permits automated testing, then run jaws sync.') { $reason }
    elseif ($reason -like 'Installed JAWS version differs*') { 'Installed JAWS version differs from the runtime lock' }
    else { 'JAWS bridge failed to start; inspect C:\HooSaidThat-JAWS\runtime.log in the dedicated guest' }
  Publish-RuntimeStatus 'failed' $publicReason
  throw
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
