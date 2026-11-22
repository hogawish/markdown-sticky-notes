# Agent状態付箋：Codex連携

2026-11-19 / 任意導入の連携ソース。アプリのインストーラーには同梱されません。

Sticky Notes v0.8.4のexe単体には自動監視は含まれません。この一式が別途必要です。Windows 11、Node.js v24.22.1、Codex Desktop 26.1111.2228.0 / engine 0.169.0-alpha.11.1で確認しました。npm依存はなく、Node標準ライブラリだけを使います。別バージョン・別PCでの動作は未確認です。

## 何をするか

明示登録したCodexチャットの既存イベント記録をローカルで末尾監視し、構造化した返事待ちとComputer Useを付箋表示します。Agent/modelの定期起動、ポート待受、新サービス、外部送信はありません。付箋に短い質問名・操作目的・担当名・チャットURIを保存するため、画面や同期対象フォルダの扱いには利用環境の方針を適用してください。

Codex方式は**非公開イベント形式に依存する限定的な代替**です。公式hookで現在のDesktop経路を拾えなかったため採用しました。Claudeは別方式で、公式hookを使った実装が担当者から報告されています。このフォルダにはClaude用の実装・設定は含みません。

## 初期設定

1. Sticky Notes v0.8.4を標準のインストール先に導入し、一度起動する。既定exeは `%LOCALAPPDATA%\Markdown Sticky Notes\app.exe`。違う場合はログオン環境の `STICKY_STATUS_EXE` を設定する。
2. `%USERPROFILE%\Documents\StickyNotes` を付箋一覧から登録する。自動付箋はこのフォルダへ保存する。OneDrive等でDocumentsが移動していても、この環境変数から組み立てた場所を使用する。
3. このフォルダを専用の書き込み可能な固定フォルダへ展開する。監視中は移動しない。他人から書き換えられる共用フォルダは避ける。
4. 対象チャットの公式 `thread/read(includeTurns:false)` メタデータでIDとイベント記録pathを確認する。全ドライブや会話履歴から探索しない。メタデータ取得の自動化は本候補に含まない。
5. 展開先で次を実行する（IDとpathはこのPCの対象に置き換える）。

```text
node configure.cjs THREAD_ID "担当名" "EVENT_RECORD_PATH"
node watcher/fleet.cjs start
node watcher/fleet.cjs check
node watcher/fleet.cjs stop
```

configureは対象別ディレクトリとmanifestを作る。追加時は先にstopする。初回・通常の再起動は記録末尾から開始し、過去の質問を大量に再生しない。startの繰り返しは稼働PIDを再利用する。複数対象も監視は1プロセス。

## ログオン起動

ScheduledTasksが使用でき、スクリプト実行が許可されたPowerShellから、`watcher/Install-Autostart.ps1` を実行する。タスク名は `Markdown Sticky Notes - Codex Watcher`。インストーラはNodeの絶対pathと現在の展開先を登録する。このPCの実行ポリシーを変更・迂回しない。

PowerShellスクリプトが禁止されている場合は、管理者承認の通常手順で同じタスクを登録する。アクションはNodeの絶対path、引数は `"展開先\watcher\fleet.cjs" serve-auto`、作業フォルダは同fleetフォルダ。現在のユーザーのログオン時、ログオン中のみ、通常権限、非表示、時間制限なし、バッテリーでも実行、既に実行中なら新規を起動しない（IgnoreNew）。パスワード保存や最高権限は不要。

登録直後にタスクを一度実行し、checkで全対象runningを確認する。繰り返し実行してもPIDが増えないことを確認する。Task Scheduler直下でNodeが常駐するためCodexの子プロセスとして起動する構成ではない。PC再起動・実サインアウト・Desktop終了の実試験は行っていない。

停止は先に `node watcher/fleet.cjs stop`。恒久停止はログオン起動タスクも無効化または削除する。設定・state・既存付箋は削除しない。

## 終了判定・保持・復旧

### 通常の最終チャットでの返事待ち（対象別に明示有効化）

対象の`target.json`で`"plainChatWait": true`を指定すると、`phase: final_answer`かつ`status: completed`の最終回答だけを補完判定します。既定は無効です。稼働中の変更は、未解決状態とcheckpointを保全する担当の更新手順で行います。

- 最後の本文行が`?` / `？`で終わる場合、または「返事をお願いします」「承認を待っています」など狭い明示待ち表現の場合に表示します。実行中commentary、コードフェンス、引用行、インラインコード・引用だけの問いは除外します。
- 通常待ちの終了は、同じチャットに届いた`role: user`・`user.text`・記録側`provenance.type: user`の本人メッセージだけです。Agent/harness/発信元不明や中継envelopeでは閉じません。現補完は単独テキスト入力を対象とし、画像だけ・複数ブロック入力は保証しません。
- 同じturnの繰り返しや既存質問ツール待ちで二重作成しません。通常待ちの後に質問ツールが来た場合も同じepisodeを再利用します。checkpointに待ちIDを保持し、停止・再起動・Agent連絡だけでは終了にしません。
- 記録形式への依存と判定漏れは残ります。最終文が問いかけでも修辞疑問や他Agent宛なら出る場合があり、問いの後に通常の説明文が続く場合は拾えません。全文意味解析や実行承認画面の取得は行いません。

合成試験は`node integrations/codex/lib/test-chat-wait.cjs`。2026-11-22、最終回答限定・除外・二重抑制・発信元・引継ぎ・終了時刻付きarchive・async/blocking質問ツールとの共存を確認済み。本物のHuman返信による受入は、配置先チャットで別途確認します。

### 質問ツールとその他の経路

- 非同期質問ツールの返答は、記録側のHuman provenance、構造化回答、質問callID、質問番号のすべてを照合する。Agentの連絡、本文内の回答らしい文字列、Stopでは終了しない。blocking質問ツールは同じcallIDの結果が返った時点で待ちを終了する（回答・取消の意味は推測しない）。
- Computer Useは直接呼出しの開始から、対応するcompletion_summary呼出し結果まで。コードモード内の任意の間接呼出し、承認待ち全般は対象外。通常チャットの補完は上の明示有効化対象のみ。
- 対象ごとにstate/queue/lock/checkpointを分離し、単一対象の形式エラーが他の対象を止めない。終了時はCreatedと本文を保持してended_atを記録し、付箋を閉じてアーカイブする。
- ログオン復帰で未解決付箋を勝手に終了しない。停止中にHumanが返答した場合は、通常復帰でその過去返答を再生しないため付箋が残る可能性がある。担当チャットで実態を確認し、対象をstopしてstateと付箋を保全したうえで手動整理する。**消えない＝未回答とは限らない**。通常のアーカイブだけではwatcher内部のpendingは解消しないので、stateの手動削除はせず、確認済みcallIDを添えて運用担当へ復旧を依頼する。
- 異常終了後の死んだPIDのwatcher lockは起動時に除去する。存命PID/不明なlockは強制解除しない。episode lock競合やPID再利用などで復旧できなければログとstateを保持して止める。
- 稼働状態はcheck、ログはfleetのautostart.jsonl/aggregate-errors.logと各対象stateのwatch-events.jsonl。会話全文やtool入力を新規ログへ複写しない。

## 確認状況

合成試験：HumanとAgentの区別、未解決保持、終了アーカイブ、対象間分離、単一PID、二重start、対象限定stopが成功。本PCでは23対象・単一監視をログオン起動タスクから復帰し、反復実行で同一PIDを確認。Human返事待ちと実Computer Useの自動表示・終了は先行実運用で確認済み。別PCで利用する際は、導入後に実際のフローを確認してください。

この一式には個人の対象一覧、state、ログ、URI設定を含めません。展開後に作られるmanifest/targets/stateはそのPC固有の情報であり、再配布しない。

MicrosoftのIgnoreNew仕様： https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-multipleinstancespolicy-settingstype-element
