param([string[]]$ThreadId)
& (Join-Path $PSScriptRoot 'Manage.ps1') -Action Start -ThreadId $ThreadId
