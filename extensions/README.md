# Chrome / VS Code タブへのリンク

付箋から既存の特定タブへ戻れます。タブを切り替えても付箋の表示・非表示は切り替わりません。

## Chrome

1. 付箋アプリを一度起動します。
2. ReleaseのChrome拡張ZIPを固定の場所へ展開します。`chrome://extensions`でデベロッパーモードを有効にし、「パッケージ化されていない拡張機能を読み込む」から`chrome`フォルダを選びます。
3. 表示された拡張IDを使い、同梱のPowerShellスクリプトを実行します（管理者権限不要）。

   ```powershell
   .\register-chrome.ps1 -ExtensionId '表示された32文字のID'
   ```

4. リンクしたいタブを開き、Chromeの拡張ボタンをクリックして接続します。
5. 付箋の▾から「タブリンク設定…」を開き、同じChromeウィンドウを選び「選んだタブをリンク」を押します。
6. ほかのタブへ移り、付箋の↗を押すと、元の既存タブに戻ります。

ウィンドウへの貼り付けは🔗で行います。タブへのリンクだけ保存することもできます。

登録は現在のWindowsユーザーの`HKCU\Software\Google\Chrome\NativeMessagingHosts\io.github.hogawish.stickynotes`と設定フォルダの`chrome-native-host.json`です。入力した拡張ID一件のみ許可し、既存の別登録は上書きしません。`-WhatIf`で確認、`-Remove`で解除できます。

権限は`nativeMessaging`、`activeTab`、`storage`です。全サイトの閲覧権限、`tabs`権限、ページ本文の取得、コンテンツスクリプトは使いません。題名を取得できないタブは`Chrome tab <ID>`と表示します。

## VS Code

1. 付箋アプリを一度起動します。
2. Releaseの`.vsix`をVS Codeの「VSIXからインストール」で導入します。
3. リンクしたいタブを選び、コマンドパレットの`Markdown Sticky Notes: このウィンドウを接続`を実行します。
4. 付箋の🔗から同じVS Codeウィンドウを選び、「選んだタブをリンク」を押します。
5. 付箋の↗で、元のタブ・エディタグループに戻れます。

通常のテキスト、テキスト比較、Notebook、Custom Editorタブに対応します。Terminal等の未対応タブでは案内を表示します。同じファイルを別グループで開いていても区別します。

拡張はUI側で動き、ユーザー設定の`tab-host.json`から付箋の実行ファイルを見つけます。ワークスペース設定の任意コマンドは実行しません。ファイルURIはVS Code内の復帰操作にだけ使い、本文やURIを付箋アプリへ送信しません。

## 接続と保存

- 通信はNative Messaging形式の標準入出力と、PC内の`tab-contexts`状態・要求・応答ファイルです。追加のネットワークサーバーやAgent定期起動はありません。
- タブのリンクはPC側の`config.json`に保存し、Markdown本文には書き込みません。
- アプリ再起動・拡張再読み込み後は再接続とリンクの設定が必要です。リンク先が閉じたときはエラーになり、勝手に新規タブを作りません。メモは残ります。
- Chromeのタブを別ウィンドウへ移した場合も、元の接続が有効なら移動先へ戻れます。元のウィンドウ自体が閉じたら再接続してください。
- ウィンドウ追従時は📌OFFなら貼付先の重なり順に従い、📌ONなら常に最前面です。タブ選択状態は付箋の表示に使いません。

[Chrome Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs) / [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) / [VS Code API](https://code.visualstudio.com/api/references/vscode-api)
