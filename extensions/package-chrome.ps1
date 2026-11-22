[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Output,[switch]$Manual)
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
if($Manual){
    $manifest | Add-Member -NotePropertyName options_ui -NotePropertyValue @{page='migration.html';open_in_tab=$true} -Force
    $manifest | Add-Member -NotePropertyName version_name -NotePropertyValue ($manifest.version+' manual') -Force
    $archive=[IO.Compression.ZipFile]::Open($destination,[IO.Compression.ZipArchiveMode]::Create)
    try{
        foreach($file in Get-ChildItem -LiteralPath $source -Recurse -File){
            $relative=[IO.Path]::GetRelativePath($source,$file.FullName).Replace('\','/')
            if($relative -eq 'manifest.json'){continue}
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,$file.FullName,$relative,[IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
        $entry=$archive.CreateEntry('manifest.json')
        $writer=[IO.StreamWriter]::new($entry.Open(),[Text.UTF8Encoding]::new($false))
        try{$writer.Write(($manifest | ConvertTo-Json -Depth 6))}finally{$writer.Dispose()}
        foreach($name in @('migration.html','migration.js','migration.css')){
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,(Join-Path $PSScriptRoot ('chrome-manual/'+$name)),$name,[IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    }finally{$archive.Dispose()}
}else{
    [IO.Compression.ZipFile]::CreateFromDirectory($source,$destination,[IO.Compression.CompressionLevel]::Optimal,$false)
}
$zip=[IO.Compression.ZipFile]::OpenRead($destination)
try {
    if(!$zip.GetEntry('manifest.json') -or !$zip.GetEntry('background.js')){throw 'Invalid extension ZIP root'}
    if(@($zip.Entries | Where-Object {$_.FullName.EndsWith('.ps1')}).Count){throw 'Setup script included in store package'}
} finally {$zip.Dispose()}
Get-FileHash -LiteralPath $destination -Algorithm SHA256
