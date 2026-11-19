# Resolve the live browser process on this boot. Chrome for Testing on ARM64
# can hand off to a child; its launcher and renderer PIDs are not window owners.
$ErrorActionPreference = 'Stop'
$file = 'C:\ProgramData\HooSaidThat\bootstrap\runtime-status.json'
$exe = 'C:\HooSaidThat\browsers\chrome-win64\chrome.exe'
$profile = [regex]::Escape((Join-Path $env:LOCALAPPDATA 'HooSaidThat\ChromeProfile'))
$timer = [Diagnostics.Stopwatch]::StartNew()
do {
    if (Test-Path -LiteralPath $file -PathType Leaf) {
        $s = Get-Content -Raw -LiteralPath $file | ConvertFrom-Json
        if ($s.schema -ceq 'hoosaidthat.nvda-runtime-status' -and $s.ready -eq $true -and $s.generatedUtc) {
            $age = ([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse([string]$s.generatedUtc)).TotalSeconds
            if ($age -ge -30 -and $age -le 15 -and $s.chromeLoopbackCdpPort -eq 9223) {
                $browser = Get-Process -Id ([int]$s.chromePid) -ErrorAction SilentlyContinue
                $owners = @(Get-NetTCPConnection -LocalPort 9223 -State Listen -ErrorAction SilentlyContinue |
                    Where-Object { $_.LocalAddress -in @('127.0.0.1','::1') } |
                    Select-Object -ExpandProperty OwningProcess -Unique)
                if ($browser -and $owners.Count -eq 1 -and $owners[0] -eq $browser.Id) {
                    $info = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $browser.Id)
                    if ($browser.Path -ine $exe -or !$info -or $info.CommandLine -notmatch ('(?:^|\s)"?--user-data-dir="?' + $profile + '"?(?:\s|$)')) {
                        throw 'The CDP listener is not the configured HooSaidThat browser'
                    }
                    $user = Invoke-CimMethod -InputObject $info -MethodName GetOwner
                    if ($user.ReturnValue -ne 0 -or $user.User -ine $env:USERNAME -or $user.Domain -ine $env:COMPUTERNAME -or $browser.HasExited) {
                        throw 'Browser ownership changed during foreground discovery'
                    }
                    @{pid=$browser.Id; startedTicks=$browser.StartTime.ToUniversalTime().Ticks; session=$browser.SessionId} | ConvertTo-Json -Compress
                    return
                }
            }
        }
    }
    Start-Sleep -Milliseconds 500
} while ($timer.Elapsed.TotalSeconds -lt 90)
throw 'The current Chrome runtime and its loopback listener were not ready for activation'
