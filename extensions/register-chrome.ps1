[CmdletBinding(SupportsShouldProcess=$true)]
param(
    [ValidatePattern('^[a-p]{32}$')][string]$ExtensionId,
    [string]$Executable,
    [switch]$Remove
)
$ErrorActionPreference='Stop'
$configRoot=Join-Path $env:APPDATA 'io.github.hogawish.stickynotes'
$manifest=Join-Path $configRoot 'chrome-native-host.json'
$registry='HKCU:\Software\Google\Chrome\NativeMessagingHosts\io.github.hogawish.stickynotes'
if($Remove){
    if(Test-Path -LiteralPath $registry){
        if((Get-Item -LiteralPath $registry).GetValue('') -ne $manifest){throw '別の登録があるため変更しません。'}
        if($PSCmdlet.ShouldProcess($registry,'Remove this Sticky Notes native host registration')){Remove-Item -LiteralPath $registry}
    }
    return
}
if(!$ExtensionId){throw 'Chromeの拡張画面に表示されたExtensionIdを指定してください。'}
if(!$Executable){
    $location=Join-Path $configRoot 'tab-host.json'
    if(!(Test-Path -LiteralPath $location)){throw '先に付箋アプリのタブ対応版を一度起動してください。'}
    $Executable=(Get-Content -LiteralPath $location -Raw | ConvertFrom-Json).executable
}
if(!(Test-Path -LiteralPath $Executable -PathType Leaf)){throw '付箋実行ファイルが見つかりません。'}
$Executable=(Resolve-Path -LiteralPath $Executable).Path
if(Test-Path -LiteralPath $registry){
    $registered=(Get-Item -LiteralPath $registry).GetValue('')
    if($registered -ne $manifest){throw '既存の別登録を上書きしません。'}
    if(Test-Path -LiteralPath $manifest){
        $existing=Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
        if(@($existing.allowed_origins) -notcontains "chrome-extension://$ExtensionId/"){throw '別の拡張IDが登録済みです。意図した変更なら先に-Removeで解除してください。'}
    }
}
$body=@{name='io.github.hogawish.stickynotes';description='Markdown Sticky Notes tab context';path=$Executable;type='stdio';allowed_origins=@("chrome-extension://$ExtensionId/")} | ConvertTo-Json
Write-Output "Native host: $Executable"
Write-Output "Allowed extension: $ExtensionId"
if($PSCmdlet.ShouldProcess($registry,'Register Chrome native host for this extension ID only')){
    New-Item -ItemType Directory -Path $configRoot -Force | Out-Null
    [IO.File]::WriteAllText($manifest,$body,(New-Object Text.UTF8Encoding($false)))
    New-Item -Path $registry -Force | Out-Null
    Set-Item -LiteralPath $registry -Value $manifest
    Write-Output '登録しました。Chromeの拡張ボタンで接続できます。'
}
