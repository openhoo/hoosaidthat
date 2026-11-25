[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = 'C:\HooSaidThat'
$Shared = '\\host.lan\Data\bootstrap'
if (Test-Path -LiteralPath 'C:\ProgramData\HooSaidThat\winhoo-owner.json' -PathType Leaf) {
    $Shared = 'C:\ProgramData\HooSaidThat\bootstrap'
}
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
$RuntimeStop = [System.Threading.EventWaitHandle]::new($false,
    [System.Threading.EventResetMode]::ManualReset, 'Global\HooSaidThatNvdaOracleStop')
$null = $RuntimeStop.Reset()

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

function Get-RequestedLocale {
    $locale = if (Test-Path -LiteralPath $RuntimeLocalePath -PathType Leaf) {
        [System.IO.File]::ReadAllText($RuntimeLocalePath).Trim()
    } else {
        'en-US'
    }
    if ($locale -cnotin @('en-US', 'de-DE')) { throw 'runtime locale file is invalid' }
    return $locale
}

function Start-Nvda([string]$Locale) {
    if (-not (Test-Path -LiteralPath $Nvda -PathType Leaf)) { throw 'NVDA executable missing' }
    $nvdaLanguage = if ($Locale -ceq 'de-DE') { 'de' } else { 'en' }
    $env:HST_NVDA_TOKEN_FILE = 'C:\ProgramData\HooSaidThat\control-token'
    $env:HST_NVDA_CONTROL_PORT = '3000'
    if (Test-Path -LiteralPath 'C:\ProgramData\HooSaidThat\winhoo-owner.json') {
        $env:HST_NVDA_LOCAL_ONLY = '1'
    }
    $reader = Start-Process -FilePath $Nvda -ArgumentList @(
        "--config-path=$NvdaConfig",
        "--lang=$nvdaLanguage",
        "--log-file=$NvdaLog"
    ) -WindowStyle Hidden -PassThru
    # Retain this process identity even if it exits before the next supervisor poll.
    $null = $reader.Handle
    return $reader
}

function Initialize-NvdaWindow {
    if ('HstNvdaWindow' -as [type]) { return }
    $null = Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class HstNvdaWindow {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    public static extern IntPtr FindWindowW(string className, string title);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", ExactSpelling = true, SetLastError = true)]
    private static extern bool PostMessageW(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);
    public static void RequestQuit(int pid) {
        // NVDA 2026.1.1 source/nvda.pyw:122-150. Its --quit escalates to TerminateProcess.
        IntPtr window = FindWindowW("wxWindowClassNR", "NVDA");
        uint owner;
        if (window == IntPtr.Zero || GetWindowThreadProcessId(window, out owner) == 0 || owner != (uint)pid)
            throw new InvalidOperationException("The NVDA quit window does not belong to the managed reader");
        if (!PostMessageW(window, 0x0012 /* WM_QUIT */, UIntPtr.Zero, IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not request graceful NVDA shutdown");
    }
}
'@
}

function Switch-NvdaLocale([Diagnostics.Process]$Reader, [Diagnostics.Process]$Browser, [string]$Locale) {
    # Both Process objects hold handles acquired when the supervisor accepted their identities.
    $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
    if ($Reader.HasExited -or $Reader.SessionId -ne $session -or $Reader.Path -ine $Nvda) {
        throw 'The managed NVDA process changed before the language switch'
    }
    if ($Browser.HasExited -or $Browser.SessionId -ne $session -or $Browser.Path -ine $Chrome) {
        throw 'The managed Chrome browser changed before the language switch'
    }
    [HstNvdaWindow]::RequestQuit($Reader.Id)
    if (-not $Reader.WaitForExit(12000)) { throw 'NVDA did not exit gracefully within 12 seconds on language change' }
    # Starting NVDA can terminate an existing instance. Refuse a different reader on this desktop.
    if ([HstNvdaWindow]::FindWindowW('wxWindowClassNR','NVDA') -ne [IntPtr]::Zero) {
        throw 'Another NVDA window appeared during the language switch'
    }
    if ($Browser.HasExited) { throw 'The managed Chrome browser exited during the language switch' }
    return Start-Nvda $Locale
}

function Set-OracleBrowserForeground([Diagnostics.Process]$Browser) {
    # Chrome's CDP listener can be ready while Explorer still owns native input.
    # WinHoo desktops already focus the verified browser through their host.
    if (Test-Path -LiteralPath 'C:\ProgramData\HooSaidThat\winhoo-owner.json') { return }
    if (-not ('HstOracleBrowserWindow' -as [type])) {
        $null = Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HstOracleBrowserWindow {
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    public static bool IsActive(int pid) {
        uint actual;
        return GetWindowThreadProcessId(GetForegroundWindow(), out actual) != 0 && actual == (uint)pid;
    }
}
'@
    }
    $shell = $null
    try {
        $timer = [Diagnostics.Stopwatch]::StartNew()
        do {
            $Browser.Refresh()
            if ($Browser.HasExited) { throw 'The verified Chrome browser exited before its window became active' }
            if ([HstOracleBrowserWindow]::IsActive($Browser.Id)) { return }
            if ($Browser.MainWindowHandle -ne [IntPtr]::Zero) {
                if (-not $shell) { $shell = New-Object -ComObject WScript.Shell }
                $null = $shell.AppActivate([int]$Browser.Id)
            }
            Start-Sleep -Milliseconds 250
        } while ($timer.Elapsed.TotalSeconds -lt 8)
        throw 'The owned Chrome window did not receive native foreground focus on the oracle console'
    } finally {
        if ($shell) { $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
    }
}

function Start-Chrome {
    if (-not (Test-Path -LiteralPath $Chrome -PathType Leaf)) { throw 'Chrome executable missing' }
    [System.IO.Directory]::CreateDirectory($ChromeProfile) | Out-Null
    $bootstrap = ([System.Uri]::new((Join-Path $Root 'bootstrap.html'))).AbsoluteUri
    Start-Process -FilePath $Chrome -ArgumentList @(
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
    ) | Out-Null
    # Chrome for Testing x64 can hand off to a child on Windows ARM64. Waiting
    # on the launcher PID would open the bootstrap URL again every five seconds.
    $session = (Get-Process -Id $PID).SessionId
    $wait = [Diagnostics.Stopwatch]::StartNew()
    do {
        $listeners = @(Get-NetTCPConnection -LocalPort 9223 -State Listen -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalAddress -in @('127.0.0.1','::1') } |
            Select-Object -ExpandProperty OwningProcess -Unique)
        foreach ($browserId in $listeners) {
            $browser = Get-Process -Id $browserId -ErrorAction SilentlyContinue
            if (-not $browser) { continue }
            $null = $browser.Handle
            $info = Get-CimInstance Win32_Process -Filter "ProcessId = $browserId"
            $profileArg = '(?:^|\s)"?--user-data-dir="?' + [regex]::Escape($ChromeProfile) + '"?(?:\s|$)'
            if ($browser.SessionId -ne $session -or $browser.Path -ine $Chrome -or
                -not $info -or $info.CommandLine -notmatch $profileArg) {
                throw 'The Chrome listener belongs to a different program, profile, or session'
            }
            Set-OracleBrowserForeground $browser
            Write-AtomicJson (Join-Path $env:ProgramData 'HooSaidThat\browser-owner.json') ([ordered]@{
                pid = $browser.Id
                createdFileTime = $browser.StartTime.ToUniversalTime().ToFileTimeUtc()
            })
            return $browser
        }
        Start-Sleep -Milliseconds 250
    } while ($wait.Elapsed.TotalSeconds -lt 45)
    throw 'The owned Chrome browser did not start its loopback CDP listener'
}

try {
    [System.IO.Directory]::CreateDirectory($Shared) | Out-Null
    $runtimeLocale = Get-RequestedLocale
    Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.Equals($Nvda, [StringComparison]::OrdinalIgnoreCase)
    } | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Get-Process -Name chrome -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -and $_.Path.StartsWith('C:\HooSaidThat\', [StringComparison]::OrdinalIgnoreCase)
    } | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    $nvdaProcess = Start-Nvda $runtimeLocale
    $chromeProcess = Start-Chrome
    while (-not $RuntimeStop.WaitOne(0)) {
        $requested = Get-RequestedLocale
        if ($requested -cne $runtimeLocale) {
            Initialize-NvdaWindow
            $previousReader = $nvdaProcess
            $nvdaProcess = Switch-NvdaLocale $previousReader $chromeProcess $requested
            $previousReader.Dispose()
            if ($chromeProcess.HasExited) { throw 'The managed Chrome browser exited during the language switch' }
            $runtimeLocale = $requested
        } else {
            if ($nvdaProcess.HasExited) { $nvdaProcess = Start-Nvda $runtimeLocale }
            if ($chromeProcess.HasExited) { $chromeProcess = Start-Chrome }
        }
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
        if ($RuntimeStop.WaitOne(5000)) { break }
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
    $RuntimeStop.Dispose()
    if ($RuntimeMutexHeld) { $RuntimeMutex.ReleaseMutex() }
    $RuntimeMutex.Dispose()
}
