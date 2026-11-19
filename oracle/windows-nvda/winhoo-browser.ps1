# Resolve the live browser process on this boot. Chrome for Testing on ARM64
# can hand off to a child; its launcher and renderer PIDs are not window owners.
$ErrorActionPreference = 'Stop'
$file = 'C:\ProgramData\HooSaidThat\bootstrap\runtime-status.json'
$exe = 'C:\HooSaidThat\browsers\chrome-win64\chrome.exe'
$profile = [regex]::Escape((Join-Path $env:LOCALAPPDATA 'HooSaidThat\ChromeProfile'))
$timer = [Diagnostics.Stopwatch]::StartNew()
$probeStart = [DateTimeOffset]::UtcNow
$script:lastPhase = ''
function Set-ProbePhase([string]$Phase) {
    if ($Phase -ne $script:lastPhase) {
        $script:lastPhase = $Phase
        [Console]::Error.WriteLine("HST browser: $Phase")
    }
}
Set-ProbePhase 'waiting for runtime heartbeat'
do {
    if (Test-Path -LiteralPath $file -PathType Leaf) {
        $s = Get-Content -Raw -LiteralPath $file | ConvertFrom-Json
        if ($s.schema -ceq 'hoosaidthat.nvda-runtime-status' -and $s.generatedUtc) {
            $generated = [DateTimeOffset]::Parse([string]$s.generatedUtc)
            $age = ([DateTimeOffset]::UtcNow - $generated).TotalSeconds
            if ($s.ready -eq $false -and $generated -ge $probeStart -and $age -ge -30 -and $age -le 15) {
                Set-ProbePhase 'runtime supervisor reported startup failure'
                throw 'The live NVDA runtime reported a failure during browser discovery'
            }
            if ($s.ready -eq $true -and $age -ge -30 -and $age -le 15 -and $s.chromeLoopbackCdpPort -eq 9223) {
                Set-ProbePhase 'checking Chrome and its loopback listener'
                $browser = Get-Process -Id ([int]$s.chromePid) -ErrorAction SilentlyContinue
                $owners = @(Get-NetTCPConnection -LocalPort 9223 -State Listen -ErrorAction SilentlyContinue |
                    Where-Object { $_.LocalAddress -in @('127.0.0.1','::1') } |
                    Select-Object -ExpandProperty OwningProcess -Unique)
                if ($browser -and $owners.Count -eq 1 -and $owners[0] -eq $browser.Id) {
                    Set-ProbePhase 'verifying the listener process, profile and owner'
                    $info = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $browser.Id)
                    if ($browser.Path -ine $exe -or !$info -or $info.CommandLine -notmatch ('(?:^|\s)"?--user-data-dir="?' + $profile + '"?(?:\s|$)')) {
                        throw 'The CDP listener is not the configured HooSaidThat browser'
                    }
                    $user = Invoke-CimMethod -InputObject $info -MethodName GetOwner
                    if ($user.ReturnValue -ne 0 -or $user.User -ine $env:USERNAME -or $user.Domain -ine $env:COMPUTERNAME -or $browser.HasExited) {
                        throw 'Browser ownership changed during foreground discovery'
                    }
                    Set-ProbePhase 'verified live browser'
                    @{pid=$browser.Id; startedTicks=$browser.StartTime.ToUniversalTime().Ticks; session=$browser.SessionId} | ConvertTo-Json -Compress
                    return
                }
            }
        }
    }
    Start-Sleep -Milliseconds 500
} while ($timer.Elapsed.TotalSeconds -lt 150)
throw 'The current Chrome runtime and its loopback listener were not ready for activation'
