# Invoked by the host after an authenticated WinHoo desktop attestation.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$guest = Get-Content C:\ProgramData\WinHoo\owner.json -Raw | ConvertFrom-Json
if ($guest.account -cne 'HstOracle' -or $env:USERNAME -ine 'HstOracle') { throw 'Wrong test account' }
$payload = Join-Path $env:USERPROFILE 'hst-payload.zip'
$private = 'C:\ProgramData\HooSaidThat'
$stage = Join-Path $env:TEMP ('hst-' + [guid]::NewGuid().ToString('N'))
try {
    Expand-Archive -LiteralPath $payload -DestinationPath $stage
    $owner = Get-Content "$stage\owner.json" -Raw | ConvertFrom-Json
    if ($owner.uuid -cne $guest.uuid) { throw 'Payload belongs to a different desktop' }
    if (Test-Path "$private\winhoo-owner.json") {
        $old = Get-Content "$private\winhoo-owner.json" -Raw | ConvertFrom-Json
        if ($old.uuid -cne $guest.uuid) { throw 'Runtime belongs to a different desktop' }
    } elseif ((Test-Path C:\HooSaidThat) -or (Test-Path C:\OEM\hoosaidthat)) {
        throw 'Existing HooSaidThat install has no WinHoo owner; refusing to change it'
    }
    $task = Get-ScheduledTask -TaskName 'HooSaidThat NVDA Oracle' -ErrorAction SilentlyContinue
    if ($task) {
        $env:SSH_ORIGINAL_COMMAND = 'stop'
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\HooSaidThat\ssh-dispatch.ps1 | Out-Null
        if ($LASTEXITCODE) { throw 'Could not stop prior owned oracle' }
    }
    New-Item -ItemType Directory -Path "$private\cache" -Force | Out-Null
    New-Item -ItemType Directory -Path 'C:\OEM' -Force | Out-Null
    if (Test-Path C:\OEM\hoosaidthat) { Remove-Item C:\OEM\hoosaidthat -Recurse -Force }
    Copy-Item "$stage\owner.json" "$private\winhoo-owner.json" -Force
    Copy-Item "$stage\control-token" "$private\provision-token" -Force
    $artifacts = Get-Content "$stage\cache.json" -Raw | ConvertFrom-Json
    foreach ($spec in $artifacts) {
        $file = Join-Path $env:USERPROFILE $spec.name
        $cache = Join-Path "$private\cache" $spec.name
        if (Test-Path $file) {
            if ((Get-FileHash $file -Algorithm SHA256).Hash -ine $spec.sha256) { throw 'Transferred artifact digest mismatch' }
            Move-Item $file $cache -Force
        }
    }
    Copy-Item "$stage\oem\*" C:\OEM -Recurse -Force
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\OEM\provision.ps1 -WinHooLocal
    if ($LASTEXITCODE) {
        $receipt = Get-Content "$private\bootstrap\oem-status.json" -Raw | ConvertFrom-Json
        throw "Provisioning failed: $($receipt.phase): $($receipt.error)"
    }
    Write-Output 'Real NVDA and Chrome provisioned; runtime endpoints still require verification.'
} finally {
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $payload -Force -ErrorAction SilentlyContinue
    Remove-Item "$private\provision-token" -Force -ErrorAction SilentlyContinue
}
