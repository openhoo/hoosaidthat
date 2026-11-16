[CmdletBinding()]
param(
    [string]$ConfigurePath = (Join-Path $PSScriptRoot '..\oem\hoosaidthat\configure-ssh.ps1')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Der Runner laedt nur Funktionsdefinitionen und die Installationsauswahl.
# Provisionierung, Schluessel, ACLs, Firewall und echte Dienste werden nie
# ausgefuehrt. Dateipruefungen treffen ausschliesslich eigene Temp-Fixtures.
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
    [IO.Path]::GetFullPath($ConfigurePath), [ref]$tokens, [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) { throw 'Die Configure-Quelle enthaelt Parserfehler' }
$mainTry = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })
if ($mainTry.Count -ne 1) { throw 'Genau ein aeusserer Configure-Try-Block wird erwartet' }

function Test-PhaseStatement($Statement, [string]$Phase) {
    if ($Statement -isnot [Management.Automation.Language.PipelineAst] -or $Statement.PipelineElements.Count -ne 1) { return $false }
    $command = $Statement.PipelineElements[0]
    if ($command -isnot [Management.Automation.Language.CommandAst] -or $command.GetCommandName() -cne 'Publish-Status' -or
        $command.CommandElements.Count -ne 3) { return $false }
    return $command.CommandElements[1].Value -ceq 'running' -and $command.CommandElements[2].Value -ceq $Phase
}
$installPhase = @($mainTry[0].Body.Statements | Where-Object { Test-PhaseStatement $_ 'install-openssh' })
$keysPhase = @($mainTry[0].Body.Statements | Where-Object { Test-PhaseStatement $_ 'configure-keys' })
if ($installPhase.Count -ne 1 -or $keysPhase.Count -ne 1 -or
    $keysPhase[0].Extent.StartOffset -le $installPhase[0].Extent.StartOffset) {
    throw 'Die isolierte Installationsauswahl konnte nicht eindeutig bestimmt werden'
}
$source = $ast.Extent.Text
$selectionText = $source.Substring(
    $installPhase[0].Extent.StartOffset,
    $keysPhase[0].Extent.StartOffset - $installPhase[0].Extent.StartOffset
)
$definitions = [scriptblock]::Create((@($ast.EndBlock.Statements |
    Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] } |
    ForEach-Object { $_.Extent.Text }) -join [Environment]::NewLine))
$selection = [scriptblock]::Create($selectionText)
$allowedCommands = @('Publish-Status', 'Get-InstalledOpenSshRoot', 'Get-WindowsCapability', 'Add-WindowsCapability', 'Join-Path', 'Test-Path', 'Get-Service', 'Out-Null')
foreach ($command in @($selection.Ast.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] }, $true))) {
    if ($allowedCommands -notcontains $command.GetCommandName()) { throw 'Unerwarteter Befehl im isolierten Testabschnitt' }
}
if ($selectionText -match '(?i)::(?:Write|CreateDirectory|Delete|Move|Copy)|Invoke-Expression') {
    throw 'Dateimutationen sind im isolierten Testabschnitt nicht erlaubt'
}

$pinnedRoot = 'C:\Program Files\HooSaidThat OpenSSH\10.4.0.0p1'
$inboxRoot = 'C:\Windows\System32\OpenSSH'
$quotedPinned = '"' + $pinnedRoot + '\sshd.exe"'
function New-Case([string]$Name, [hashtable]$Changes) {
    $case = @{
        Name = $Name; Defer = $true; ServiceCount = 1; ServicePath = $quotedPinned
        DaemonPresent = $true; KeygenPresent = $true; DaemonIsDirectory = $false
        CapabilityState = 'NotPresent'; AfterAddState = 'Installed'; AddError = ''
        ExpectedRoot = $pinnedRoot; ExpectedError = ''; ExpectedQueries = 0; ExpectedAdds = 0
        ExpectedServiceQueries = 1
    }
    foreach ($key in $Changes.Keys) { $case[$key] = $Changes[$key] }
    return $case
}
$invalidPath = 'Installed OpenSSH service path invalid'
$cases = @(
    (New-Case 'Reconfigure verwendet die quotierte installierte Version' @{}),
    (New-Case 'Reconfigure verwendet einen eindeutigen unquotierten Inbox-Pfad' @{ ServicePath = $inboxRoot + '\sshd.exe'; ExpectedRoot = $inboxRoot }),
    (New-Case 'Reconfigure akzeptiert einen quotierten Inbox-Pfad' @{ ServicePath = '"' + $inboxRoot + '\sshd.exe"'; ExpectedRoot = $inboxRoot }),
    (New-Case 'Fehlender Dienst fuehrt zu keinem Servicing-Fallback' @{ ServiceCount = 0; ExpectedError = 'Installed OpenSSH service missing or ambiguous' }),
    (New-Case 'Mehrdeutige Dienstauskunft wird abgewiesen' @{ ServiceCount = 2; ExpectedError = 'Installed OpenSSH service missing or ambiguous' }),
    (New-Case 'Leerer Dienstpfad wird abgewiesen' @{ ServicePath = ''; ExpectedError = $invalidPath }),
    (New-Case 'Unquotierter Dienstpfad mit Leerzeichen wird abgewiesen' @{ ServicePath = $pinnedRoot + '\sshd.exe'; ExpectedError = $invalidPath }),
    (New-Case 'Nicht geschlossene Quotes werden abgewiesen' @{ ServicePath = '"' + $pinnedRoot + '\sshd.exe'; ExpectedError = $invalidPath }),
    (New-Case 'Zusaetzliche Dienstargumente werden abgewiesen' @{ ServicePath = $quotedPinned + ' -f C:\sshd_config'; ExpectedError = $invalidPath }),
    (New-Case 'Angehaengter Befehl wird nicht ausgewertet' @{ ServicePath = $quotedPinned + '; throw "UNERLAUBT"'; ExpectedError = $invalidPath }),
    (New-Case 'Andere ausfuehrbare Datei wird abgewiesen' @{ ServicePath = '"C:\Windows\System32\cmd.exe"'; ExpectedError = $invalidPath }),
    (New-Case 'Relativer Pfad wird abgewiesen' @{ ServicePath = 'sshd.exe'; ExpectedError = $invalidPath }),
    (New-Case 'Laufwerksrelativer Pfad wird abgewiesen' @{ ServicePath = 'C:sshd.exe'; ExpectedError = $invalidPath }),
    (New-Case 'UNC-Pfad wird abgewiesen' @{ ServicePath = '"\\server\share\sshd.exe"'; ExpectedError = $invalidPath }),
    (New-Case 'Device-Pfad wird abgewiesen' @{ ServicePath = '"\\?\C:\OpenSSH\sshd.exe"'; ExpectedError = $invalidPath }),
    (New-Case 'Umgebungsvariable im Dienstpfad wird nicht expandiert' @{ ServicePath = '"%ProgramFiles%\OpenSSH\sshd.exe"'; ExpectedError = $invalidPath }),
    (New-Case 'Pfadnavigation wird abgewiesen' @{ ServicePath = '"C:\Windows\System32\OpenSSH\..\OpenSSH\sshd.exe"'; ExpectedError = $invalidPath }),
    (New-Case 'Alternativer Datenstrom wird abgewiesen' @{ ServicePath = '"C:\Windows\System32\OpenSSH\sshd.exe:stream"'; ExpectedError = $invalidPath }),
    (New-Case 'Abschliessender Zeilenumbruch wird abgewiesen' @{ ServicePath = $quotedPinned + [char]10; ExpectedError = $invalidPath }),
    (New-Case 'Fehlende sshd-Datei fuehrt zu keinem Servicing-Fallback' @{ DaemonPresent = $false; ExpectedError = 'Installed OpenSSH service binaries unavailable' }),
    (New-Case 'Fehlende ssh-keygen-Datei fuehrt zu keinem Servicing-Fallback' @{ KeygenPresent = $false; ExpectedError = 'Installed OpenSSH service binaries unavailable' }),
    (New-Case 'Verzeichnis ersetzt keine sshd-Datei' @{ DaemonIsDirectory = $true; ExpectedError = 'Installed OpenSSH service binaries unavailable' }),
    (New-Case 'Bootstrap belaesst die installierte Inbox-Capability' @{ Defer = $false; CapabilityState = 'Installed'; ExpectedRoot = $inboxRoot; ExpectedQueries = 1; ExpectedServiceQueries = 0 }),
    (New-Case 'Bootstrap installiert die fehlende Inbox-Capability' @{ Defer = $false; ExpectedRoot = $inboxRoot; ExpectedQueries = 2; ExpectedAdds = 1; ExpectedServiceQueries = 0 }),
    (New-Case 'Bootstrap behaelt Installationsfehler bei' @{ Defer = $false; AddError = 'Fixture: Access is denied.'; ExpectedError = 'Fixture: Access is denied.'; ExpectedQueries = 1; ExpectedAdds = 1; ExpectedServiceQueries = 0 }),
    (New-Case 'Bootstrap weist unvollstaendige Installation ab' @{ Defer = $false; AfterAddState = 'NotPresent'; ExpectedError = 'Windows inbox OpenSSH capability installation incomplete'; ExpectedQueries = 2; ExpectedAdds = 1; ExpectedServiceQueries = 0 })
)

function Invoke-FixtureCase([hashtable]$Case, [scriptblock]$Definitions, [scriptblock]$Selection, [string]$FixtureRoot) {
    . $Definitions
    $state = @{
        Queries = 0; Adds = 0; ServiceQueries = 0; CapabilityState = $Case.CapabilityState
        Paths = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
    }
    foreach ($root in @($pinnedRoot, $inboxRoot)) {
        $daemonFixture = if ($Case.DaemonIsDirectory) { 'directory' } elseif ($Case.DaemonPresent) { 'sshd.fixture' } else { 'missing-sshd.fixture' }
        $keygenFixture = if ($Case.KeygenPresent) { 'ssh-keygen.fixture' } else { 'missing-keygen.fixture' }
        $state.Paths.Add((Join-Path $root 'sshd.exe'), (Join-Path $FixtureRoot $daemonFixture))
        $state.Paths.Add((Join-Path $root 'ssh-keygen.exe'), (Join-Path $FixtureRoot $keygenFixture))
    }
    function Publish-Status { param([string]$Status, [string]$Phase) }
    function Get-CimInstance {
        [CmdletBinding()]param([string]$ClassName, [string]$Filter)
        if ($ClassName -cne 'Win32_Service' -or $Filter -cne "Name='sshd'") { throw 'Unerwartete CIM-Abfrage' }
        $state.ServiceQueries++
        for ($index = 0; $index -lt $Case.ServiceCount; $index++) {
            [pscustomobject]@{ PathName = $Case.ServicePath }
        }
    }
    function Get-WindowsCapability {
        [CmdletBinding()]param([switch]$Online, [string]$Name)
        $state.Queries++
        if ($Case.Defer) { throw 'Verbotenes Online-Servicing bei Reconfigure' }
        if (-not $Online -or $Name -cne 'OpenSSH.Server~~~~0.0.1.0') { throw 'Unerwartete Capability-Abfrage' }
        [pscustomobject]@{ State = $state.CapabilityState }
    }
    function Add-WindowsCapability {
        [CmdletBinding()]param([switch]$Online, [string]$Name)
        $state.Adds++
        if ($Case.Defer) { throw 'Verbotene Capability-Installation bei Reconfigure' }
        if (-not $Online -or $Name -cne 'OpenSSH.Server~~~~0.0.1.0') { throw 'Unerwartete Capability-Installation' }
        if ($Case.AddError) { throw $Case.AddError }
        $state.CapabilityState = $Case.AfterAddState
    }
    function Get-Service {
        [CmdletBinding()]param([string]$Name)
        if ($Name -cne 'sshd') { throw 'Unerwartete Dienstabfrage' }
        [pscustomobject]@{ Status = 'Running' }
    }
    function Test-Path {
        [CmdletBinding()]param([string]$LiteralPath, [string]$PathType)
        if (-not $state.Paths.ContainsKey($LiteralPath) -or $PathType -cne 'Leaf') {
            throw 'Dateipruefung ausserhalb der isolierten Binaer-Fixtures'
        }
        Microsoft.PowerShell.Management\Test-Path -LiteralPath $state.Paths[$LiteralPath] -PathType Leaf
    }
    # Auch bei einer kuenftigen versehentlichen Bereichserweiterung keine
    # Systemaenderungen durch diese Cmdlets erlauben.
    foreach ($name in @(
        'Set-Service', 'Start-Service', 'Stop-Service', 'Restart-Service', 'New-Service', 'Remove-Service',
        'Get-NetFirewallRule', 'Remove-NetFirewallRule', 'New-NetFirewallRule', 'Get-Acl', 'Set-Acl',
        'Set-StrictSshFileAcl', 'Start-Process', 'Copy-Item', 'Move-Item', 'Remove-Item', 'New-Item', 'New-ItemProperty'
    )) {
        Set-Item -Path ('Function:\' + $name) -Value { throw 'Unerlaubter Systembefehl im isolierten Auswahltest' }
    }
    $DeferServiceRestart = $Case.Defer
    $openSshRoot = $null
    $sshd = $null
    $sshKeygen = $null
    $observedError = ''
    try { . $Selection }
    catch { $observedError = $_.Exception.Message }
    $failures = [Collections.Generic.List[string]]::new()
    if ($Case.ExpectedError) {
        if ($observedError -cne $Case.ExpectedError) { $failures.Add('Unerwarteter Fehler: ' + $observedError) }
    }
    elseif ($observedError) { $failures.Add('Auswahl fehlgeschlagen: ' + $observedError) }
    elseif ($openSshRoot -cne $Case.ExpectedRoot -or
        $sshd -cne (Join-Path $Case.ExpectedRoot 'sshd.exe') -or
        $sshKeygen -cne (Join-Path $Case.ExpectedRoot 'ssh-keygen.exe')) {
        $failures.Add('Ausgewaehlte Binaerpfade stimmen nicht')
    }
    if ($state.Queries -ne $Case.ExpectedQueries -or $state.Adds -ne $Case.ExpectedAdds) {
        $failures.Add(('Capability-Aufrufe: Get={0}, Add={1}' -f $state.Queries, $state.Adds))
    }
    if ($state.ServiceQueries -ne $Case.ExpectedServiceQueries) {
        $failures.Add(('CIM-Dienstabfragen: {0}' -f $state.ServiceQueries))
    }
    return [ordered]@{
        name = $Case.Name
        passed = ($failures.Count -eq 0)
        failures = @($failures.ToArray())
        capabilityQueries = $state.Queries
        capabilityAdds = $state.Adds
        serviceQueries = $state.ServiceQueries
    }
}

$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('hst-configure-ssh-regression-' + [guid]::NewGuid().ToString('N'))
$results = [Collections.Generic.List[object]]::new()
try {
    [void][IO.Directory]::CreateDirectory($fixtureRoot)
    [void][IO.Directory]::CreateDirectory((Join-Path $fixtureRoot 'directory'))
    [IO.File]::WriteAllBytes((Join-Path $fixtureRoot 'sshd.fixture'), [byte[]]::new(0))
    [IO.File]::WriteAllBytes((Join-Path $fixtureRoot 'ssh-keygen.fixture'), [byte[]]::new(0))
    foreach ($case in $cases) { $results.Add((Invoke-FixtureCase $case $definitions $selection $fixtureRoot)) }
}
finally {
    if ([IO.Directory]::Exists($fixtureRoot)) { [IO.Directory]::Delete($fixtureRoot, $true) }
}
$failed = @($results | Where-Object { -not $_.passed }).Count
[Console]::Out.WriteLine(([ordered]@{
    schema = 'hoosaidthat.configure-ssh-regression'
    version = 1
    configurePath = [IO.Path]::GetFullPath($ConfigurePath)
    configureSha256 = (Get-FileHash -LiteralPath $ConfigurePath -Algorithm SHA256).Hash.ToLowerInvariant()
    total = $results.Count
    passed = $results.Count - $failed
    failed = $failed
    isolatedFixtures = $true
    results = @($results.ToArray())
} | ConvertTo-Json -Depth 8 -Compress))
if ($failed -gt 0) { exit 1 }
