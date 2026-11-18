param($Request)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
$prefix = @('--distribution', $Request.distribution)
if ($Request.user) { $prefix += @('--user', $Request.user) }
$prefix += @('--exec', '/usr/bin/python3', $Request.worker)

if ($Request.operation -eq 'status') {
    $output = & $wsl @prefix '_status' $Request.payload
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $result = ($output -join [Environment]::NewLine) | ConvertFrom-Json
    if ($Request.attempt) {
        $task = Get-ScheduledTask -TaskName $Request.task -ErrorAction SilentlyContinue
        if ($task) {
            $info = Get-ScheduledTaskInfo -TaskName $Request.task
            $result | Add-Member -NotePropertyName scheduler -NotePropertyValue ([string]$task.State)
            $result | Add-Member -NotePropertyName schedulerResult -NotePropertyValue ([int64]$info.LastTaskResult)
            if ($result.state -eq 'no receipt' -and $task.State -ne 'Running' -and $info.LastRunTime.Year -gt 2000) {
                $result.state = 'task ended without a receipt'
            }
        }
    }
    $result | ConvertTo-Json -Compress -Depth 6
    exit 0
}
if ($Request.operation -notin @('start', 'recover')) { throw 'Unknown qualification request' }
# Paths are validated by the launcher. Quote every native Windows argument, including spaces.
$workerMode = if ($Request.operation -eq 'recover') { '_recover' } else { '_run' }
$argv = @($prefix) + @($workerMode, $Request.payload)
$arguments = ($argv | ForEach-Object { '"' + $_ + '"' }) -join ' '
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$user = $identity.Name
function Same-Principal([string]$name) {
    if ($name -eq $identity.User.Value) { return $true }
    return ([System.Security.Principal.NTAccount]::new($name)).Translate([System.Security.Principal.SecurityIdentifier]).Value -eq $identity.User.Value
}
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$action = New-ScheduledTaskAction -Execute $wsl -Argument $arguments
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$marker = 'HooSaidThat retained NVDA qualification'
$task = Get-ScheduledTask -TaskName $Request.task -ErrorAction SilentlyContinue
if ($task) {
    if ($task.Description -cne $marker -or $task.Actions.Count -ne 1 -or
        $task.Actions[0].Execute -ine $wsl -or $task.Actions[0].Arguments -cne $arguments -or
        -not (Same-Principal $task.Principal.UserId) -or $task.Principal.RunLevel -ne 'Limited') {
        throw 'Existing scheduled task differs from the requested identity'
    }
    # Never resubmit an existing attempt (even after its owner disconnected).
    $info = Get-ScheduledTaskInfo -TaskName $Request.task
    if ($task.State -ne 'Running' -and $info.LastRunTime.Year -le 2000) {
        throw 'Task exists without a recorded start; inspect its state before using a fresh attempt ID'
    }
} else {
    Register-ScheduledTask -TaskName $Request.task -Action $action -Settings $settings -Principal $principal -Description $marker | Out-Null
    Start-ScheduledTask -TaskName $Request.task
}
[PSCustomObject]@{attempt=$Request.attempt; task=$Request.task; scheduler=(Get-ScheduledTask -TaskName $Request.task).State.ToString()} | ConvertTo-Json -Compress
exit 0
