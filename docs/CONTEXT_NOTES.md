# アプリについてくる付箋

このアプリの中心目標は、ただデスクトップに置く付箋ではなく、作業中のアプリやタブに結びついて表示が切り替わる付箋を作ることです。

## 現在の段階

- `0.1.0`: Markdown編集・自動保存・トレイ・複数フォルダ。
- `0.2.0`: frontmatterによるsort/filter、アーカイブ、フォルダ移動。
- `0.3.0-alpha.1`: Windowsのアプリウィンドウへの貼付と、移動・リサイズ・最小化への追従。専用ネイティブ試験ウィンドウと実WebViewで確認済み。
- 次の節目: Chrome / VS Codeの「ウィンドウ全体」と「特定タブ」への付け分け。

付箋本文と共有属性はMarkdown、ウィンドウ位置や貼付先との関係はPC側の設定として分けます。アーカイブは整理用の属性であり、タブが見えなくなったことを理由に付箋をアーカイブしたり削除したりしません。

## ウィンドウ追従の最小形

人が選んだ外部ウィンドウへ付箋を貼り、相対位置を保持して移動に追従させます。最小化や対象が非表示のときは追従付箋も隠し、対象が戻れば再表示します。付箋への入力で対象アプリのフォーカス状態が変わることと、対象が本当に閉じたことを区別します。

初期実装はWindows標準の[EnumWindows](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-enumwindows)で貼付先を選び、[GetWindowRect](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowrect)と前面・最小化状態を約120ms周期で確認します。[SetWindowPos](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos)のNOACTIVATEで付箋だけを動かし、フォーカスを奪いません。Agentの定期起動や外部アプリへのDLL注入、入力内容の取得は使いません。まず触れる形を優先し、イベントフック化は負荷や使用感の必要が出た時点で検討します。

ウィンドウタイトルだけを同一性の根拠にせず、接続中のウィンドウ・プロセスを確認します。閉じたウィンドウや再起動後の別ウィンドウへ誤って付け替えないことを確認し、未接続でもメモ本文は残します。

## タブ別の切替

OSのウィンドウ追従と、アプリ内部のタブ識別は別の役割です。タイトル文字列を推測して万能なタブ判別を作る方法は採りません。

- Chrome: [Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)でタブ切替を検出し、[Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)でローカルの付箋アプリへ伝える案を優先します。ページ本文の取得や全サイトの読取権限は前提にせず、必要な権限を具体化します。
- VS Code: [TabGroups API](https://code.visualstudio.com/api/references/vscode-api#TabGroups)のactiveTabGroupとタブ変更イベントを使う拡張を検討します。ファイル名だけでは同名ファイルを区別できないので、URIと実際のタブ・グループの扱いを確認します。

最初は「そのウィンドウの全タブで見せる付箋」と「その特定タブだけで見せる付箋」を分けます。同じURLを別タブで開いた場合や、同じファイルを別グループで開いた場合に、勝手に同じタブとは扱わない方針です。再起動をまたぐ再接続の具体仕様は、実画面の試作とともに確認します。

拡張の導入・Native Messagingホストの登録など、人の環境や権限に関わる操作は、実物と必要な範囲を準備してからまとめて案内します。タブ連携を待たず、ウィンドウ追従の最小版を先に触れる形で渡します。
