[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Output)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$source=Join-Path $PSScriptRoot 'chrome'
$destination=[IO.Path]::GetFullPath($Output)
$parent=Split-Path -Parent $destination
New-Item -ItemType Directory -Path $parent -Force | Out-Null
$manifest=Get-Content -LiteralPath (Join-Path $source 'manifest.json') -Raw | ConvertFrom-Json
foreach($icon in $manifest.icons.PSObject.Properties.Value){
    if(!(Test-Path -LiteralPath (Join-Path $source $icon) -PathType Leaf)){throw "Missing icon: $icon"}
}
# Package only the extension root; setup scripts and README must not sit above manifest.json.
[IO.Compression.ZipFile]::CreateFromDirectory($source,$destination,[IO.Compression.CompressionLevel]::Optimal,$false)
$zip=[IO.Compression.ZipFile]::OpenRead($destination)
try {
    if(!$zip.GetEntry('manifest.json') -or !$zip.GetEntry('background.js')){throw 'Invalid extension ZIP root'}
    if(@($zip.Entries | Where-Object {$_.FullName.EndsWith('.ps1')}).Count){throw 'Setup script included in store package'}
} finally {$zip.Dispose()}
Get-FileHash -LiteralPath $destination -Algorithm SHA256
