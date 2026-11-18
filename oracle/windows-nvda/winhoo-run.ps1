# Called once by WinHoo via a pinned, authenticated session to the dedicated guest.
param([ValidatePattern('^[a-f0-9]{32}$')][string]$Attempt,
      [ValidatePattern('^[a-f0-9]{64}$')][string]$BundleHash,
      [ValidatePattern('^(core|actions-0[1-8]|settings|matrix)$')][string]$Mode,
      [ValidatePattern('^[a-f0-9-]{36}$')][string]$Owner,
      [ValidateSet('en-US','de-DE')][string]$Locale,
      [ValidateSet('desktop','laptop')][string]$Layout)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$root='C:\ProgramData\HooSaidThat'
$binding=Get-Content "$root\winhoo-owner.json" -Raw | ConvertFrom-Json
$desktop=Get-Content 'C:\ProgramData\WinHoo\owner.json' -Raw | ConvertFrom-Json
if ($env:USERNAME -ine 'HstOracle' -or $binding.uuid -cne $Owner -or $desktop.uuid -cne $Owner) { throw 'Different guest owner' }
$zip=Join-Path $env:USERPROFILE "hst-$Attempt.zip"
$work=Join-Path $root "attempts\$Attempt"
if (Test-Path -LiteralPath $work) { throw 'Attempt already exists; refusing duplicate native input' }
if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ine $BundleHash) { throw 'Runner content differs from the host' }
New-Item -ItemType Directory -Path $work | Out-Null
$evidence=Join-Path $work 'evidence'
New-Item -ItemType Directory -Path $evidence | Out-Null
$err=$null; $code=1
try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($zip,$work)
    $env:HST_WINHOO_GUEST=$Owner
    $env:HST_NVDA_QUALIFICATION='1'
    $env:PLAYWRIGHT_BROWSERS_PATH=Join-Path $work 'browsers'
    $env:CI='1'
    $env:PATH="$work;$env:PATH"
    Push-Location $evidence
    try {
        if ($Mode -eq 'matrix') {
            & "$work\node.exe" "$work\package\scripts\nvda-windows.mjs" parity
        } else {
            & "$work\node.exe" "$work\package\scripts\nvda-windows.mjs" parity-shard $Locale $Layout $Mode
        }
        $code=$LASTEXITCODE
    } finally { Pop-Location }
} catch { $err=$_.Exception.Message }
finally {
    $i=@{attempt=$Attempt;owner=$Owner;bundle=$BundleHash;mode=$Mode;exitCode=$code;error=$err}
    if ($Mode -ne 'matrix') { $i.locale=$Locale; $i.layout=$Layout }
    [IO.File]::WriteAllText("$evidence\guest.json",($i|ConvertTo-Json -Compress))
    $out=Join-Path $env:USERPROFILE "hst-$Attempt-reports.zip"
    $summary=Join-Path $work 'summary'
    New-Item -ItemType Directory -Path $summary | Out-Null
    foreach ($f in @('guest.json','blocks.jsonl','reports')) {
        if (Test-Path "$evidence\$f") { Copy-Item "$evidence\$f" $summary -Recurse }
    }
    [IO.Compression.ZipFile]::CreateFromDirectory($summary,$out)
    Remove-Item -LiteralPath $zip -Force
}
if ($err) { Write-Error $err }
exit $code
