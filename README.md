# AIRA Nexus

組織内の研究者が、Microsoft Entra IDで認証し、自分の研究プロジェクトを管理するWebサービスです。
このREADMEでは、開発者・管理者向けにEntraアプリ登録、ローカル起動、検証方法を説明します。

更新: 2026-11-13。対象: 基盤①と基盤②のユーザー別接続・表示設定・プロジェクトファイル・永続ジョブ基盤。実Entraへのログインはユーザーから成功報告を受けています。ファイル保存とジョブは稼働環境では有効にしていません。実ジョブと本番配備は未提供です。

## 現在利用できる機能

- Entraの組織アカウントでサインイン・サインアウトする。
- 本人だけがアクセスできるプロジェクトを作成・一覧・選択・改名する。
- PostgreSQLに永続化し、同じバージョンへの競合した改名を拒否する。
- 左にプロジェクト管理、中央にAIチャット／ファイルビューア／Notebook、右にファイル探索領域を表示する。
- 左ペイン下部の設定から、利用者ごとにGitHubのデバイス認証・接続解除を行う。
- 設定で日本語／EnglishとLight／Darkを選び、同じEntraユーザーの設定を端末間で引き継ぐ。
- ファイル保存の有効化後、本人のプロジェクトにファイルをアップロードし、一覧・プレビュー・元データのダウンロードを行う。

中央にはAIチャット、Notebookの順に固定タブを置き、開いたファイルのタブを追加します。ファイルタブだけを閉じたり並べ替えたりできます。左右のペイン幅は境界のドラッグで変更できます。
チャットの同意付きAPIとワーカーは実装済みですが、チャット画面との連携は未提供です。Notebook編集、Python/R実行も未提供です。
React・TypeScript・Vite・Tailwind CSS・Radix版shadcn/ui・Lucideと、Hono・jose・MSAL Browserを使用しています。

### Manual project order (default off)

`PROJECT_ORDER_ENABLED` accepts only `true` or `false`; absent/false leaves order
storage unused and the existing Pinned/Recent ordering unchanged. Enable only
after separately approved application of migrations006 and009. Migration009 does
not depend on jobs005, management007, or text-size008; no live migration is performed here.

Authenticated `GET /api/project-order/capabilities` reports readiness; missing
enabled schema is a logged, sanitized500, not disabled/empty success.
`GET /api/project-order` returns `{version,pinned,recent}`.
`PATCH /api/project-order` accepts only `{group,projectId,beforeId}` and quoted
`If-Match: "version"`; `beforeId: null` appends. Stale/exhausted revisions return409,
missing preconditions428, invalid input400/413, and missing/inactive/foreign IDs404.
Order is owner-scoped, acknowledged only, and never changes project metadata or pins.
Dedicated mouse handles and labelled Move up/down controls move within a group.
Search, pending writes and order-read errors block reordering; reload retries.
Unranked members appear first; inactive and other-group ranks remain stored for
re-entry. Reload/focus and acknowledged local membership changes synchronize order;
there is no real-time push.

## 起動前に必要な環境

- Node.js 24、npm、Docker Composeを含むDocker環境。
- Microsoft Entraの単一テナントと、アプリ登録・APIアクセス許可・同意を設定できる権限。
- PostgreSQL 17。ローカル開発では同梱のComposeを利用できます。
- 1024px以上のデスクトップ画面。狭い画面では横スクロールを使用します。

自動DB試験はローカルDockerを必要とします。Linuxではランダムな空きポートを選び、ホストネットワーク上の127.0.0.1だけで試験用PostgreSQLを待ち受けます。実データや既存DBは使用せず、終了時に試験用コンテナを停止します。

## EntraにAPIとSPAを登録する

1. API用アプリを「この組織ディレクトリのみ」で登録し、テナントIDとアプリケーションIDを控えます。
2. APIアプリのマニフェストで `api.requestedAccessTokenVersion` を `2` に設定します。
3. APIの公開でアプリケーションID URIを `api://<APIのアプリケーションID>` とし、委任スコープ `access_as_user` を公開します。
4. SPA用アプリを同じテナントに登録し、SPAのアプリケーションIDを控えます。
5. SPAのプラットフォームに **シングルページアプリケーション** を追加し、開発用リダイレクトURI `http://localhost:5173/auth-redirect.html` を登録します。
6. SPAのAPIアクセス許可に、手順3の委任スコープを追加します。
7. 組織のポリシーに従い、管理者同意と利用者への割り当てを設定します。

本番では `PUBLIC_ORIGIN` と同じHTTPSオリジンの `/auth-redirect.html` をSPAのリダイレクトURIに追加します。ログインとログアウトのポップアップは、どちらもこの登録済みの空白ページへ戻ります。サインアウト後のメイン画面は `PUBLIC_ORIGIN` へ移動します。

ブラウザは公開クライアントです。client secretを作成・配置しないでください。IDトークン、Graph用アクセストークン、アプリ専用トークンではこのAPIを呼べません。APIはAPIアプリのIDをaudienceとして検証します。
単一テナント登録だけではゲストを除外できません。組織内利用者への制限は、エンタープライズアプリの割り当てやConditional Accessでも設定してください。

## 環境変数を設定する

```bash
cp .env.example .env
chmod 600 .env
```

`.env` を編集し、空欄と置換用の値を実環境に合わせて設定します。`.env` と参照用の `references/` はGit管理対象外です。

| 変数                  | 設定値・既定値                                                       |
| --------------------- | -------------------------------------------------------------------- |
| `ENTRA_TENANT_ID`     | 組織テナントのUUID。必須                                             |
| `ENTRA_API_CLIENT_ID` | APIアプリのUUID。必須                                                |
| `ENTRA_SPA_CLIENT_ID` | SPAアプリのUUID。必須                                                |
| `PUBLIC_ORIGIN`       | 開発時は `http://localhost:5173`。パス・資格情報・クエリーを含めない |
| `PORT`                | APIのポート。既定値 `3000`                                           |
| `BIND_HOST`           | 検証時は `127.0.0.1`。未指定は既存互換の `0.0.0.0` と警告            |
| `POSTGRES_PASSWORD`   | ローカルCompose用に生成したランダムなパスワード。既定値なし          |
| `DATABASE_URL`        | PostgreSQL接続URL。必須。パスワード部分はURLエンコードする           |

Composeと接続URLには同じDB名・ユーザー・パスワードを指定します。同梱のDB名は `aira_nexus`、ユーザーは `aira` です。
HTTPを許可するのはlocalhostとループバックだけです。APIは起動時に設定を検査し、不正な設定では起動しません。

## ユーザー別GitHub接続を有効にする

この設定は管理者向けです。Entraのアプリ登録とは別に、自分で管理するGitHub OAuth Appを登録します。各利用者は、そのアプリを通じて自分のGitHubアカウントを接続します。

1. GitHubの **Settings → Developer settings → OAuth Apps → New OAuth App** からアプリを登録します。開発用のHomepage URLとAuthorization callback URLには `http://localhost:5173` を指定します。device flowはこのcallback URLにリダイレクトしません。本番では運用オリジンのHTTPS URLを指定してください。
2. OAuth Appの設定で **Enable Device Flow** を有効にし、Client IDを控えます。client secretやGitHub CLI組み込みのClient IDは使用しません。
3. ローカルの安全な端末で次のコマンドを実行し、暗号鍵を生成します。出力をログ・チャット・リポジトリに残さないでください。

   ```bash
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
   ```

4. `.env.example` のコメントを参考に、`.env` に `GITHUB_OAUTH_CLIENT_ID` と `COPILOT_TOKEN_ENCRYPTION_KEY` を設定します。両方を省略するとGitHub接続だけが無効になります。片方だけ、空文字、不正な鍵では起動に失敗します。既存の暗号鍵は再生成せず、安全に保管してください。鍵を失うと保存済みの接続情報を復号できません。
5. マイグレーションとAPIが同じ `DATABASE_URL` を参照すること、DBのバックアップと移行承認があることを確認してから `npm run db:migrate` を実行します。接続情報用の `002_copilot_connections.sql` だけでなく、003・004・005を含む未適用のマイグレーションをすべて実行します。適用完了後に `npm run build` を実行し、管理しているAPIプロセスを新しい設定・ビルドで起動し直します。これらの操作は管理者が実施してください。
6. Entraでサインインし、左ペイン下部の **設定 → GitHub に接続** を選びます。表示されたコードを `https://github.com/login/device` に入力し、自分のアカウントで許可します。要求スコープは `read:user` です。

認証コードは最大15分で失効します。設定を閉じると画面からの確認は止まりますが、認証要求は本人に紐づいたままです。再度開くと確認を再開できます。キャンセル・接続解除は明示的に操作してください。

接続済みの表示はOAuth接続の状態であり、Copilotの契約・組織ポリシー・モデル利用資格を保証しません。モデル一覧の取得とチャット送信は、利用者の明示的な確認後にだけ行います。実際のGitHub認証やモデル呼び出しは未検証です。refresh tokenは保存せず、自動更新もしません。接続解除で削除するのはアプリ内の情報だけです。GitHub側の許可を取り消す場合は、GitHubの **Settings → Applications → Authorized OAuth Apps** で操作してください。DBバックアップやMVCCに残る過去データの物理削除は保証しません。

チャットAPIの使い方は [チャット同意フロー](docs/chat.md) を参照してください。設定仕様の正本は [ユーザー別接続の要件](.sdd/specs/copilot-connection.md)、GitHub側の説明は [device flowの公式資料](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow) を参照してください。

## 言語と画面モードを設定する

管理者はバックアップ、接続先と移行承認を確認し、`npm run db:migrate` で `003_user_preferences.sql` を適用してください。コマンドは004・005を含む未適用のマイグレーションを番号順にすべて実行します。API起動時には自動実行しません。

サインイン後、左ペインの **設定** で **言語** と **画面モード** を選びます。初期値は日本語・Lightで、サーバーから保存完了の応答を受けた後に画面へ反映します。設定はEntraのテナント・オブジェクトIDごとに保存され、別端末で開いた際にも取得します。プロジェクト名など、ユーザーが入力した内容は翻訳しません。

読み込みや保存に失敗した場合はエラーを表示します。読み込み失敗時は再読み込みまで編集できず、保存失敗時は直前の表示を維持します。サインアウト・ユーザー切替では日本語・Lightへ戻します。他のタブでの変更は自動配信せず、画面を開き直すと取得します。

GitHub認証ボタンは常に表示します。管理者がGitHub接続を設定していない場合は、理由を表示してボタンを無効にします。言語・画面モードの保存とは独立しています。正本は [ユーザー表示設定の要件](.sdd/specs/user-preferences.md) を参照してください。

### Text size (disabled by default)

Text size uses separate authenticated `GET/PATCH /api/settings/text-size` requests with the strict DTO `{size:"large"|"medium"|"small"}`. Existing language/theme DTOs are unchanged. An operator must approve and apply `008_user_text_preferences.sql` before setting `TEXT_SIZE_ENABLED=true`; the migration command applies all pending migrations, not just 008. This feature does not run migrations at startup. An absent flag or `false` disables storage access and returns `503/TEXT_SIZE_UNAVAILABLE`; any other value except `true` is invalid.

The settings dialog offers Large (current typography), Medium (90%) and Small (80%). Only server-acknowledged values apply, scoped to the verified Entra tenant/object. Font sizes change without scaling root rem units, pane widths, spacing or image/SVG/PDF zoom. Failed reads disable only text-size editing and offer retry; failed writes retain the last acknowledgement. An unsaved large baseline is explicitly labeled, and account/session changes reset it before paint. Browser storage is not used. Missing schema/storage errors return sanitized failures, never successful defaults. Deployment, live migration and full combined-feature qualification remain operator/integration work; see the [approved preferences specification](.sdd/specs/user-preferences.md).

## プロジェクトのファイル保存を有効にする

この節は管理者向けです。ファイル機能の正本は [research-services](.sdd/specs/research-services.md) です。実装の承認は、稼働DBの移行、秘密情報の設定、サービス起動の承認とは別です。既存環境では、対象ファイルのパス・ハッシュ、バックアップと残るリスクを確認し、承認を得てから作業してください。

保存設定をすべて省略するとファイルAPIは503を返します。ログインとプロジェクト管理は引き続き利用でき、ファイルAPIは未適用の004のテーブルを参照しません。`.env.example` のファイル保存項目はコメントのままです。

| 変数                               | 設定                                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `FILE_STORAGE_MODE`                | 開発は `azurite`、Azureは `azure`。未設定なら他のファイル保存変数もすべて省略                         |
| `AZURE_STORAGE_CONTAINER`          | 両モードで使用。既定値 `aira-nexus`。非公開コンテナに限定                                             |
| `AZURITE_BLOB_ENDPOINT`            | 開発用。例: `http://127.0.0.1:10000/airanexus`。数値ループバックとアカウント名のパスが必須            |
| `AZURITE_ACCOUNT_NAME`             | 開発用。ComposeとAPIで同じ名前を指定                                                                  |
| `AZURITE_ACCOUNT_KEY`              | 開発用。64バイトの乱数を正規のBase64で表した秘密鍵。ComposeとAPIで同じ鍵を指定し、ログやGitに残さない |
| `AZURE_STORAGE_ACCOUNT_URL`        | Azure用。HTTPSのBlobアカウントURL。公開Azure、Azure Government、Azure Chinaの標準ホストに対応         |
| `AZURE_MANAGED_IDENTITY_CLIENT_ID` | Azure用。ユーザー割り当てマネージドIDのUUID。省略するとシステム割り当てIDを使用                       |

AzureではマネージドIDに対象ストレージの `Storage Blob Data Contributor` など必要な権限を付与します。共有鍵やSASは使用しません。`azure` モードでは `AZURITE_` の3変数を削除してください。空文字で残しても起動を拒否します。コンテナの公開アクセスが設定されている場合は保存・取得を拒否します。

開発用Azuriteを使う場合は、先に同じアカウント名と秘密鍵を安全に設定し、次のコマンドでBlobサービスだけを起動します。

```bash
docker compose --profile files up -d blob
```

このサービスは `127.0.0.1:10000` だけに公開し、データは名前付きボリューム `blob_data` に保持します。設定後、DBの接続先・バックアップ・移行承認を確認して `npm run db:migrate` を実行します。未適用の001〜005を番号順にすべて適用し、`004_project_files.sql` がファイル管理テーブルを作成します。ファイル・ジョブ設定が無効でも、この手動コマンドは004・005を適用します。最後に `npm run build` を実行し、管理対象のAPIを新しい設定で起動し直してください。**この手順は稼働環境では未実施です。**
004の適用前にファイル保存を有効にしてAPIを起動すると、ファイルAPIは失敗します。必ず移行を完了してから、新しい設定でAPIを起動してください。

## ファイルを開く・保存する

プロジェクトを選び、右のファイル探索領域からアップロードします。同名でも別ファイルとして保存します。一覧から開くと中央にタブが増え、タブの×で閉じられます。ファイルタブの並べ替えはドラッグ、またはフォーカスしたタブで `Alt+Shift+左右矢印` を使います。

1ファイルは100,000,000バイト、1プロジェクトは予約分を含め10,000,000,000バイトまでです。1プロセスで同時に受け付けるアップロードは4件です。中断時は保存済みか判断できないことがあるため、再送前に一覧を確認してください。

| 表示形式         | 対象と上限                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| テキスト         | txt／csv／json／py／r。UTF-8、1,000,000バイトまで。HTMLやコードは実行しない                                                |
| Markdown         | md / markdown: UTF-8, 1,000,000 bytes; read-only Markdown/GFM, local TeX, isolated Mermaid, same-project PNG/SVG           |
| PNG              | 10,000,000バイト、16,000,000画素まで                                                                                       |
| SVG              | 1,000,000バイト、16,000,000画素まで。スクリプト・外部参照・CSS importなどを拒否。寸法単位は単位なし／pxのみ                |
| PDF              | 25,000,000バイト、200ページ、1ページの描画領域16,000,000画素まで。専用Workerとcanvasで表示し、文書内アクションは実行しない |
| ダウンロードのみ | docx／pptx／xlsx／jpg／jpeg。上記形式でもプレビュー条件を満たさない場合は理由を表示                                        |

元データのダウンロードでも、受信全体のサイズとSHA-256を検証します。破損・過剰・中断したデータはプレビューや保存に渡しません。フォルダー、ファイルの改名・削除・共有、内容抽出、AIへの送信は未実装です。

### Rich Markdown integration (private implementation)

The approved contract is [REQ-MDV-001..005](.sdd/specs/research-services.md).
Image references must be unique relative basenames such as `![plot](./plot.png)` in
the same owned project. All metadata pages are resolved before selection; original
size/SHA checks and image byte/pixel/XML checks remain mandatory. HTML is escaped,
links are inert, code is not executed, and no external content loads automatically.
Rendering errors remain local to the affected expression, diagram or image.

`npm run build` packages KaTeX fonts as same-origin files (never inline data fonts)
and builds a classic Mermaid bundle at `/markdown-assets/renderer.js`.
Serve `/markdown-renderer.html` and that public bundle using the production routes.
The anonymous bundle request uses CORS only for this exact public script; no API
or credential access is granted. The helper is an offscreen, noninteractive,
credentialless opaque sandbox without `allow-same-origin`.

Only the approved exact `${PUBLIC_ORIGIN}/markdown-renderer.html` source is added
to the parent's `frame-src`; all other parent CSP directives, including Entra's
frame source, remain unchanged. The helper response **replaces** that policy with
the confined policy in the approved specification. Do not add a second CSP,
allow general same-origin frames, or relax the parent script/style/image rules.
No live configuration or service restart is implied by these source changes.

Budgets: 10,000 parsed / 50,000 rendered nodes; 100 TeX expressions of 4,096 code
points (`maxExpand=1000`, `maxSize=10`); 8 Mermaid blocks of 8,192 code points /
200 edges with a 10-second deadline and 1 MB / 16 MP outputs; 32 distinct local
images / 20 MB compressed input; 32 MP total for local images and diagrams.
Metadata pagination also stops at 1,000 pages / 100,000 entries or repeated cursors.
Closing/deactivating or changing scope aborts requests, disposes frames/channels,
and discards stale results. Locale/theme/name-only updates retain verified content.
These are defensive UI limits, not adversarial CPU/process-isolation certification.

## 永続ジョブ基盤の実装範囲と運用前提

正本は [research-services](.sdd/specs/research-services.md) の `REQ-SVC-003` と `REQ-SVC-010`〜`REQ-SVC-014` です。PostgreSQLにジョブを保存し、APIとは別のワーカープロセスが処理します。ジョブUI、Docling、Notebook、Python/Rの実処理はありません。チャットワーカーは `CHAT_ENABLED=true` の場合だけ登録されます。画面連携と実プロバイダー呼び出しは未検証です。

`JOBS_ENABLED` は未設定または `false` なら無効です。所有プロジェクトのジョブAPIは503を返し、未適用の005のテーブルを参照しません。認証とプロジェクト所有者の確認は無効時も行います。明示的な設定は `true` または `false` だけを受け付けます。公開クライアント設定は変更しません。

登録APIは `POST /api/projects/:id/jobs` です。サーバー登録済みの `type` と検証済みの `input`、`Idempotency-Key` が必要です。同じ利用者・プロジェクト・キー・入力の再送は同じジョブを返し、入力が異なると409です。一覧・詳細はGET、キャンセルは `POST /api/projects/:id/jobs/:jobId/cancel` を使います。入力や実行権限のトークンは応答に含めません。

実行上限は全体2件・利用者1件・プロジェクト1件、未完了の受付上限は全体200件・利用者20件です。上限はワーカー間で共有します。待機中のキャンセルは即時に確定します。実行中は `cancel_requested` とし、処理の終了を確認してから `cancelled` にします。停止確認の期限は要求から30秒で、繰り返し要求しても延長しません。

実行権限のリースは30秒で、ワーカーは5秒ごとに更新します。リースや停止確認期限が切れたジョブは失敗となり、自動で再実行しません。再起動後も待機ジョブは残りますが、古いワーカーの完了報告は拒否します。この仕組みは処理の物理停止や外部副作用の取り消し、厳密な一度限りの実行を保証しません。

運用を始めるには、バックアップと移行承認を確認してから、005・015を含む全未適用移行を適用し、必要な環境変数を設定します。実際のCopilot利用を有効にする前に、プロバイダー通信と秘密情報の取り扱いを運用者が承認してください。`npm run jobs:worker` はビルド済み、`npm run dev:jobs` は開発用の起動コマンドです。どちらもジョブが無効、または有効機能のハンドラーが未登録ならDB接続前に失敗します。この開発作業では起動しません。

## ローカルでプロジェクトを作成する

依存パッケージを復元します。

```bash
npm ci
```

DBを起動します。

```bash
docker compose up -d --wait db
```

バックアップ、接続先と移行承認を確認して、未適用の001〜005をすべて実行します。ファイル・ジョブの有効化設定とは無関係に全未適用分を適用するため、既存環境で無断実行しないでください。API起動時には自動実行しません。

```bash
npm run db:migrate
```

開発サーバーを起動します。

```bash
npm run dev
```

`http://localhost:5173` を開き、Entraでサインインしてから、左ペインでプロジェクトを作成します。
開発時のAPI接続先は `127.0.0.1:3000` に固定されています。`PORT` を変更する場合は `vite.config.ts` のプロキシも合わせて変更してください。
開発用ポートを組織外に公開しないでください。

DBを停止しても名前付きボリュームは保持されます。

```bash
docker compose stop db
```

## ビルド済みの画面とAPIを同一オリジンで配信する

```bash
npm run build
npm start
```

`PUBLIC_ORIGIN` を実際にブラウザが開くオリジンに合わせてから起動します。ローカルでAPIから直接配信する場合は `http://localhost:3000` とし、その `/auth-redirect.html` もEntraに登録してください。
本番はTLS終端を行うリバースプロキシの背後で配信します。APIの `BIND_HOST` が未指定の場合は `0.0.0.0:PORT` で待ち受けるため、ネットワーク側でアクセス元を制限してください。
TLS・秘密管理・DB権限・バックアップ・監視は運用側で構成する必要があります。Kubernetes用マニフェストは段階⑥の対象です。

## WindowsからSSH経由でリモート検証する

Linux上のDocker nginxとホストNode.jsを使う確認方法は、[SSHトンネルの手順](docs/ssh-tunnel-verification.md) を参照してください。
Windowsの `http://localhost:5173` からSSH経由でLinuxの `127.0.0.1:18080` に接続し、APIは `BIND_HOST=127.0.0.1` とします。
`npm run proxy:up` は上流のループバック待受を検査してnginxだけを起動し、`npm run proxy:stop` もnginxだけを停止します。DBやSSH設定は変更しません。
この経路はリモートIPへのHTTP公開や本番用TLS設定ではありません。実際のWindows SSH接続とEntra SSOは手動での確認が必要です。

## 検証コマンドと確認範囲

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
node .github/skills/lean-sdd-tdd/scripts/sdd.mjs gate
```

50件の自動試験で、署名JWT、実PostgreSQLの所有者分離・永続化・改名競合・入力制限を確認します。
GitHub接続は合成応答を使い、状態遷移、ポーリング制限、並行処理、失効、暗号化、設定画面の応答破棄を確認します。チャット同意フローは合成SDKと使い捨てPostgreSQLで確認し、実際のGitHub認証やモデル呼び出しは行いません。
UI操作、セッション切替、Bearer／If-Match送信、ログアウト先、認証失効後の再表示防止も確認します。
表示設定は並行した部分更新、全ペインの英語表示、テーマ切替、読み込み・保存失敗と旧ユーザーの応答破棄を確認します。
ファイルは使い捨てのPostgreSQL・Azuriteで所有者分離、予約・期限・失敗遷移、元データの整合性を確認します。表示側は危険なSVG、サイズ・画素・ページ上限、PDFの期限とWorker解放を検査します。
SSHプロキシの試験は、実nginxとNode.jsの待受・認証転送・実行時制約・ヘルスチェックと、起動ガードのポリシーを検査します。
ジョブは使い捨てのPostgreSQLと検証専用ハンドラーで、全42状態・イベント組合せ、重複登録、同時実行、期限、キャンセル、再起動後の復旧を確認します。実ジョブの性能や副作用の安全性は未検証です。
範囲を限定した変異試験では、スコープ検査・所有者条件・バージョン比較・本文サイズ制限・旧セッション応答の保護を個別に外し、回帰試験が失敗することを確認してから元に戻しています。
結果と環境上の制約は [実験ノート](docs/lab-notebook.md) に記録します。テストの認証代替は試験コード内だけにあり、本番の認証バイパスはありません。

`/health/live` はプロセスの応答、`/health/ready` はDB接続を検査します。`/api/config` は公開クライアント設定のみを返します。それ以外のAPIには認証が必要です。
改名のAPIを直接呼ぶ場合は、取得した `version` を引用符付きの `If-Match: "1"` として送信します。競合時は409です。詳細は [正本の要件](.sdd/specs/projects.md) を参照してください。

## 未検証事項と後続段階

実Entraへの対話ログインはユーザー確認済みです。トークン更新・サインアウト、実GitHub認証、AzureのマネージドIDによるファイル操作、日本語PDFの実表示、Azure／オンプレミス配備、300人登録・50人同時利用・10GB/プロジェクトの負荷は未検証です。ローカルのJWT・DB・UI試験は、これらの成功を示しません。

`npm audit --omit=dev` は実行時依存の脆弱性0件でした。開発用Testcontainersの依存経路にはmoderateの指摘が残っています。破壊的なダウングレードによる自動修正は行っていません。
本番ビルドには500kBを超えるJSチャンクの警告があります。現時点で性能達成は主張しません。
プロジェクトの共有・削除、モバイル最適化も未提供です。

| 段階 | 対象                                     | 状態                                                                                    |
| ---- | ---------------------------------------- | --------------------------------------------------------------------------------------- |
| ①    | 認証・個人プロジェクト・3ペインUI        | 今回の実装・検証対象                                                                    |
| ②    | 接続設定・ファイル・チャット・キュー     | 接続設定・ファイル・永続ジョブ基盤・チャット同意APIを実装。運用有効化と画面連携は未実施 |
| ③    | 隔離Python/R・Notebook                   | 未実装                                                                                  |
| ④    | Skills/MCP・エージェント・Mastra採用判断 | 未実装                                                                                  |
| ⑤    | 文献・RAG・成果物追跡                    | 未実装                                                                                  |
| ⑥    | AKS／オンプレミスKubernetes・負荷・運用  | 未実装                                                                                  |

分析・設計は [要件案内](docs/requirements.md)、[アーキテクチャ](docs/architecture.md)、[承認済み実行プロンプト](docs/prompts/phase-1.md) を参照してください。
実装タスクと検証記録の正本は [.sdd/implementation-plan.json](.sdd/implementation-plan.json) です。

## 開発への参加とライセンス

要件変更は `.sdd/specs/` を起点とし、対応する試験と実装計画を更新してください。参照リポジトリのコードを無条件に転載せず、各ライセンスと出典を確認してください。
このリポジトリのライセンスは [LICENSE](LICENSE) を参照してください。
