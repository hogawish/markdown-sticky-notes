param([string]$TaskName='Markdown Sticky Notes - Codex Watcher')
$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$runner=Join-Path $PSScriptRoot 'fleet.cjs'
$action=New-ScheduledTaskAction -Execute (Get-Command node).Source -Argument "`"$runner`" serve-auto" -WorkingDirectory $PSScriptRoot
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal=New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$task=New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Local event-driven sticky status watcher. No Agent/model schedule, port, or service.'
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Select-Object TaskName,State
