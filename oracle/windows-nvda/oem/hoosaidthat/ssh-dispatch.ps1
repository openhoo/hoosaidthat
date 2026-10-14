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
    param([switch]$IncludeDetails)
    $nvda = @()
    $chrome = @()
    $details = @()
    $detailsTruncated = $false
    foreach ($process in @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue)) {
        $path = [string]$process.ExecutablePath
        $role = $null
        if ($path -and $path.Equals($NvdaExecutable, [StringComparison]::OrdinalIgnoreCase)) {
            $nvda += [int]$process.ProcessId
            $role = 'nvda'
        }
        elseif ($path -and $path.StartsWith($ChromeRoot, [StringComparison]::OrdinalIgnoreCase)) {
            $chrome += [int]$process.ProcessId
            if ($path.Equals(($ChromeRoot + 'chrome.exe'), [StringComparison]::OrdinalIgnoreCase)) {
                if (-not $process.CommandLine) { $role = 'chrome-unknown' }
                elseif ([string]$process.CommandLine -notmatch '(?:^|[\s"])--type(?:=|[\s"]|$)') { $role = 'chrome-browser' }
            }
        }
        elseif ($path -and $process.Name -ieq 'powershell.exe' -and
            [string]$process.CommandLine -match '(?i)(?:^|\s)-File\s+(?:"C:\\HooSaidThat\\start-runtime\.ps1"|C:\\HooSaidThat\\start-runtime\.ps1)(?:\s|$)') {
            $role = 'runtime-supervisor'
        }
        if ($role -and $IncludeDetails) {
            if ($details.Count -ge 64) { $detailsTruncated = $true; continue }
            $owner = $null
            $ownerError = $null
            try {
                $result = Invoke-CimMethod -InputObject $process -MethodName GetOwner -ErrorAction Stop
                if ($result.ReturnValue -eq 0) { $owner = "$($result.Domain)\$($result.User)" }
                else { $ownerError = [int]$result.ReturnValue }
            }
            catch { $ownerError = 'unavailable' }
            $details += [ordered]@{
                role = $role
                pid = [int]$process.ProcessId
                parentPid = [int]$process.ParentProcessId
                sessionId = [int]$process.SessionId
                executablePath = $path
                owner = $owner
                ownerError = $ownerError
            }
        }
    }
    return [ordered]@{ nvdaPids = @($nvda); chromePids = @($chrome); details = @($details); detailsTruncated = $detailsTruncated }
}

function Get-SessionDiagnostics {
    $observer = [ordered]@{
        pid = $PID
        sessionId = $null
        inputDesktop = $null
        inputDesktopObservation = 'not queried; SSH observer cannot attest the runtime input desktop'
    }
    try {
        $observer['sessionId'] = (Get-Process -Id $PID).SessionId
        if (-not ('HooSaidThat.WtsDiagnostics' -as [type])) {
            # Layout and constants: Microsoft's wtsapi32.h / WTSINFOEX_LEVEL1_W.
            # https://learn.microsoft.com/windows/win32/api/wtsapi32/ns-wtsapi32-wtsinfoex_level1_w
            # https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/RecompiledIdlHeaders/um/WtsApi32.h
            # Current Windows: SessionFlags 0 = locked, 1 = unlocked. Windows 7
            # and Server 2008 R2 reversed these flags; no inference is made there.
            $null = Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
namespace HooSaidThat {
    public static class WtsDiagnostics {
        [StructLayout(LayoutKind.Sequential)]
        private struct SessionInfo { public uint Id; public IntPtr Name; public int State; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct Level1 {
            public uint SessionId; public int State; public int Flags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 33)] public string Station;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 21)] public string User;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 18)] public string Domain;
            public long LogonTime, ConnectTime, DisconnectTime, LastInputTime, CurrentTime;
            public uint IncomingBytes, OutgoingBytes, IncomingFrames, OutgoingFrames;
            public uint IncomingCompressedBytes, OutgoingCompressedBytes;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct InfoEx { public uint Level; public Level1 Data; }
        public sealed class Session {
            public uint sessionId; public string station; public int connectionStateCode;
            public string account; public string lockState = "unknown";
            public int? sessionFlags; public int? lockQueryError;
            public int? protocolCode; public int? protocolQueryError;
        }
        [DllImport("wtsapi32.dll", EntryPoint = "WTSEnumerateSessionsW", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool Enumerate(IntPtr server, uint reserved, uint version, out IntPtr data, out uint count);
        [DllImport("wtsapi32.dll", EntryPoint = "WTSQuerySessionInformationW", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool Query(IntPtr server, uint sessionId, int infoClass, out IntPtr data, out uint bytes);
        [DllImport("wtsapi32.dll")] private static extern void WTSFreeMemory(IntPtr memory);
        public static Session[] Read(bool interpretCurrentWindowsLockFlags) {
            IntPtr data = IntPtr.Zero; uint count;
            try {
                if (!Enumerate(IntPtr.Zero, 0, 1, out data, out count)) {
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                }
                if (count > 64 || (count > 0 && data == IntPtr.Zero)) {
                    throw new System.ComponentModel.Win32Exception(13);
                }
                var result = new List<Session>();
                int size = Marshal.SizeOf(typeof(SessionInfo));
                for (int i = 0; i < count; i++) {
                    var native = (SessionInfo)Marshal.PtrToStructure(IntPtr.Add(data, i * size), typeof(SessionInfo));
                    var item = new Session { sessionId = native.Id,
                        station = Marshal.PtrToStringUni(native.Name), connectionStateCode = native.State };
                    IntPtr info = IntPtr.Zero; uint bytes;
                    try {
                        if (Query(IntPtr.Zero, native.Id, 25, out info, out bytes)) {
                            if (info != IntPtr.Zero && bytes >= Marshal.SizeOf(typeof(InfoEx))) {
                                var extended = (InfoEx)Marshal.PtrToStructure(info, typeof(InfoEx));
                                if (extended.Level == 1 && extended.Data.SessionId == native.Id) {
                                    item.account = String.IsNullOrEmpty(extended.Data.User) ? null :
                                        extended.Data.Domain + "\\" + extended.Data.User;
                                    item.sessionFlags = extended.Data.Flags;
                                    if (interpretCurrentWindowsLockFlags) {
                                        if (extended.Data.Flags == 0) item.lockState = "locked";
                                        else if (extended.Data.Flags == 1) item.lockState = "unlocked";
                                    }
                                } else item.lockQueryError = 13;
                            } else item.lockQueryError = 13;
                        } else item.lockQueryError = Marshal.GetLastWin32Error();
                    } finally { if (info != IntPtr.Zero) WTSFreeMemory(info); }
                    info = IntPtr.Zero;
                    try {
                        if (Query(IntPtr.Zero, native.Id, 16, out info, out bytes)) {
                            if (info != IntPtr.Zero && bytes >= 2) item.protocolCode = (ushort)Marshal.ReadInt16(info);
                            else item.protocolQueryError = 13;
                        } else item.protocolQueryError = Marshal.GetLastWin32Error();
                    } finally { if (info != IntPtr.Zero) WTSFreeMemory(info); }
                    result.Add(item);
                }
                return result.ToArray();
            } finally { if (data != IntPtr.Zero) WTSFreeMemory(data); }
        }
    }
}
'@ -ErrorAction Stop -WarningAction SilentlyContinue
        }
        $osVersion = $null
        $osVersionError = $null
        $interpretLockFlags = $false
        try {
            $version = [Version](Get-CimInstance -ClassName Win32_OperatingSystem -Property Version -ErrorAction Stop).Version
            $osVersion = $version.ToString()
            $interpretLockFlags = $version.Major -ge 10
        }
        catch { $osVersionError = 'unavailable'; }
        $states = @('active', 'connected', 'connect-query', 'shadow', 'disconnected', 'idle', 'listen', 'reset', 'down', 'init')
        $sessions = @([HooSaidThat.WtsDiagnostics]::Read($interpretLockFlags) | ForEach-Object {
            [ordered]@{
                sessionId = $_.sessionId
                station = $_.station
                account = $_.account
                connectionStateCode = $_.connectionStateCode
                connectionState = if ($_.connectionStateCode -ge 0 -and $_.connectionStateCode -lt $states.Count) { $states[$_.connectionStateCode] } else { 'unknown' }
                lockState = $_.lockState
                sessionFlags = $_.sessionFlags
                lockQueryError = $_.lockQueryError
                protocolCode = $_.protocolCode
                protocol = switch ($_.protocolCode) { 0 { 'console' }; 2 { 'rdp' }; default { 'unknown' } }
                protocolQueryError = $_.protocolQueryError
            }
        })
        return [ordered]@{ observer = $observer; operatingSystemVersion = $osVersion; operatingSystemVersionError = $osVersionError; sessions = $sessions; error = $null }
    }
    catch {
        $failure = $_.Exception
        while ($failure.InnerException) { $failure = $failure.InnerException }
        return [ordered]@{
            observer = $observer
            sessions = @()
            error = [ordered]@{
                type = $failure.GetType().FullName
                nativeCode = if ($failure -is [System.ComponentModel.Win32Exception]) { $failure.NativeErrorCode } else { $null }
            }
        }
    }
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
    $processes = Get-ProcessSnapshot -IncludeDetails
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
        sessionDiagnostics = Get-SessionDiagnostics
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
