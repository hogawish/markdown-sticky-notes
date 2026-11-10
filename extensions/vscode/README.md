# Markdown Sticky Notes — Tab Links

付箋のクリックで、既に開いているVS Codeの特定タブへ戻る拡張です。タブ選択による付箋の表示切替は行いません。

1. Markdown Sticky Notesを一度起動します。
2. リンクしたいタブでコマンドパレットの`Markdown Sticky Notes: このウィンドウを接続`を実行します。
3. 付箋の🔗から同じVS Codeウィンドウを選び、「選んだタブをリンク」を押します。
4. 付箋の↗で既存タブへ戻ります。

通常のテキスト、比較、Notebook、Custom Editorタブが対象です。タブを閉じた場合や未対応種類ではエラーを表示し、新しいタブを作りません。同じファイルの別エディタグループを区別します。再起動後は再接続・再リンクしてください。

本文やファイルURIは付箋アプリへ送信しません。復帰のために入力URIをVS Code内で使います。付箋実行ファイルはユーザー設定フォルダの`tab-host.json`から探します。

詳しい導入方法: https://github.com/hogawish/markdown-sticky-notes/tree/main/extensions
