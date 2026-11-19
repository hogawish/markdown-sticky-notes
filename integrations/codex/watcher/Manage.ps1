param([ValidateSet('Start','Stop','Check')][string]$Action='Check',[string[]]$ThreadId)
$ErrorActionPreference='Stop'
$arguments=@((Join-Path $PSScriptRoot 'fleet.cjs'),$Action.ToLowerInvariant())+@($ThreadId|Where-Object {$_})
$json=& (Get-Command node).Source @arguments
if($LASTEXITCODE -ne 0){throw 'Aggregate operation failed; target state retained'}
$json | ConvertFrom-Json
