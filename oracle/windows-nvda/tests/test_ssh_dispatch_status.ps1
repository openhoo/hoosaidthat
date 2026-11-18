[CmdletBinding()]
param(
    [string]$DispatcherPath = (Join-Path $PSScriptRoot '..\oem\hoosaidthat\ssh-dispatch.ps1'),
    [string]$FunctionPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Wie test_configure_ssh.ps1 wird ausschliesslich eine AST-Funktionsdefinition
# geladen. Der Dispatcher-Einstieg und die echten Diagnosen laufen niemals.
$sourcePath = if ($FunctionPath) { $FunctionPath } else { $DispatcherPath }
$sourcePath = [IO.Path]::GetFullPath($sourcePath)
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'Die Statusquelle enthaelt Parserfehler' }
$functions = @($ast.EndBlock.Statements | Where-Object {
    $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq 'Get-RuntimeStatus'
})
if ($functions.Count -ne 1) { throw 'Genau eine Get-RuntimeStatus-Definition wird erwartet' }
$allowedCommands = @(
    'Get-ScheduledTask', 'Get-ScheduledTaskInfo', 'Get-ProcessSnapshot',
    'Get-SessionDiagnostics', 'Test-Path', 'Get-Item', 'ConvertFrom-Json'
)
foreach ($command in @($functions[0].Body.FindAll({
    param($node) $node -is [Management.Automation.Language.CommandAst]
}, $true))) {
    if ($allowedCommands -notcontains $command.GetCommandName()) {
        throw 'Unerwarteter Befehl in der isolierten Statusfunktion'
    }
}
$definition = [scriptblock]::Create($functions[0].Extent.Text)

function Write-FixtureHeartbeat([string]$Path, [string]$Generation, [int]$AgeSeconds) {
    $heartbeat = [ordered]@{
        generatedUtc = [DateTimeOffset]::UtcNow.AddSeconds($AgeSeconds).ToString('o')
        ready = $true
        nvdaPid = 101
        chromePid = 202
        fixtureGeneration = $Generation
    }
    [IO.File]::WriteAllText($Path, ($heartbeat | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
}

function Invoke-StatusCase([hashtable]$Case, [scriptblock]$Definition, [string]$FixturePath) {
    . $Definition
    $TaskName = 'Isolierte Status-Fixture'
    $RuntimeStatusPath = $FixturePath
    $state = @{
        Calls = [Collections.Generic.List[string]]::new()
        ExpectedTaskName = $TaskName
        Processes = [ordered]@{
            nvdaPids = @(101)
            chromePids = @(202, 203)
            details = @([ordered]@{
                role = 'nvda'; pid = 101; parentPid = 99; sessionId = 7
                executablePath = 'fixture-nvda'; owner = 'fixture-owner'; ownerError = $null
            })
            detailsTruncated = $true
        }
        Sessions = [ordered]@{
            observer = [ordered]@{ pid = 404; sessionId = 0; inputDesktop = $null; inputDesktopObservation = 'fixture' }
            operatingSystemVersion = 'fixture-version'
            operatingSystemVersionError = $null
            sessions = @([ordered]@{ sessionId = 7; station = 'fixture-console'; lockState = 'unlocked'; protocol = 'console' })
            error = $null
        }
    }
    if ($Case.ContainsKey('OtherReader')) { $state.Processes.nvdaPids = @(111) }
    Write-FixtureHeartbeat $FixturePath 'before-diagnostics' -60

    function Get-ScheduledTask {
        [CmdletBinding()]param([string]$TaskName)
        if ($TaskName -cne $state.ExpectedTaskName) { throw 'Unerwartete Task-Fixture' }
        [void]$state.Calls.Add('task')
        [pscustomobject]@{ State = 'Running' }
    }
    function Get-ScheduledTaskInfo {
        [CmdletBinding()]param([string]$TaskName)
        if ($TaskName -cne $state.ExpectedTaskName) { throw 'Unerwartete Taskinfo-Fixture' }
        [void]$state.Calls.Add('task-info')
        [pscustomobject]@{ LastRunTime = [DateTime]::UtcNow.AddMinutes(-1); LastTaskResult = 0 }
    }
    function Get-ProcessSnapshot {
        param([switch]$IncludeDetails)
        if (-not $IncludeDetails) { throw 'Prozessdetails muessen erhalten bleiben' }
        [void]$state.Calls.Add('processes')
        if ($Case.RefreshBy -ceq 'processes') { Write-FixtureHeartbeat $FixturePath 'after-processes' 0 }
        return $state.Processes
    }
    function Get-SessionDiagnostics {
        [void]$state.Calls.Add('sessions')
        if ($Case.RefreshBy -ceq 'sessions') { Write-FixtureHeartbeat $FixturePath 'after-sessions' 0 }
        return $state.Sessions
    }
    function Test-Path {
        [CmdletBinding()]param([string]$LiteralPath, [string]$PathType)
        if ($LiteralPath -cne $FixturePath -or $PathType -cne 'Leaf') { throw 'Dateizugriff ausserhalb der eigenen Status-Fixture' }
        [void]$state.Calls.Add('heartbeat-test')
        Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath -PathType Leaf
    }
    function Get-Item {
        [CmdletBinding()]param([string]$LiteralPath, [switch]$Force)
        if ($LiteralPath -cne $FixturePath -or -not $Force) { throw 'Dateizugriff ausserhalb der eigenen Status-Fixture' }
        [void]$state.Calls.Add('heartbeat-stat')
        Microsoft.PowerShell.Management\Get-Item -LiteralPath $LiteralPath -Force
    }

    $failures = [Collections.Generic.List[string]]::new()
    try {
        $result = Get-RuntimeStatus
        $expectedCalls = 'task,task-info,processes,sessions,heartbeat-test,heartbeat-stat'
        if (($state.Calls -join ',') -cne $expectedCalls) {
            $failures.Add('Beide Diagnosen muessen genau einmal vor dem Heartbeat-Lesen fertig werden')
        }
        $expectedGeneration = if ($Case.RefreshBy) { 'after-' + $Case.RefreshBy } else { 'before-diagnostics' }
        if ($result.runtime.fixtureGeneration -cne $expectedGeneration) { $failures.Add('Die zuletzt geschriebene Heartbeat-Generation wurde nicht gelesen') }
        $expectedReady = $Case.ExpectedFresh -and -not $Case.ContainsKey('OtherReader')
        if ($result.runtimeFresh -ne $Case.ExpectedFresh -or $result.ready -ne $expectedReady) { $failures.Add('Freshness oder Readiness stimmt nicht') }
        if (($result.Keys -join ',') -cne 'schema,version,command,generatedUtc,ready,runtimeFresh,task,processes,sessionDiagnostics,runtime') {
            $failures.Add('Statusfelder wurden veraendert')
        }
        if (($result.processes | ConvertTo-Json -Depth 10 -Compress) -cne ($state.Processes | ConvertTo-Json -Depth 10 -Compress)) {
            $failures.Add('Prozessdiagnose wurde veraendert')
        }
        if (($result.sessionDiagnostics | ConvertTo-Json -Depth 10 -Compress) -cne ($state.Sessions | ConvertTo-Json -Depth 10 -Compress)) {
            $failures.Add('Sessiondiagnose wurde veraendert')
        }
        if ($result.task.state -cne 'Running' -or $result.task.lastTaskResult -ne 0 -or -not $result.task.lastRunUtc) {
            $failures.Add('Taskdiagnose wurde veraendert')
        }
    }
    catch { $failures.Add($_.Exception.Message) }
    return [ordered]@{
        name = $Case.Name
        passed = $failures.Count -eq 0
        failures = @($failures.ToArray())
        calls = @($state.Calls.ToArray())
    }
}

$cases = @(
    @{ Name = 'Heartbeat aus der Prozessdiagnose wird frisch gelesen'; RefreshBy = 'processes'; ExpectedFresh = $true },
    @{ Name = 'Heartbeat aus der Sessiondiagnose wird frisch gelesen'; RefreshBy = 'sessions'; ExpectedFresh = $true },
    @{ Name = 'Alter Heartbeat bleibt trotz vorhandener Prozesse nicht bereit'; RefreshBy = ''; ExpectedFresh = $false },
    @{ Name = 'Eine andere NVDA-PID bestaetigt den frischen Heartbeat nicht'; RefreshBy = 'sessions'; ExpectedFresh = $true; OtherReader = $true }
)
$fixtureRoot = Join-Path $PSScriptRoot ('status-fixtures-' + [guid]::NewGuid().ToString('N'))
$results = [Collections.Generic.List[object]]::new()
try {
    [void][IO.Directory]::CreateDirectory($fixtureRoot)
    foreach ($case in $cases) {
        $fixturePath = Join-Path $fixtureRoot ($results.Count.ToString() + '.json')
        $results.Add((Invoke-StatusCase $case $definition $fixturePath))
    }
}
finally {
    if ([IO.Directory]::Exists($fixtureRoot)) { [IO.Directory]::Delete($fixtureRoot, $true) }
}
$failed = @($results | Where-Object { -not $_.passed }).Count
[Console]::Out.WriteLine(([ordered]@{
    schema = 'hoosaidthat.ssh-status-order-regression'
    version = 1
    sourcePath = $sourcePath
    sourceSha256 = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
    isolatedFixtures = $true
    total = $results.Count
    passed = $results.Count - $failed
    failed = $failed
    results = @($results.ToArray())
} | ConvertTo-Json -Depth 8 -Compress))
if ($failed -gt 0) { exit 1 }
