# チャット同意API

このAPIは、利用者が確認したモデルと会話内容だけをCopilot SDKへ送ります。開発者は、モデル一覧の取得、送信内容のプレビュー、明示的な実行確認の順に呼び出します。

## 利用条件

- APIのBearerトークンには、サーバーが検証するEntraアクセストークンを指定します。
- `CHAT_ENABLED=true`、`JOBS_ENABLED=true`、GitHub OAuth AppのClient IDとトークン暗号鍵が必要です。APIとワーカーの両方に同じ設定を渡してください。
- 015を含む全未適用DBマイグレーションを、バックアップと移行承認の後に適用します。起動時には自動適用しません。
- `npm run jobs:worker` はビルド済みワーカーを起動します。開発時は `npm run dev:jobs` を使います。

チャットのモデル一覧と実行時検証では、利用者本人のGitHub接続だけを使います。実際のGitHub認証やCopilotモデル呼び出しは、この実装の検証では行っていません。

## 1. モデル一覧を明示的に取得する

`POST /api/projects/:id/chat/models` は、会話内容を送らずに本人のGitHub接続から利用可能なモデルを取得し、`200 OK` を返します。本文は厳密に `{"confirmed":true}` でなければなりません。取得結果はプロジェクト・接続に結び付けて300秒間保存します。

```bash
curl -X POST "$API/api/projects/$PROJECT_ID/chat/models" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"confirmed":true}'
```

応答例:

```json
{
  "models": [{ "id": "gpt-6.1-sol", "name": "Copilot Chat" }],
  "expiresAt": "2026-11-20T12:05:00.000Z"
}
```

モデル一覧の取得に失敗した場合、APIは代替データを返さず、サニタイズしたエラーを返します。アプリケーションはレスポンス全体をキャッシュせず、期限切れ後は利用者の明示的な操作で再取得してください。

## 2. 送信内容をプレビューする

`POST /api/projects/:id/chat/conversations/:cid/previews` は `{text,modelId}` を受け取り、`201 Created` を返します。本文は16,384バイトまで、`text` は空白のみ・NUL・不正なUTF-16を含まず、UTF-8で8,192バイトまでです。追加のキーは拒否します。

```bash
curl -X POST "$API/api/projects/$PROJECT_ID/chat/conversations/$CONVERSATION_ID/previews" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"質問を入力","modelId":"gpt-6.1-sol"}'
```

APIはプレビューID（`previewId`）を返します。このIDは300秒間有効です。応答にはモデルID、送信するJSONスナップショットとプロンプト、SHA-256、期限も含まれます。利用者に送信内容を表示してください。確認を得るまでは実行APIを呼び出さないでください。準備処理はプロバイダーを呼び出さず、ジョブも作成しません。

モデルが一覧にない場合や一覧の有効期限が切れた場合、プレビューの作成は `409` になります。送信スナップショットがUTF-8で262,144バイトを超える場合は `413` になり、履歴は自動で切り詰めません。

## 3. 確認済みプレビューを1回だけ実行する

`POST /api/projects/:id/chat/conversations/:cid/runs` は、同じプレビューを一度だけ消費してジョブを作成します。`Idempotency-Key` ヘッダーには既存形式の1〜128文字を指定します。本文には、プレビューから受け取った `previewId` と `snapshotHash` に加えて、`"confirmed":true` が必須です。

最終確認の前に、本人のGitHub接続でモデル一覧を再確認してから送信すること、切断や接続の変更があっても送信先が受理済みの要求は取り消せず、データの保持や課金が発生し得ることを利用者に伝えてください。

```bash
curl -X POST "$API/api/projects/$PROJECT_ID/chat/conversations/$CONVERSATION_ID/runs" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: request-001" \
  -d '{"previewId":"00000000-0000-4000-8000-000000000001","snapshotHash":"<previewの64桁小文字SHA-256>","confirmed":true}'
```

成功時は `202 Accepted` を返します。応答例:

```json
{
  "id": "00000000-0000-4000-8000-000000000002",
  "conversationId": "00000000-0000-4000-8000-000000000003",
  "state": "queued",
  "modelId": "gpt-6.1-sol",
  "answer": "",
  "failureCode": null,
  "createdAt": "2026-11-20T12:00:00.000Z",
  "updatedAt": "2026-11-20T12:00:00.000Z",
  "lastSequence": 0
}
```

初期状態は `queued` です。同じキー・プレビュー・ハッシュの再送は、期限切れや接続変更後も既存ジョブを返し、新たな送信を開始しません。同じキーを別のプレビューやハッシュに使った場合、消費済みのプレビューに別のキーを使った場合、またはプレビュー作成後に会話履歴が変わった場合は `409` になります。

ワーカーは送信直前にプロジェクト、ジョブの実行権限、接続世代を再確認します。その後、本人のGitHub接続でモデルを1回確認し、接続が変わっていない場合にだけ、確認済みモデルとスナップショットを1回送ります。モデル切替、再試行、入力の切り詰め、別アカウントへの切替は行いません。

応答の生成中もワーカーは5秒ごとに接続を再確認します。切断や接続の変更を検知した場合はSDKに中断を要求し、回答は保存しません。

## エラーと再試行

| HTTP | エラー | 対応 |
| --- | --- | --- |
| 400 | `INVALID_INPUT` | 本文・ヘッダーを修正して、利用者に再確認します。 |
| 404 | `NOT_FOUND` | プロジェクトまたは会話を確認します。 |
| 409 | `CONSENT_REQUIRED` | 新しいプレビューを取得し、内容を再確認します。 |
| 409 | `IDEMPOTENCY_CONFLICT` | 新しいキーを使う前に、既存ジョブの状態を確認します。 |
| 409 | `CHAT_BUSY` | 実行中のジョブが終了してから、新しいプレビューを作成します。 |
| 409 | `COPILOT_CONNECTION_REQUIRED` | GitHubを再接続してから、新しいプレビューを作成します。 |
| 413 | `BODY_TOO_LARGE` または `INVALID_INPUT` | 本文・会話履歴を小さくし、再度プレビューします。 |
| 503 | `CHAT_UNAVAILABLE` | 設定とワーカーの状態を確認します。自動再送はしません。 |

要求の処理結果が不明な場合は、同じ `Idempotency-Key` と本文で状態を確認してください。失敗やタイムアウト後に新しいキーで再送すると、意図しない追加要求につながる可能性があります。

## 対応範囲

添付やファイルIDは指定できません。ツール、Skills、MCP、カスタムエージェントも使えません。プロバイダーURL、資格情報、ロールなどの追加キーは拒否します。APIは公開応答とログにアクセストークンやSDK内部状態を含めません。ブラウザーのチャット画面は、モデル一覧の取得、送信内容のプレビューと個別確認、会話履歴、実行状態の表示、再接続後のイベント再生に対応します。

画面とAPIは、それぞれ合成データで検証しています。今回の結合検証では、破棄可能なデータベースと合成実行環境を使い、認証済み要求からワーカー、保存済みイベントまでを確認しました。ブラウザー検証では、外部接続を遮断した実ブラウザーと合成応答を使いました。送信結果が不明な場合も、同じ送信を回復し、切断後にイベントを再生できることを確認しました。どちらの検証も実プロバイダー通信や実資格情報を使いません。実プロバイダー利用と本番運用の有効化は未実施です。
