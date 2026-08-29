[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = 'C:\HooSaidThat'
$ProgramDataRoot = Join-Path $env:ProgramData 'HooSaidThat'
$SharedBootstrap = 'Z:\bootstrap'
$StatusPath = Join-Path $SharedBootstrap 'oem-status.json'
$TokenSource = 'Z:\secrets\control-token'
$TokenDestination = Join-Path $ProgramDataRoot 'control-token'
$NvdaSpec = [pscustomobject]@{
    Name = 'nvda_2026.1.1.exe'
    Url = 'https://download.nvaccess.org/releases/2026.1.1/nvda_2026.1.1.exe'
    Sha256 = '6e0289eb5a3aa076eb97ea99c5d5465cb48b5ecc6a3257dc3d811f881a1747c9'
    Bytes = 62914952
}
$ChromeSpec = [pscustomobject]@{
    Name = 'chrome-for-testing-151.0.7922.47-win64.zip'
    Url = 'https://storage.googleapis.com/chrome-for-testing-public/151.0.7922.47/win64/chrome-win64.zip'
    Sha256 = 'fc77bb98b550b7da23b14edfa282b59a022e7fdb075ac7625d2a5152ceb22396'
    Bytes = 201077750
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

function Publish-Status([string]$Status, [string]$Phase, [string]$ErrorMessage = '') {
    Write-AtomicJson $StatusPath ([ordered]@{
        schema = 'hoosaidthat.nvda-oem-status'
        version = 1
        status = $Status
        phase = $Phase
        generatedUtc = [DateTime]::UtcNow.ToString('o')
        error = if ($ErrorMessage) { $ErrorMessage } else { $null }
    })
}

function Get-PinnedArtifact($Spec) {
    $cache = Join-Path $ProgramDataRoot ('cache\' + $Spec.Name)
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $cache)) | Out-Null
    $valid = (Test-Path -LiteralPath $cache -PathType Leaf) -and
        ((Get-Item -LiteralPath $cache).Length -eq $Spec.Bytes) -and
        ((Get-FileHash -LiteralPath $cache -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $Spec.Sha256)
    if (-not $valid) {
        $temporary = "$cache.$([guid]::NewGuid().ToString('N')).download"
        try {
            Invoke-WebRequest -Uri $Spec.Url -UseBasicParsing -TimeoutSec 600 -OutFile $temporary
            if ((Get-Item -LiteralPath $temporary).Length -ne $Spec.Bytes) { throw 'pinned artifact byte count mismatch' }
            if ((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Spec.Sha256) {
                throw 'pinned artifact SHA-256 mismatch'
            }
            Move-Item -LiteralPath $temporary -Destination $cache -Force
        }
        finally {
            if (Test-Path -LiteralPath $temporary) {
                Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
            }
        }
    }
    return $cache
}

try {
    [System.IO.Directory]::CreateDirectory($ProgramDataRoot) | Out-Null
    [System.IO.Directory]::CreateDirectory($SharedBootstrap) | Out-Null
    Publish-Status 'running' 'validate-input'
    if (-not (Test-Path -LiteralPath $TokenSource -PathType Leaf)) { throw 'control token missing from shared secrets' }
    $token = ([System.IO.File]::ReadAllText($TokenSource)).Trim()
    if ($token.Length -lt 32 -or $token.Length -gt 256 -or $token -notmatch '^[A-Za-z0-9_-]+$') {
        throw 'control token shape invalid'
    }
    if (-not (Test-Path -LiteralPath 'C:\OEM\hoosaidthat' -PathType Container)) { throw 'OEM payload missing' }

    Publish-Status 'running' 'install-payload'
    if (Test-Path -LiteralPath $Root) { Remove-Item -LiteralPath $Root -Recurse -Force }
    Copy-Item -LiteralPath 'C:\OEM\hoosaidthat' -Destination $Root -Recurse -Force
    [System.IO.File]::WriteAllText($TokenDestination, $token + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    & icacls.exe $TokenDestination /inheritance:r /grant:r 'HstOracle:R' 'SYSTEM:F' '*S-1-5-32-544:F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'control token ACL configuration failed' }

    Publish-Status 'running' 'configure-openssh'
    & (Join-Path $Root 'configure-ssh.ps1')

    Publish-Status 'running' 'configure-time'
    Set-TimeZone -Id 'UTC'
    Set-Service -Name W32Time -StartupType Automatic
    Start-Service -Name W32Time -ErrorAction SilentlyContinue
    $timeSync = & w32tm.exe /resync /force 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw ('Windows time synchronization failed: ' + (($timeSync | Out-String).Trim() -replace '[\r\n]+', ' '))
    }

    Publish-Status 'running' 'download-pinned-applications'
    $nvdaInstaller = Get-PinnedArtifact $NvdaSpec
    $chromeArchive = Get-PinnedArtifact $ChromeSpec

    Publish-Status 'running' 'install-nvda'
    if (-not (Test-Path -LiteralPath 'C:\Program Files\NVDA\nvda.exe' -PathType Leaf)) {
        $process = Start-Process -FilePath $nvdaInstaller -ArgumentList '--install-silent' -Wait -PassThru
        if ($process.ExitCode -ne 0) { throw 'NVDA installation failed' }
    }

    Publish-Status 'running' 'install-chrome'
    $chromeRoot = Join-Path $Root 'browsers'
    $chromeDirectory = Join-Path $chromeRoot 'chrome-win64'
    $chromeExecutable = Join-Path $chromeDirectory 'chrome.exe'
    if (-not (Test-Path -LiteralPath $chromeExecutable -PathType Leaf)) {
        $stage = Join-Path $ProgramDataRoot ('chrome-' + [guid]::NewGuid().ToString('N'))
        try {
            Expand-Archive -LiteralPath $chromeArchive -DestinationPath $stage -Force
            $source = Join-Path $stage 'chrome-win64'
            if (-not (Test-Path -LiteralPath (Join-Path $source 'chrome.exe') -PathType Leaf)) {
                throw 'Chrome archive layout mismatch'
            }
            [System.IO.Directory]::CreateDirectory($chromeRoot) | Out-Null
            Move-Item -LiteralPath $source -Destination $chromeDirectory -Force
        }
        finally {
            if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
        }
    }

    Publish-Status 'running' 'configure-network'
    foreach ($ruleName in @('HooSaidThat-NVDA-Control', 'HooSaidThat-Chrome-CDP')) {
        Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue |
            Remove-NetFirewallRule -ErrorAction SilentlyContinue
    }
    New-NetFirewallRule -Name 'HooSaidThat-NVDA-Control' -DisplayName 'HooSaidThat NVDA control' -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Any | Out-Null
    New-NetFirewallRule -Name 'HooSaidThat-Chrome-CDP' -DisplayName 'HooSaidThat Chrome CDP' -Direction Inbound -Protocol TCP -LocalPort 9222 -Action Allow -Profile Any | Out-Null

    Publish-Status 'running' 'register-runtime'
    $taskName = 'HooSaidThat NVDA Oracle'
    Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue |
        Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue
    $action = New-ScheduledTaskAction -Execute 'PowerShell.exe' -Argument (
        '-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f (Join-Path $Root 'start-runtime.ps1')
    )
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User 'HstOracle'
    $principal = New-ScheduledTaskPrincipal -UserId 'HstOracle' -LogonType Interactive -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    $commonStartup = [Environment]::GetFolderPath('CommonStartup')
    if (-not $commonStartup) { throw 'Common Startup directory unavailable' }
    Copy-Item -LiteralPath (Join-Path $Root 'runtime-startup.cmd') -Destination (Join-Path $commonStartup 'HooSaidThat-NVDA.cmd') -Force
    Start-ScheduledTask -TaskName $taskName

    Publish-Status 'ready' 'complete'
    exit 0
}
catch {
    $reason = ($_.Exception.Message -replace '[\r\n]+', ' ').Trim()
    try { Publish-Status 'failed' 'provisioning' $reason } catch {}
    exit 1
}
