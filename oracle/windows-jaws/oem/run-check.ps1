$ErrorActionPreference = 'Stop'
$root = 'C:\HooSaidThat-JAWS'
$shared = '\\host.lan\Data'
$lock = Get-Content "$root\runtime-lock.json" -Raw | ConvertFrom-Json
$nodeDirectory = "$root\node\node-v$($lock.node.version)-win-x64"
$env:Path = "$nodeDirectory;$env:Path"
$env:SCREEN_READER = 'jaws'
# The guest bridge is reached directly; 3004/9226 are the host's forwarded ports.
$env:HOOSAIDTHAT_JAWS_CONTROL_ENDPOINT = 'http://127.0.0.1:3003'
$env:HOOSAIDTHAT_JAWS_CDP_ENDPOINT = 'http://127.0.0.1:9225'
$env:HST_NATIVE_TOKEN_FILE = "$shared\secrets\control-token"
$env:HST_NATIVE_RESULTS = "$shared\results\artifacts"
$env:HST_NATIVE_JSON = "$shared\results\native-results.json"
New-Item -ItemType Directory "$shared\results" -Force | Out-Null
$token = [IO.File]::ReadAllText($env:HST_NATIVE_TOKEN_FILE).Trim()
$deadline = [DateTime]::UtcNow.AddMinutes(5)
$ready = $false
Start-ScheduledTask -TaskName 'HooSaidThat JAWS'
while ([DateTime]::UtcNow -lt $deadline) {
  try {
    $response = Invoke-WebRequest 'http://127.0.0.1:3003/v2/health' -UseBasicParsing -TimeoutSec 5 -Headers @{ Authorization="Bearer $token" }
    $health = $response.Content | ConvertFrom-Json
    if ($health.ready -eq $true -and $health.screenReader -ceq 'jaws' -and $health.profile -ceq 'jaws-web' -and $health.capture -ceq 'jaws-speech-output') {
      $ready = $true
      break
    }
  } catch { }
  if ((Get-ScheduledTask -TaskName 'HooSaidThat JAWS').State -ne 'Running') {
    throw 'JAWS bridge exited before readiness. Inspect runtime.log and check JAWS licensing and Remote Command Server in this guest.'
  }
  Start-Sleep -Seconds 2
}
if (!$ready) { throw 'JAWS bridge did not become ready. Inspect runtime.log and the JAWS Remote Command Server.' }
Push-Location "$root\app"
try {
  & "$nodeDirectory\npx.cmd" --no-install playwright test --config node_modules/@openhoo/hoosaidthat/oracle/native-check/playwright.config.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Actual JAWS native smoke failed; inspect the shared results folder.' }
} finally { Pop-Location }
