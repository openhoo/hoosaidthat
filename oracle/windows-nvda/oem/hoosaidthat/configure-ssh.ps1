[CmdletBinding()]
param(
    [switch]$DeferServiceRestart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$BootstrapRoot = '\\host.lan\Data\bootstrap'
$BootstrapKey = Join-Path $BootstrapRoot 'authorized_key.pub'
$GuestHostKey = Join-Path $BootstrapRoot 'ssh_host_ed25519_key.pub'
$StatusPath = Join-Path $BootstrapRoot 'ssh-status.json'
$AuthorizedKeys = 'C:\ProgramData\ssh\administrators_authorized_keys'
$SshdConfig = 'C:\ProgramData\ssh\sshd_config'
$Dispatch = 'C:\HooSaidThat\ssh-dispatch.ps1'

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
        schema = 'hoosaidthat.nvda-ssh-status'
        version = 1
        status = $Status
        phase = $Phase
        generatedUtc = [DateTime]::UtcNow.ToString('o')
        hostKeyPublished = Test-Path -LiteralPath $GuestHostKey -PathType Leaf
        error = if ($ErrorMessage) { $ErrorMessage } else { $null }
    })
}

function Get-ValidatedPublicKey {
    if (-not (Test-Path -LiteralPath $BootstrapKey -PathType Leaf)) {
        throw 'bootstrap public key missing'
    }
    $raw = ([System.IO.File]::ReadAllText($BootstrapKey)).Trim()
    $parts = @($raw -split '\s+')
    if ($parts.Count -lt 2 -or $parts[0] -cne 'ssh-ed25519' -or $parts[1] -notmatch '^[A-Za-z0-9+/]{68}$') {
        throw 'bootstrap public key shape invalid'
    }
    try { $decoded = [Convert]::FromBase64String($parts[1]) }
    catch { throw 'bootstrap public key encoding invalid' }
    if ($decoded.Length -ne 51) { throw 'bootstrap public key wire length invalid' }
    return ('ssh-ed25519 {0}' -f $parts[1]) + "`r`n"
}

function Set-StrictSshFileAcl([string]$Path, [string]$OwnerSidValue) {
    $systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $administratorsSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    $ownerSid = [System.Security.Principal.SecurityIdentifier]::new($OwnerSidValue)
    $acl = [System.Security.AccessControl.FileSecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($ownerSid)
    foreach ($sid in @($systemSid, $administratorsSid)) {
        [void]$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
            $sid,
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            [System.Security.AccessControl.AccessControlType]::Allow
        ))
    }
    Set-Acl -LiteralPath $Path -AclObject $acl

    $verified = Get-Acl -LiteralPath $Path
    $expected = @($systemSid.Value, $administratorsSid.Value)
    $rules = @($verified.Access)
    $owner = $verified.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if (-not $verified.AreAccessRulesProtected -or $owner -cne $ownerSid.Value -or $rules.Count -ne 2) {
        throw 'OpenSSH file ACL verification failed'
    }
    foreach ($rule in $rules) {
        $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
        if ($expected -notcontains $sid -or
            $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
            ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
            throw 'OpenSSH file ACL verification failed'
        }
    }
}

try {
    [System.IO.Directory]::CreateDirectory($BootstrapRoot) | Out-Null
    Publish-Status 'running' 'validate-input'
    if (-not (Test-Path -LiteralPath $Dispatch -PathType Leaf)) { throw 'SSH dispatcher missing' }
    $publicKey = Get-ValidatedPublicKey

    Publish-Status 'running' 'install-openssh'
    $capabilityName = 'OpenSSH.Server~~~~0.0.1.0'
    $capability = Get-WindowsCapability -Online -Name $capabilityName
    if ($capability.State -ne 'Installed') {
        Add-WindowsCapability -Online -Name $capabilityName | Out-Null
        $capability = Get-WindowsCapability -Online -Name $capabilityName
    }
    if ($capability.State -ne 'Installed') { throw 'Windows inbox OpenSSH capability installation incomplete' }

    $openSshRoot = 'C:\Windows\System32\OpenSSH'
    $sshd = Join-Path $openSshRoot 'sshd.exe'
    $sshKeygen = Join-Path $openSshRoot 'ssh-keygen.exe'
    if (-not (Test-Path -LiteralPath $sshd -PathType Leaf) -or
        -not (Test-Path -LiteralPath $sshKeygen -PathType Leaf) -or
        $null -eq (Get-Service -Name sshd -ErrorAction SilentlyContinue)) {
        throw 'Windows inbox OpenSSH unavailable after installation'
    }

    Publish-Status 'running' 'configure-keys'
    [System.IO.Directory]::CreateDirectory('C:\ProgramData\ssh') | Out-Null
    $hostPrivateKey = 'C:\ProgramData\ssh\ssh_host_ed25519_key'
    $hostPublicKey = "$hostPrivateKey.pub"
    if (-not (Test-Path -LiteralPath $hostPrivateKey -PathType Leaf) -or
        -not (Test-Path -LiteralPath $hostPublicKey -PathType Leaf)) {
        & $sshKeygen -A
        if ($LASTEXITCODE -ne 0) { throw 'OpenSSH host key generation failed' }
    }
    if (-not (Test-Path -LiteralPath $hostPrivateKey -PathType Leaf) -or
        -not (Test-Path -LiteralPath $hostPublicKey -PathType Leaf)) {
        throw 'OpenSSH ed25519 host key missing'
    }

    [System.IO.File]::WriteAllText($AuthorizedKeys, $publicKey, [System.Text.UTF8Encoding]::new($false))
    Set-StrictSshFileAcl -Path $AuthorizedKeys -OwnerSidValue 'S-1-5-32-544'
    Set-StrictSshFileAcl -Path $hostPrivateKey -OwnerSidValue 'S-1-5-18'

    Publish-Status 'running' 'configure-service'
    $config = @(
        'HostKey __PROGRAMDATA__/ssh/ssh_host_ed25519_key',
        'AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys',
        'AuthenticationMethods publickey',
        'MaxAuthTries 3',
        'LoginGraceTime 20',
        'PermitEmptyPasswords no',
        'PasswordAuthentication no',
        'KbdInteractiveAuthentication no',
        'PubkeyAuthentication yes',
        'HostbasedAuthentication no',
        'AllowUsers hstoracle',
        'PermitTTY no',
        'AllowTcpForwarding no',
        'AllowAgentForwarding no',
        'X11Forwarding no',
        'PermitTunnel no',
        'GatewayPorts no',
        'PermitUserEnvironment no',
        'LogLevel VERBOSE',
        'ForceCommand powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\HooSaidThat\ssh-dispatch.ps1'
    ) -join [Environment]::NewLine
    $temporaryConfig = "$SshdConfig.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [System.IO.File]::WriteAllText($temporaryConfig, $config + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
        $validation = & $sshd -t -f $temporaryConfig 2>&1
        if ($LASTEXITCODE -ne 0) {
            $reason = (($validation | Out-String).Trim() -replace '[\r\n]+', ' ')
            throw "sshd configuration invalid: $reason"
        }
        Move-Item -LiteralPath $temporaryConfig -Destination $SshdConfig -Force
        Set-StrictSshFileAcl -Path $SshdConfig -OwnerSidValue 'S-1-5-18'
    }
    finally {
        if (Test-Path -LiteralPath $temporaryConfig) {
            Remove-Item -LiteralPath $temporaryConfig -Force -ErrorAction SilentlyContinue
        }
    }

    Copy-Item -LiteralPath $hostPublicKey -Destination $GuestHostKey -Force
    $existingRule = Get-NetFirewallRule -Name 'HooSaidThat-OpenSSH-22' -ErrorAction SilentlyContinue
    if ($null -ne $existingRule) { Remove-NetFirewallRule -Name 'HooSaidThat-OpenSSH-22' -ErrorAction Stop }
    New-NetFirewallRule -Name 'HooSaidThat-OpenSSH-22' -DisplayName 'HooSaidThat OpenSSH 22' -Direction Inbound -Protocol TCP -LocalPort 22 -Action Allow -Profile Any | Out-Null
    Set-Service -Name sshd -StartupType Automatic
    $service = Get-Service -Name sshd
    if ($service.Status -eq 'Running') {
        if ($DeferServiceRestart) {
            $helperRoot = Join-Path $env:ProgramData 'HooSaidThat'
            [System.IO.Directory]::CreateDirectory($helperRoot) | Out-Null
            $helper = Join-Path $helperRoot 'restart-sshd.ps1'
            [System.IO.File]::WriteAllText(
                $helper,
                "Start-Sleep -Seconds 5`r`nRestart-Service -Name sshd -Force`r`n",
                [System.Text.UTF8Encoding]::new($false)
            )
            Start-Process -FilePath 'powershell.exe' -ArgumentList @(
                '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                '-WindowStyle', 'Hidden', '-File', $helper
            ) -WindowStyle Hidden | Out-Null
        }
        else { Restart-Service -Name sshd -Force }
    }
    else { Start-Service -Name sshd }

    Publish-Status 'ready' 'complete'
}
catch {
    $reason = (($_.Exception.Message -replace '[\r\n\t]+', ' ').Trim())
    if ($reason.Length -gt 1024) { $reason = $reason.Substring(0, 1024) }
    try { Publish-Status 'failed' 'configure-openssh' $reason } catch {}
    throw
}
