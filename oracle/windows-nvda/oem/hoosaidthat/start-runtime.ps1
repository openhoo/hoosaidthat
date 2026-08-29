[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = 'C:\HooSaidThat'
$Shared = '\\host.lan\Data\bootstrap'
$Nvda = 'C:\Program Files\NVDA\nvda.exe'
$Chrome = 'C:\HooSaidThat\browsers\chrome-win64\chrome.exe'
$NvdaConfig = Join-Path $Root 'nvdaConfig'
$NvdaLog = Join-Path $env:ProgramData 'HooSaidThat\nvda.log'
$ChromeProfile = Join-Path $env:LOCALAPPDATA 'HooSaidThat\ChromeProfile'
$RuntimeLocalePath = Join-Path $Root 'runtime-locale.txt'
$StatusPath = Join-Path $Shared 'runtime-status.json'
$RuntimeMutex = [System.Threading.Mutex]::new($false, 'Global\HooSaidThatNvdaOracle')
$RuntimeMutexHeld = $false
try { $RuntimeMutexHeld = $RuntimeMutex.WaitOne(0) }
catch [System.Threading.AbandonedMutexException] { $RuntimeMutexHeld = $true }
if (-not $RuntimeMutexHeld) {
    $RuntimeMutex.Dispose()
    exit 0
}

function Write-AtomicJson([string]$Path, $Value) {
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
    $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [System.IO.File]::WriteAllText(
            $temporary,
            (($Value | ConvertTo-Json -Depth 8 -Compress) + [Environment]::NewLine),
            [System.Text.UTF8Encoding]::new($false)
        )
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
    }
}

function Start-Nvda {
    if (-not (Test-Path -LiteralPath $Nvda -PathType Leaf)) { throw 'NVDA executable missing' }
    $locale = if (Test-Path -LiteralPath $RuntimeLocalePath -PathType Leaf) {
        [System.IO.File]::ReadAllText($RuntimeLocalePath).Trim()
    } else {
        'en-US'
    }
    if ($locale -cnotin @('en-US', 'de-DE')) { throw 'runtime locale file is invalid' }
    $nvdaLanguage = if ($locale -ceq 'de-DE') { 'de' } else { 'en' }
    $env:HST_NVDA_TOKEN_FILE = 'C:\ProgramData\HooSaidThat\control-token'
    $env:HST_NVDA_CONTROL_PORT = '3000'
    return Start-Process -FilePath $Nvda -ArgumentList @(
        "--config-path=$NvdaConfig",
        "--lang=$nvdaLanguage",
        "--log-file=$NvdaLog"
    ) -WindowStyle Hidden -PassThru
}

function Start-Chrome {
    if (-not (Test-Path -LiteralPath $Chrome -PathType Leaf)) { throw 'Chrome executable missing' }
    [System.IO.Directory]::CreateDirectory($ChromeProfile) | Out-Null
    $bootstrap = ([System.Uri]::new((Join-Path $Root 'bootstrap.html'))).AbsoluteUri
    return Start-Process -FilePath $Chrome -ArgumentList @(
        "--user-data-dir=$ChromeProfile",
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=9223',
        '--remote-allow-origins=*',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--disable-features=MediaRouter,OptimizationHintsFetching',
        '--window-size=1280,720',
        $bootstrap
    ) -PassThru
}

try {
    [System.IO.Directory]::CreateDirectory($Shared) | Out-Null
    $runtimeLocale = if (Test-Path -LiteralPath $RuntimeLocalePath -PathType Leaf) {
        [System.IO.File]::ReadAllText($RuntimeLocalePath).Trim()
    } else {
        'en-US'
    }
    if ($runtimeLocale -cnotin @('en-US', 'de-DE')) { throw 'runtime locale file is invalid' }
    Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.Equals($Nvda, [StringComparison]::OrdinalIgnoreCase)
    } | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Get-Process -Name chrome -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -and $_.Path.StartsWith('C:\HooSaidThat\', [StringComparison]::OrdinalIgnoreCase)
    } | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    $nvdaProcess = Start-Nvda
    $chromeProcess = Start-Chrome
    while ($true) {
        if ($nvdaProcess.HasExited) { $nvdaProcess = Start-Nvda }
        if ($chromeProcess.HasExited) { $chromeProcess = Start-Chrome }
        Write-AtomicJson $StatusPath ([ordered]@{
            schema = 'hoosaidthat.nvda-runtime-status'
            version = 1
            ready = $true
            generatedUtc = [DateTime]::UtcNow.ToString('o')
            nvdaPid = $nvdaProcess.Id
            chromePid = $chromeProcess.Id
            controlPort = 3000
            cdpPort = 9222
            chromeLoopbackCdpPort = 9223
            locale = $runtimeLocale
        })
        Start-Sleep -Seconds 5
    }
}
catch {
    Write-AtomicJson $StatusPath ([ordered]@{
        schema = 'hoosaidthat.nvda-runtime-status'
        version = 1
        ready = $false
        generatedUtc = [DateTime]::UtcNow.ToString('o')
        error = $_.Exception.Message
    })
    throw
}
finally {
    if ($RuntimeMutexHeld) { $RuntimeMutex.ReleaseMutex() }
    $RuntimeMutex.Dispose()
}
