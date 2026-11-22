# Chrome / VS Code タブへのリンク

付箋から既存の特定タブへ戻れます。タブを切り替えても付箋の表示・非表示は切り替わりません。

## Chrome

### Chrome Web Store版（公開準備中）

本体0.12.1以降のインストーラーは、ストアID `gmddcmanllooimaoidnndbpblohcopip` に対するNative Messagingホストを現在のWindowsユーザーへ自動登録します。インストール後、ストア版拡張のツールバーボタンを押して接続します。新規導入ではPS1の手動実行は不要です。ストアの審査・公開は別工程であり、以下の手動導入も利用できます。[審査・確認手順（英語）](../docs/CHROME_WEBSTORE_REVIEW.md)

更新では同じ実行ファイルに登録済みの開発版IDを保持してストアIDを追加します。別のmanifestや別インストールの実行ファイルを指す登録は上書きせず、インストーラーで警告します。

### 手動導入版

1. 付箋アプリを一度起動します。
2. ReleaseのChrome拡張ZIPを固定の場所へ展開します。`chrome://extensions`でデベロッパーモードを有効にし、「パッケージ化されていない拡張機能を読み込む」から`chrome`フォルダを選びます。
3. 表示された拡張IDを使い、同梱のPowerShellスクリプトを実行します（管理者権限不要）。

   ```powershell
   .\register-chrome.ps1 -ExtensionId '表示された32文字のID'
   ```

4. リンクしたいタブを開き、Chromeの拡張ボタンをクリックして接続します。
5. 付箋の🔗を長押しして「クリックでタブをリンク」を選び、Chromeのタブをクリックします。
6. ほかのタブへ移り、付箋下部のタブ名を押すと、元の既存タブに戻ります。Chromeでは登録したタブを別ウィンドウに移しても、同じタブに戻れます。

ウィンドウへの貼り付けは🔗で行います。タブへのリンクだけ保存することもできます。

登録は現在のWindowsユーザーの`HKCU\Software\Google\Chrome\NativeMessagingHosts\io.github.hogawish.stickynotes`と設定フォルダの`chrome-native-host.json`です。入力した拡張ID一件のみ許可し、既存の別登録は上書きしません。スクリプトは未署名です。同じGitタグのスクリプトと内容を照合でき、`-WhatIf`で予定している変更を確認できます。

解除には `./register-chrome.ps1 -Remove` を使えます。アンインストーラーも、登録先がこのインストールの実行ファイルと一致するときはChromeの登録を解除します。Chromeから拡張自体を削除する場合は、Chromeの拡張機能画面を使ってください。

権限は`nativeMessaging`、`activeTab`、`storage`、`contextMenus`です。全サイトの閲覧権限、`tabs`権限、ページ本文の取得、コンテンツスクリプトは使いません。題名を取得できないタブは`Chrome tab <ID>`と表示します。

## VS Code

1. 付箋アプリを一度起動します。
2. Releaseの`.vsix`をVS Codeの「VSIXからインストール」で導入します。
3. リンクしたいタブを選び、コマンドパレットの`Markdown Sticky Notes: このウィンドウを接続`を実行します。
4. 付箋の🔗を長押しして「クリックでタブをリンク」を選び、エディタタブをクリックします。
5. 付箋下部のタブ名を押すと、元のタブ・エディタグループに戻れます。

通常のテキスト、テキスト比較、Notebook、Custom Editorタブに対応します。Terminal等の未対応タブでは案内を表示します。同じファイルを別グループで開いていても区別します。

拡張はUI側で動き、ユーザー設定の`tab-host.json`から付箋の実行ファイルを見つけます。ワークスペース設定の任意コマンドは実行しません。ファイルURIはVS Code内の復帰操作にだけ使い、本文やURIを付箋アプリへ送信しません。

## 接続と保存

- 通信はNative Messaging形式の標準入出力と、PC内の`tab-contexts`状態・要求・応答ファイルです。追加のネットワークサーバーやAgent定期起動はありません。
- タブのリンクはPC側の`config.json`に保存し、Markdown本文には書き込みません。
- アプリ再起動・拡張再読み込み後は再接続とリンクの設定が必要です。リンク先が閉じたときはエラーになり、勝手に新規タブを作りません。メモは残ります。
- Chromeのタブを別ウィンドウへ移した場合も、拡張の接続が続いていれば、元のウィンドウを閉じた後でも↗で移動先へ戻れます。同じChromeプロファイルの新しいウィンドウも「クリックでタブをリンク」から選べます。付箋をChromeウィンドウに貼り付けている場合は、↗で戻ったときに貼付け先も移ります。分離直後の照合改善にはChrome拡張0.3.2が必要です。既存の展開先に上書きして拡張を再読み込みし、Chromeのツールバーから再接続してください。
- ウィンドウ追従時は📌OFFなら貼付先の重なり順に従い、📌ONなら常に最前面です。タブ選択状態は付箋の表示に使いません。

[Chrome Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs) / [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) / [VS Code API](https://code.visualstudio.com/api/references/vscode-api)

## 右クリックからリンク済み付箋を作る（拡張0.4.0以降）

Chromeのタブ／VS Codeのファイルタブを右クリック →「このタブにリンクした付箋を作成」。新しい付箋にはタブへのリンクとウィンドウへの貼付けが設定されます。その後、🔗から別の付箋に親子付けしても、タブリンクは残ります。

- 保存先は、付箋一覧で最後に選んだフォルダ。未選択なら最初に使える登録フォルダです。選択済みフォルダが使えない場合は中止し、別フォルダへ黙って保存しません。
- 非アクティブなタブも、右クリックした対象を使います。VS Codeで同じURI・同じ位置のタブが複数グループにある場合は、グループを一度選びます。Terminalなど未対応タブでは作成しません。
- 作成中に別ウィンドウへ移ると中止します。元のアプリを前面にしたまま完了を待ってください。
- Chromeがタブメニュー拡張に未対応の場合は、ページ内の右クリックに同じ項目が出ます。
- タイムアウトの場合は付箋一覧を確認してから再実行してください。自動再試行は行いません。
- 通信・保存は引き続きこのPC内のみ。タブの題名と一時IDを送り、ページ本文やVS CodeのファイルURIは送りません。

実装根拠: [Chrome contextMenus](https://developer.chrome.com/docs/extensions/reference/api/contextMenus#type-ContextType) / [VS Code menu arguments](https://code.visualstudio.com/api/references/contribution-points#contributes.menus)。
