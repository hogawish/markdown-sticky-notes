# Agent状態付箋 hook（Claude Code）

Claude Code が人の返事を待って止まったら、デスクトップに「判断待ち」の付箋を出します。返事をもらったら付箋を閉じて、終了時刻を書き込みます（アーカイブ）。

## 中身

| ファイル | 役割 |
|---|---|
| `sticky_hook.mjs` | hook本体（Node.js）。イベントを受けて付箋を開く・閉じる |
| `settings.hooks.example.json` | `settings.json` に足す hooks の最小例 |
| `sticky-hook.example.json` | 窓口名・担当名を project ごとに変えたいときの例（任意） |

ログ・状態・受領票・個人の設定値は入っていません。これらは導入先で実行すると作られます。

## 必要なもの

- Windows。PowerShellスクリプトの実行や実行ポリシーの変更は不要
- Node.js v24.22.1で確認（npm依存なし）
- Claude Code 2.1.326 / Claude Desktop 6.6395.0の実イベントで先行確認。次の hook イベントが使える版：Notification、PreToolUse、PostToolUse、PostToolUseFailure、PermissionDenied、UserPromptSubmit、Stop
  - `async: true`、`args` 形式、transcript の `promptId`／`origin` が要る。古い版では判定できず、付箋が残る側に倒れる
- Markdown Sticky Notes v0.8.4（`app.exe`）。`open` / `close` / `--result` に対応した版
  - 既定の場所は `%LOCALAPPDATA%\Markdown Sticky Notes\app.exe`
  - 付箋の保存先は既定で `%USERPROFILE%\Documents\StickyNotes`
  - 場所が違うときは環境変数 `STICKY_APP_EXE` と `STICKY_NOTE_DIR` で上書きする

## 導入

先に付箋保存先（既定では `%USERPROFILE%\Documents\StickyNotes`）を付箋アプリの一覧から登録してください。スクリプト配置先とは別です。


1. このフォルダを `%USERPROFILE%\.claude\hooks\agent-sticky\` に置く。場所はどこでもよいが、以下ではここを `<HOOK_DIR>` と呼ぶ
2. `%USERPROFILE%\.claude\settings.json` をバックアップする
3. `node configure.cjs` でこのPCのNode・スクリプト絶対pathを設定したJSONを出力する（設定ファイルの自動変更はしない）。出力または `settings.hooks.example.json` の各イベントの項目を、既存の `hooks` に**追記**する。置き換えない
   - `<HOOK_DIR>` は実際の場所に書き換える（`C:/Users/<you>/.claude/hooks/agent-sticky` のようにスラッシュで）
   - 既存の hook があるイベントでは、配列に一つ足す
4. 任意：project ごとに名前を変えたいときは、`<project>/.claude/sticky-hook.json` を置く（`sticky-hook.example.json` を参照）
   - 置かないときは、窓口名に project フォルダ名、担当名に `Claude` が使われる
   - `link` も書ける。ただし正式に取得したチャットリンクだけを書く。ローカルIDからURLを組み立てない。無ければリンク行は出ない
5. 新しい Claude Code セッションを開く（設定は起動時に読まれる）
6. 確認：Claude に「AskUserQuestion で何か聞いて」と頼む。右上に付箋が出て、答えると閉じれば成功。`<HOOK_DIR>\hook.log` に `begin` と `end` が並ぶ

## 止め方

- `settings.json` から `sticky_hook.mjs` を呼ぶ項目を消す（他の設定変更もある場合、バックアップ全体で無条件に上書きしない）。次のセッションから止まる
- 開いたまま残った付箋は、手で閉じるか、`node <HOOK_DIR>/sticky_hook.mjs --end-session <session_id> [--kind reply|cu]` で閉じる

## いつ出て、いつ閉じるか

| 種類 | 出すとき | 閉じるとき |
|---|---|---|
| 判断待ち（ask） | `AskUserQuestion` の PreToolUse | 同じ tool_use_id の PostToolUse、本人の UserPromptSubmit |
| 判断待ち（wrapup） | `mcp__ccd_turn__wrap_up` を `blocked: true` で呼んだとき（Claude デスクトップアプリ） | 本人の UserPromptSubmit |
| 判断待ち（permission） | Notification の `permission_prompt` / `elicitation_*`（デスクトップでは約6秒後に来る） | 次の PostToolUse / PostToolUseFailure、PermissionDenied、本人の UserPromptSubmit、Stop |
| Computer Use（cu） | `mcp__computer-use__*` / `mcp__remote-devices__*` の PreToolUse | Stop |

- 付箋は待ちごとに新しい GUID で作る。同じ待ちの間は二重に開かない
- 閉じる順番（アーカイブ手順）：close → この付箋のアプリ設定がclosedになったか確認 → `ended_at`・`archived: true`・終了行を書く → 読み直して確認
- 時刻は日本時間（+09:00）固定で書く

## 「本人の返事」の見分け方（origin判別）

- 次の入力をそのまま本人の返事とはみなさない
- hook入力の `prompt_id` で transcript の user 行を探し、構造化属性 `origin.kind` が `human` のときだけ閉じる
- `peer`（他のエージェントからの中継など）や、見つからないときは付箋を残し、`hook.log` に `keep-open` と書く
- 本文に「Humanが言った」などと書いてあっても見ない

## 配布版の差分

先行の持ち運び用ソースを整理して収録しました。PowerShellの窓数カウントは使用せず、対象付箋のCLI受領票とアプリ設定の `open: false` を照合します。閉じた確認が取れない場合はアーカイブせずstateを保持します。またAskUserQuestionのtool_use_idが不明・不一致の場合は終了しません。この整理版は合成dry-run試験済みで、先行版の実イベント確認とは区別しています。

## 確認状況

**実イベントで確認済み**（作者の環境、2026-11-19）

- `AskUserQuestion`：付箋が出て、回答で閉じてアーカイブされた
- `blocked: true` の wrap_up：付箋が出て、本人の返事で閉じた
- origin判別：他エージェントからの中継2通では残り、本人の返事で閉じてアーカイブされた

**未確認・分かっている弱点**

- Computer Use の付箋は、実イベントではまだ確かめていない
- 許可ダイアログ（permission）は実イベントでは未確認。許可を聞かない設定では出ないため
- 判断待ちの最中にほかのツールが並行して終わると、permission の付箋が早めに閉じることがある
- transcript の属性名が変わると判定できなくなる。そのときは付箋が残る側に倒れるので、明示終了で閉じる

## 記録

- `hook.log`：動作の記録。`debug.flag` というファイルを置くと全イベントを記録する（調べ終わったら消す）
- `state/`・`receipts/`：実行中の状態と、付箋アプリの受領票
- これらには session ID や付箋のパスが入るので、他の人へ渡すときは含めない

## 公式仕様

Hookのexec形式（command/args）、非同期実行： https://code.claude.com/docs/en/hooks

利用環境の管理設定でHookが制限されている場合は、その通常の導入手順に従ってください。既存設定の上書きや承認の持ち込みは行いません。
