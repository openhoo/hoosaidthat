# Exercise the actual supervisor functions with disposable child processes. No installed reader or browser is used.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$source = Join-Path $PSScriptRoot '../oem/hoosaidthat/start-runtime.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Resolve-Path $source), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw $errors[0] }
function Get-FunctionSource([string]$name) {
    $function = $ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name}, $false)
    return $function.Extent.Text
}
. ([scriptblock]::Create((Get-FunctionSource 'Initialize-NvdaWindow')))
Initialize-NvdaWindow
# Compile the native declarations on every platform; call user32 only on Windows.
$windows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
if ($windows) {
    # Never send WM_QUIT to a real NVDA window on the test desktop.
    try { [HstNvdaWindow]::RequestQuit(-1); throw 'Unexpected owner match' }
    catch { if ($_.Exception.ToString() -notmatch 'does not belong') { throw } }
}
# Isolate the quit boundary so every failure case can be induced without touching native applications.
$switch = Get-FunctionSource 'Switch-NvdaLocale'
. ([scriptblock]::Create($switch.Replace('[HstNvdaWindow]', '[FixtureNvdaWindow]')))
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
public static class FixtureNvdaWindow {
    public static int ExpectedPid, StopBrowser, Requests;
    public static bool Foreign, Timeout, Occupied;
    public static string Signal;
    public static void RequestQuit(int pid) {
        Requests++;
        if (Foreign || pid != ExpectedPid) throw new InvalidOperationException("foreign NVDA quit window");
        if (StopBrowser != 0) { var p = Process.GetProcessById(StopBrowser); p.Kill(); p.WaitForExit(); }
        if (!Timeout) System.IO.File.WriteAllText(Signal,"quit");
    }
    public static IntPtr FindWindowW(string cls, string title) {
        if (cls != "wxWindowClassNR" || title != "NVDA") throw new InvalidOperationException("wrong NVDA window");
        return Occupied ? new IntPtr(1234) : IntPtr.Zero;
    }
}
'@
$binary = (Get-Process -Id $PID).Path
$testDir = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString('N'))
$null = [IO.Directory]::CreateDirectory($testDir)
function Start-Fixture([string]$Signal) {
    $literal = $Signal.Replace("'", "''")
    $body = "while (-not [IO.File]::Exists('$literal')) { Start-Sleep -Milliseconds 80 }"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($body))
    $p = Start-Process -FilePath $binary -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand',$encoded) -PassThru
    $null = $p.Handle; return $p
}
function Start-Nvda([string]$Locale) {
    if ($Locale -ne 'de-DE' -or -not $reader.HasExited -or $reader.ExitCode -ne 0 -or $browser.HasExited) { throw 'Replacement started before graceful exit, or Chrome changed' }
    $script:starts++; return 'replacement'
}
try {
    foreach ($case in 'success','foreign','timeout','readerGone','chromeGone','chromeLost','foreignReplacement','wrongBinary') {
        $signal = Join-Path $testDir $case
        $reader = Start-Fixture $signal; $browser = Start-Fixture ($signal+'-chrome')
        try {
            $Nvda=$binary; $Chrome=$binary; $script:starts=0
            [FixtureNvdaWindow]::ExpectedPid=$reader.Id; [FixtureNvdaWindow]::Signal=$signal
            [FixtureNvdaWindow]::Requests=0; [FixtureNvdaWindow]::Foreign=$case -eq 'foreign'; [FixtureNvdaWindow]::Timeout=$case -eq 'timeout'
            [FixtureNvdaWindow]::Occupied=$case -eq 'foreignReplacement'; [FixtureNvdaWindow]::StopBrowser=0
            $expected = switch ($case) {
                'foreign' { 'foreign NVDA quit window' }
                'timeout' { 'did not exit gracefully' }
                'readerGone' { $reader.Kill(); $reader.WaitForExit(); 'managed NVDA process changed' }
                'chromeGone' { $browser.Kill(); $browser.WaitForExit(); 'managed Chrome browser changed' }
                'chromeLost' { [FixtureNvdaWindow]::StopBrowser=$browser.Id; 'Chrome browser exited' }
                'foreignReplacement' { 'Another NVDA window' }
                'wrongBinary' { $Nvda=$binary+'.other'; 'managed NVDA process changed' }
                default { '' }
            }
            $failure=$null; $result=$null; $time=[Diagnostics.Stopwatch]::StartNew()
            try { $result=Switch-NvdaLocale $reader $browser 'de-DE' } catch { $failure=$_.Exception.ToString() }
            if ($case -eq 'success') {
                if ($failure -or $result -ne 'replacement' -or $starts -ne 1 -or [FixtureNvdaWindow]::Requests -ne 1) { throw "Missing successful switch: $failure" }
            } elseif (-not $failure -or $failure -notmatch $expected -or $starts -ne 0) { throw "Unverified refusal ($case): $failure" }
            if ($case -eq 'timeout' -and ($reader.HasExited -or $browser.HasExited -or $time.Elapsed.TotalSeconds -lt 11 -or $time.Elapsed.TotalSeconds -gt 25)) { throw 'Timeout killed a process or missed its deadline' }
            if ($case -in 'readerGone','chromeGone','wrongBinary' -and [FixtureNvdaWindow]::Requests -ne 0) { throw 'Sent a quit message without verifying both owners' }
            if ($case -eq 'foreign' -and ($reader.HasExited -or $browser.HasExited)) { throw 'Wrong owner was disturbed' }
        } finally { foreach ($p in $reader,$browser) { if (-not $p.HasExited) { $p.Kill(); $p.WaitForExit() }; $p.Dispose() } }
    }
} finally { [IO.Directory]::Delete($testDir,$true) }
Write-Output 'Verified graceful replacement, timeout, wrong owner, lost processes and no unsafe relaunch.'
