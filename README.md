# Markdown Sticky Notes

![Markdown Sticky Notes icon](app/src-tauri/icons/128x128.png)

Windows向けの、普通のMarkdownファイルを使うデスクトップ付箋アプリです。付箋を1枚ずつ開いて編集でき、人間もAgentも同じファイルを扱えます。アカウントや専用同期サーバーは不要です。

現在は初期版です。重要なメモはフォルダごとバックアップしてください。

## できること

- 複数のメモフォルダを登録し、一覧から付箋を開く
- 枠なしウィンドウの移動・リサイズ、色変更、前面固定
- Markdownの文字を残した編集、書式ショートカット、`/`による書式選択
- `@today`、`@tomorrow`、`@now`などの日時挿入
- HTTP/HTTPSのURLをCtrl+クリックで開く
- 自動保存と外部変更の読込、変更が重なったときの選択
- 完全削除せず、同じフォルダの`.trash`へ片付ける
- タスクトレイから一覧・新規付箋・終了

他アプリに追従する貼り付け、付箋スタック、付箋間リンク、タグやstatusによる絞り込みは、まだ実装されていません。

## 保存場所

既定のメモフォルダは`%USERPROFILE%\Documents\StickyNotes`です。一覧の「フォルダを追加…」から、別のローカルフォルダや共有フォルダを登録できます。

1付箋は1つのUTF-8 Markdownファイルです。先頭のYAML frontmatterは文字列のまま保持し、本文を書き換えます。未知のキーを削除しません。YAML全体の検証や、全メモへの必須属性の追加は行いません。タイトルは本文の最初の空でない行です。

ウィンドウの位置・サイズ・開閉・前面固定は、Tauriのユーザー設定ディレクトリ`io.github.hogawish.stickynotes`の`config.json`へ保存します。本文とPC固有の配置は別々です。設定のキーは現在ファイルパスなので、ファイルの移動後は配置が引き継がれないことがあります。

設定で暗号化は行いません。登録フォルダのファイルを読める人やAgentは、メモを読めます。共有範囲はOSや共有フォルダ側の権限で管理してください。

## 保存と共有

入力が止まって約600msで保存し、外部の更新を約1秒間隔で確認します。保存中に追記した文字は、先の保存が終わった後に続けて保存します。保存に失敗・競合したときは、入力を残し、閉じる・片付ける操作を完了しません。

一覧やトレイからの終了も、付箋ごとの保存と終了処理を通ります。保存できない付箋があれば、その窓を残します。正常終了では、開いていた付箋を次回起動で復元します。Windowsの強制終了・電源断・プロセス強制停止では、まだ保存されていない文字は失われ得ます。

外部変更の比較には本文とfrontmatterを含むファイル全体のSHA-256を使います。読込時点から変わっていれば競合として表示します。同一アプリ内の書込は直列化し、一意な一時ファイルから置換します。

**複数PCや外部Agentとの同時編集に対する、分散ロックや原子的な比較更新はありません。** 最後の確認と置換のわずかな間に外部が保存する競合は残ります。同じメモを同時に編集せず、担当を分けて運用してください。ネットワーク共有の可用性や性能も共有先に依存します。

開いている付箋の入力を消さないため、そのフォルダを登録から外す前に該当する付箋を閉じてください。フォルダ登録を外してもメモファイルは削除しません。不正UTF-8のファイルは自動変換せず、エラーとして開く処理を停止します。

## 開発環境とビルド

Windows、Node.js 22.12以降の対応版（検証は24.22.1）、Rust stable、Visual StudioのC++ Build ToolsとWindows SDK、WebView2が必要です。Tauriの[Windows向け前提条件](https://v2.tauri.app/start/prerequisites/#windows)を参照してください。

PowerShellでリポジトリ直下から実行します。

```powershell
cd app
npm ci
npm test
npm run build
cd src-tauri
cargo test --locked --lib
cd ..
npm run tauri -- build
```

開発時も先に`npm run build`してから`npm run tauri -- dev`で起動できます。HMR用の開発サーバーは設定していません。

検証には`STICKY_DIR`（既定のメモフォルダ）、`STICKY_CONFIG_DIR`（設定フォルダ）を指定できます。初回の空設定で使用します。`STICKY_NO_SINGLE=1`は単一起動の検査を無効にします。テスト用には専用のメモ・設定フォルダを指定してください。

```powershell
$env:STICKY_DIR = "$PWD\scratch\notes"
$env:STICKY_CONFIG_DIR = "$PWD\scratch\config"
$env:STICKY_NO_SINGLE = "1"
npm run tauri -- dev
```

独自アイコンの編集元は`app/src-tauri/icons/source.svg`です。`app`内で`npm run tauri -- icon src-tauri/icons/source.svg`を実行すると配布用サイズを再生成できます。

## 検証範囲

Windows上でフロントのビルド、保存競合を再現するJS回帰テスト7件、Rust単体テスト13件を実行しています。JS回帰テストはDOMとIPCの模擬環境です。すべてのGUI操作、IME、DPI構成、ネットワークドライブの実機動作を保証するものではありません。

## ライセンス

自作コードと独自アイコンは[MIT License](LICENSE)です。依存ライブラリや初期テンプレートの権利は、それぞれの作者に帰属します。[第三者ライセンスとソース取得先](THIRD_PARTY_NOTICES.md)を参照してください。

Windows、Microsoft、Tauri等は各権利者の商標です。本アプリは各社・各プロジェクトの公式製品ではありません。
