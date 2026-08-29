[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TaskName = 'HooSaidThat NVDA Oracle'
$RuntimeStatusPath = '\\host.lan\Data\bootstrap\runtime-status.json'
$NvdaLogPath = 'C:\ProgramData\HooSaidThat\nvda.log'
$NvdaExecutable = 'C:\Program Files\NVDA\nvda.exe'
$ChromeRoot = 'C:\HooSaidThat\browsers\chrome-win64\'
$RuntimeLocalePath = 'C:\HooSaidThat\runtime-locale.txt'
$Command = [string]$env:SSH_ORIGINAL_COMMAND
$PayloadRoot = '\\host.lan\Data\control\payloads'
$MaxPayloadFileBytes = 2MB
$MaxPayloadBytes = 8MB
$Destinations = [ordered]@{
    'bootstrap.html' = 'C:\HooSaidThat\bootstrap.html'
    'configure-ssh.ps1' = 'C:\HooSaidThat\configure-ssh.ps1'
    'nvdaConfig/nvda.ini' = 'C:\HooSaidThat\nvdaConfig\nvda.ini'
    'nvdaConfig/scratchpad/globalPlugins/hoosaidthatControl.py' = 'C:\HooSaidThat\nvdaConfig\scratchpad\globalPlugins\hoosaidthatControl.py'
    'runtime-startup.cmd' = 'C:\HooSaidThat\runtime-startup.cmd'
    'ssh-dispatch.ps1' = 'C:\HooSaidThat\ssh-dispatch.ps1'
    'start-runtime.ps1' = 'C:\HooSaidThat\start-runtime.ps1'
}

function Write-Json($Value) {
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Depth 10 -Compress))
}

function Get-ProcessSnapshot {
    $nvda = @()
    $chrome = @()
    foreach ($process in @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue)) {
        $path = [string]$process.ExecutablePath
        if ($path -and $path.Equals($NvdaExecutable, [StringComparison]::OrdinalIgnoreCase)) {
            $nvda += [int]$process.ProcessId
        }
        elseif ($path -and $path.StartsWith($ChromeRoot, [StringComparison]::OrdinalIgnoreCase)) {
            $chrome += [int]$process.ProcessId
        }
    }
    return [ordered]@{ nvdaPids = @($nvda); chromePids = @($chrome) }
}

function Get-RuntimeStatus {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
    $runtime = $null
    if (Test-Path -LiteralPath $RuntimeStatusPath -PathType Leaf) {
        try {
            if ((Get-Item -LiteralPath $RuntimeStatusPath -Force).Length -gt 65536) {
                throw 'runtime status too large'
            }
            $runtime = [System.IO.File]::ReadAllText($RuntimeStatusPath) | ConvertFrom-Json
        }
        catch { $runtime = [ordered]@{ invalid = $true } }
    }
    $processes = Get-ProcessSnapshot
    $runtimeFresh = $false
    if ($runtime -and $runtime.generatedUtc) {
        try {
            $generated = [DateTimeOffset]::Parse(
                [string]$runtime.generatedUtc,
                [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::RoundtripKind
            )
            $ageSeconds = ([DateTimeOffset]::UtcNow - $generated.ToUniversalTime()).TotalSeconds
            $runtimeFresh = $ageSeconds -ge -30 -and $ageSeconds -le 15
        }
        catch { $runtimeFresh = $false }
    }
    $effectiveReady = $runtime -and $runtime.ready -eq $true -and $runtimeFresh -and $processes.nvdaPids.Count -gt 0 -and $processes.chromePids.Count -gt 0
    return [ordered]@{
        schema = 'hoosaidthat.nvda-ssh-control'
        version = 1
        command = 'status'
        generatedUtc = [DateTime]::UtcNow.ToString('o')
        ready = $effectiveReady
        runtimeFresh = $runtimeFresh
        task = [ordered]@{
            state = [string]$task.State
            lastRunUtc = if ($taskInfo.LastRunTime -eq [DateTime]::MinValue) { $null } else { $taskInfo.LastRunTime.ToUniversalTime().ToString('o') }
            lastTaskResult = [int64]$taskInfo.LastTaskResult
        }
        processes = $processes
        runtime = $runtime
    }
}

function Stop-OwnedRuntime {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    $snapshot = Get-ProcessSnapshot
    foreach ($processId in @($snapshot.nvdaPids) + @($snapshot.chromePids)) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
}

function Set-RuntimeLocale([string]$Locale) {
    if ($Locale -cnotin @('en-US', 'de-DE')) { throw 'unsupported runtime locale' }
    $temporary = "$RuntimeLocalePath.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [System.IO.File]::WriteAllText(
            $temporary,
            $Locale + [Environment]::NewLine,
            [System.Text.UTF8Encoding]::new($false)
        )
        Move-Item -LiteralPath $temporary -Destination $RuntimeLocalePath -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
    }
}

function Get-ValidatedPayload([string]$Generation) {
    $root = Join-Path $PayloadRoot $Generation
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'control payload missing' }
    $rootItem = Get-Item -LiteralPath $root -Force
    if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'control payload root is a reparse point'
    }
    $manifestPath = Join-Path $root 'payload-manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'control payload manifest missing' }
    if ((Get-Item -LiteralPath $manifestPath -Force).Length -gt 65536) {
        throw 'control payload manifest too large'
    }
    $manifest = [System.IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
    $manifestProperties = @($manifest.PSObject.Properties.Name)
    if ($manifestProperties.Count -ne 2 -or
        @(@('payloadGeneration', 'files') | Where-Object { $manifestProperties -notcontains $_ }).Count -ne 0 -or
        $manifest.payloadGeneration -isnot [string] -or
        $manifest.payloadGeneration -cne $Generation -or
        $manifest.files -isnot [array]) {
        throw 'control payload manifest invalid'
    }
    $actual = @(Get-ChildItem -LiteralPath $root -Recurse -Force | ForEach-Object {
        if (($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'control payload contains a reparse point'
        }
        if ($_.PSIsContainer -or $_.Name -ceq 'payload-manifest.json') { return }
        [pscustomobject]@{
            name = $_.FullName.Substring($root.Length + 1).Replace('\', '/')
            bytes = [long]$_.Length
            sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            path = $_.FullName
        }
    } | Sort-Object name)
    $entries = @($manifest.files | Sort-Object name)
    if ($entries.Count -ne $Destinations.Count -or $actual.Count -ne $Destinations.Count -or $entries.Count -ne $actual.Count) {
        throw 'control payload file count mismatch'
    }
    $totalBytes = [long]0
    for ($index = 0; $index -lt $actual.Count; $index++) {
        $entry = $entries[$index]
        $properties = @($entry.PSObject.Properties.Name)
        if ($properties.Count -ne 3 -or
            @(@('name', 'bytes', 'sha256') | Where-Object { $properties -notcontains $_ }).Count -ne 0 -or
            $entry.name -isnot [string] -or
            (($entry.bytes -isnot [int]) -and ($entry.bytes -isnot [long])) -or
            $entry.sha256 -isnot [string] -or
            $entry.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
            $entry.name -cne $actual[$index].name -or
            [long]$entry.bytes -ne $actual[$index].bytes -or
            $entry.sha256 -cne $actual[$index].sha256 -or
            -not $Destinations.Contains($actual[$index].name) -or
            $actual[$index].bytes -gt $MaxPayloadFileBytes) {
            throw 'control payload manifest mismatch'
        }
        $totalBytes += $actual[$index].bytes
    }
    if ($totalBytes -gt $MaxPayloadBytes) { throw 'control payload too large' }
    $stream = [System.IO.MemoryStream]::new()
    try {
        $writer = [System.IO.BinaryWriter]::new($stream, [System.Text.UTF8Encoding]::new($false), $true)
        try {
            foreach ($file in $actual) {
                $writer.Write([System.Text.Encoding]::UTF8.GetBytes($file.name))
                $writer.Write([byte]0)
                $length = [BitConverter]::GetBytes([long]$file.bytes)
                if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($length) }
                $writer.Write($length)
                $writer.Write([System.IO.File]::ReadAllBytes($file.path))
            }
            $writer.Flush()
            $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($stream.ToArray())
            $actualGeneration = ([BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
        }
        finally { $writer.Dispose() }
    }
    finally { $stream.Dispose() }
    if ($actualGeneration -cne $Generation) { throw 'control payload generation mismatch' }
    return $actual
}

function Install-Payload([string]$Generation) {
    $files = Get-ValidatedPayload $Generation
    $staged = @()
    try {
        foreach ($file in $files) {
            $destination = [string]$Destinations[$file.name]
            [System.IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
            $temporary = "$destination.$([guid]::NewGuid().ToString('N')).tmp"
            Copy-Item -LiteralPath $file.path -Destination $temporary -Force
            if ((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash.ToLowerInvariant() -cne $file.sha256) {
                throw 'staged control payload hash mismatch'
            }
            $staged += [pscustomobject]@{ temporary = $temporary; destination = $destination }
        }
        foreach ($item in $staged) {
            Move-Item -LiteralPath $item.temporary -Destination $item.destination -Force
        }
    }
    finally {
        foreach ($item in $staged) {
            if (Test-Path -LiteralPath $item.temporary) {
                Remove-Item -LiteralPath $item.temporary -Force -ErrorAction SilentlyContinue
            }
        }
    }
    Write-Json ([ordered]@{
        schema = 'hoosaidthat.nvda-ssh-control'
        version = 1
        command = 'update'
        status = 'ready'
        payloadGeneration = $Generation
        files = $files.Count
    })
}

try {
    if ($Command -cmatch '^update ([a-f0-9]{64})$') {
        Install-Payload $Matches[1]
        exit 0
    }
    if ($Command -cnotmatch '^(status|start|stop|restart|logs|time-sync|reconfigure-ssh|locale-en-US|locale-de-DE|shutdown|reboot)$') {
        throw 'unsupported command'
    }
    switch -CaseSensitive ($Command) {
        'status' {
            Write-Json (Get-RuntimeStatus)
        }
        'start' {
            Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
            Start-Sleep -Seconds 1
            $result = Get-RuntimeStatus
            $result['command'] = 'start'
            Write-Json $result
        }
        'stop' {
            Stop-OwnedRuntime
            $result = Get-RuntimeStatus
            $result['command'] = 'stop'
            Write-Json $result
        }
        'restart' {
            Stop-OwnedRuntime
            Start-Sleep -Seconds 1
            Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
            Start-Sleep -Seconds 1
            $result = Get-RuntimeStatus
            $result['command'] = 'restart'
            Write-Json $result
        }
        { $_ -cin @('locale-en-US', 'locale-de-DE') } {
            $locale = $Command.Substring('locale-'.Length)
            Set-RuntimeLocale $locale
            Stop-OwnedRuntime
            Start-Sleep -Seconds 1
            Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
            Start-Sleep -Seconds 1
            $result = Get-RuntimeStatus
            $result['command'] = $Command
            $result['locale'] = $locale
            Write-Json $result
        }
        'logs' {
            $lines = @()
            if (Test-Path -LiteralPath $NvdaLogPath -PathType Leaf) {
                $stream = [System.IO.File]::Open(
                    $NvdaLogPath,
                    [System.IO.FileMode]::Open,
                    [System.IO.FileAccess]::Read,
                    [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
                )
                try {
                    $byteCount = [int][Math]::Min([long]131072, $stream.Length)
                    if ($byteCount -gt 0) {
                        [void]$stream.Seek(-$byteCount, [System.IO.SeekOrigin]::End)
                        $buffer = [byte[]]::new($byteCount)
                        $read = $stream.Read($buffer, 0, $byteCount)
                        $text = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)
                        $allLines = @($text -split '\r?\n')
                        $start = [Math]::Max(0, $allLines.Count - 200)
                        $lines = @($allLines[$start..($allLines.Count - 1)])
                    }
                }
                finally { $stream.Dispose() }
            }
            Write-Json ([ordered]@{
                schema = 'hoosaidthat.nvda-ssh-control'
                version = 1
                command = 'logs'
                generatedUtc = [DateTime]::UtcNow.ToString('o')
                path = $NvdaLogPath
                lines = $lines
            })
        }
        'time-sync' {
            $before = [DateTime]::UtcNow.ToString('o')
            Set-TimeZone -Id 'UTC'
            Set-Service -Name W32Time -StartupType Automatic
            Start-Service -Name W32Time -ErrorAction SilentlyContinue
            $syncOutput = & w32tm.exe /resync /force 2>&1
            if ($LASTEXITCODE -ne 0) {
                $reason = (($syncOutput | Out-String).Trim() -replace '[\r\n]+', ' ')
                throw "Windows time synchronization failed: $reason"
            }
            Write-Json ([ordered]@{
                schema = 'hoosaidthat.nvda-ssh-control'
                version = 1
                command = 'time-sync'
                status = 'ready'
                beforeUtc = $before
                afterUtc = [DateTime]::UtcNow.ToString('o')
                timeZone = (Get-TimeZone).Id
            })
        }
        'reconfigure-ssh' {
            & 'C:\HooSaidThat\configure-ssh.ps1' -DeferServiceRestart
            Write-Json ([ordered]@{
                schema = 'hoosaidthat.nvda-ssh-control'
                version = 1
                command = 'reconfigure-ssh'
                status = 'ready'
                restartScheduled = $true
            })
        }
        'shutdown' {
            Write-Json ([ordered]@{ schema = 'hoosaidthat.nvda-ssh-control'; version = 1; command = 'shutdown'; accepted = $true })
            [Console]::Out.Flush()
            & shutdown.exe /s /t 10 /d p:0:0 /c 'HooSaidThat SSH control requested shutdown'
        }
        'reboot' {
            Write-Json ([ordered]@{ schema = 'hoosaidthat.nvda-ssh-control'; version = 1; command = 'reboot'; accepted = $true })
            [Console]::Out.Flush()
            & shutdown.exe /r /t 10 /d p:0:0 /c 'HooSaidThat SSH control requested reboot'
        }
    }
    exit 0
}
catch {
    $reason = (($_.Exception.Message -replace '[\r\n\t]+', ' ').Trim())
    if ($reason.Length -gt 512) { $reason = $reason.Substring(0, 512) }
    Write-Json ([ordered]@{
        schema = 'hoosaidthat.nvda-ssh-control'
        version = 1
        command = $Command
        status = 'failed'
        error = $reason
    })
    exit 1
}
