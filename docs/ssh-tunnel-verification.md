# SSHトンネル経由でリモートのAIRA Nexusを確認する

Windowsのブラウザーから、Linux上のDocker nginxとホストNode.jsへSSHトンネルで接続する開発用手順です。
開発者・管理者が、リモートIPへのHTTP公開を避けて実Entra SSOを確認できる状態にします。

更新: 2026-11-12。対象: Linux上のDocker Engine、Node.js 24、Windows OpenSSH。
要件の正本は [remote-proxy](../.sdd/specs/remote-proxy.md) です。Windowsからの実SSH接続と実Entra SSOは未実施です。

## 1. 接続経路と確認前の条件

ブラウザーのURLは、LinuxのIPではなく `http://localhost:5173` にします。SSHがWindowsとLinuxの間を暗号化します。
この手順は開発時の確認用であり、リモートIPへのHTTP接続や本番用HTTPSプロキシを提供しません。

```text
Windows browser: http://localhost:5173
  -> Windows SSH: 127.0.0.1:5173
  -> encrypted SSH connection to Linux IP
  -> Docker nginx: Linux 127.0.0.1:18080
  -> host Node.js: Linux 127.0.0.1:3000
```

Linuxのシェル、Windows PowerShell、Entraのアプリ登録を操作できることを前提とします。
開始前に次を確認してください。

- Linuxの既存SSHへログインでき、TCP転送が管理者に許可されている。
- SSH接続先のホスト鍵を、管理者から得たフィンガープリントと照合できる。
- LinuxでNode.js 24、npm、Docker Composeを利用できる。DockerはLinuxホストネットワークを使用する。
- Windowsで `ssh -V` を実行でき、Windows側の `127.0.0.1:5173` が空いている。
- Linux側の `127.0.0.1:18080` が空いている。ポート3000のアプリを変更する権限がある。
- [SSO確認手順](entra-sso-verification.md) の3節までの登録と、DB・依存パッケージの準備が済んでいる。

SSHデーモン、ファイアウォール、既存DBの設定は変更しません。既存の検証DBと、管理者が設定した `.env` を使用します。
新規環境のDB準備は [README](../README.md) に従ってください。既存 `.env` をサンプルで上書きしないでください。

## 2. Linuxのアプリ設定と起動

Linuxではリポジトリのルートで操作します。この経路はViteではなく、ビルド済み画面をNode.jsから配信します。

1. アプリ側の設定を確認します。Entra IDと `DATABASE_URL` は既存の値を使用し、画面やログへ出力しません。

   | 設定               | この手順での値                             |
   | ------------------ | ------------------------------------------ |
   | `BIND_HOST`        | `127.0.0.1`                                |
   | `PORT`             | `3000`                                     |
   | `PUBLIC_ORIGIN`    | `http://localhost:5173`                    |
   | SPAリダイレクトURI | `http://localhost:5173/auth-redirect.html` |

2. 現在の待受アドレスを確認します。

   ```bash
   ss -H -ltn 'sport = :3000'
   ```

   この手順の `ss` がない環境では `netstat -lnt` を使い、該当ポートの行を確認します。
   `0.0.0.0:3000`、IPv6、または複数の待受があれば、その起動元と管理者を確認します。
   **アプリの所有者が元のターミナル等から停止し、次の設定で起動し直してください。** 他のプロセスを一括停止しません。
   すでに目的のアプリがループバックだけで起動している場合は、設定とビルドが一致していることを確認し、重複起動を避けます。

3. 画面とAPIをビルドします。

   ```bash
   npm run build
   ```

4. LinuxのターミナルAでアプリを起動します。次の公開設定はプロセスにだけ適用され、`.env` は変更しません。

   ```bash
   BIND_HOST=127.0.0.1 PORT=3000 PUBLIC_ORIGIN=http://localhost:5173 npm start
   ```

   起動メッセージを確認し、このターミナルを開いたままにします。
   `BIND_HOST` を省略すると既存互換の `0.0.0.0` 待受になり、警告が出ます。この経路では省略しません。
   明示的に指定できる値は `127.0.0.1` だけで、空文字や `localhost` では起動に失敗します。

## 3. Docker nginxの起動と確認

Linuxの別ターミナルBを開き、同じリポジトリのルートで実行します。

1. 上流アプリの待受を検査します。

   ```bash
   sh scripts/check-loopback.sh 3000
   ```

   成功時は出力なしで終了コード0になります。未起動、IPv6、公開アドレス、検査ツールの失敗は拒否します。
   ホストでは `ss`、利用できない場合は `netstat` を使い、全アドレスファミリーを検査します。`awk` も必要です。

2. nginxだけを起動します。

   ```bash
   npm run proxy:up
   ```

   専用の `aira-nexus-proxy` プロジェクトを使用し、DB用Composeは起動・停止しません。
   起動ガードが失敗した場合は、Composeを直接実行して回避せず、2節のアプリ設定を直してください。

3. nginxの状態を確認します。

   ```bash
   docker compose -p aira-nexus-proxy -f compose.proxy.yml ps
   ss -H -ltn 'sport = :18080'
   ```

   nginxが `healthy` で、待受が `127.0.0.1:18080` だけであることを確認します。
   イメージはdigestで固定され、非root・読み取り専用・全capability削除で動きます。設定も読み取り専用です。
   書き込み用の一時領域は各16MiBのtmpfsに限定しています。

4. アプリまでの疎通を確認します。

   ```bash
   curl --noproxy '*' -fsS http://127.0.0.1:18080/health/live
   curl --noproxy '*' -sS -D - -o /dev/null http://127.0.0.1:18080/api/me
   curl --noproxy '*' -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18080/
   curl --noproxy '*' -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18080/auth-redirect.html
   ```

   `/health/live` は200、トークンなしの `/api/me` は401と `WWW-Authenticate: Bearer` を返します。
   画面とリダイレクトページは200になります。401は認証が有効であることの確認で、エラーとして回避しません。
   CSPと `Cache-Control: no-store` があることも確認します。
   `Cross-Origin-Opener-Policy`（COOP）は通常の画面・APIでは `same-origin-allow-popups` です。
   例外は `/auth-redirect.html` のGET/HEADが200を返す場合だけで、その応答は `unsafe-none` になります。クエリーの有無には依存しません。
   この空白ページだけ隔離を緩め、MSALが認証後のポップアップを読み取れるようにします。ブラウザーの同一オリジン制約やAPIのJWT検証は変更しません。
   次のコマンドでコールバックのヘッダーも確認できます。`unsafe-none` がなければ、[SSO手順の切り分け](entra-sso-verification.md#8-エラーを切り分ける)を参照してください。

   ```bash
   curl --noproxy '*' -fsS -I http://127.0.0.1:18080/auth-redirect.html
   ```

ヘルスチェックは上流の待受制約とHTTP応答を検査し、DBの正常性やSSOの成功は保証しません。
検査はその時点の状態です。後からアプリが公開アドレスへ切り替わると `unhealthy` になりますが、アプリや既存nginxを自動停止する仕組みではありません。
起動コマンドが失敗した場合もコンテナが残ることがあるため、6節の停止コマンドで終了してください。

## 4. WindowsからSSHトンネルを開く

Windows PowerShellで実行します。Linux内のViteが5173を使っていても、Windows側の5173が空いていれば競合しません。
Windows上の既存サービスが5173を使っている場合は、所有者を確認してから停止するか、別途構成を見直してください。
ポートだけを変えると `PUBLIC_ORIGIN` とEntra登録も関係するため、この手順では自動で変更しません。

1. LinuxのIPとSSHユーザー名を入力します。

   ```powershell
   $ServerIp = Read-Host "Linux server IP"
   $SshUser = Read-Host "SSH user"
   ```

2. ローカル転送を開きます。

   ```powershell
   ssh -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 127.0.0.1:5173:127.0.0.1:18080 "$SshUser@$ServerIp"
   ```

   初回はホスト鍵を正規のフィンガープリントと照合してから承認します。不一致なら中断し、確認を省略するオプションは追加しません。
   認証後に画面が待機状態になるのは正常です。このPowerShellを開いたままにします。
   LinuxのIPはSSH接続先にだけ使用し、ブラウザーのURLやEntraのHTTPリダイレクトURIには使用しません。

3. 別のPowerShellで、トンネル越しのHTTP疎通を確認します。

   ```powershell
   curl.exe --noproxy "*" -sS -o NUL -w "%{http_code}\n" http://localhost:5173/health/live
   ```

   200ならブラウザーの確認へ進みます。SSH接続だけでは転送先の応答は保証されないため、この確認を省略しません。

## 5. ブラウザーとEntra SSOの確認

1. Windowsのブラウザーで `http://localhost:5173` を開きます。`127.0.0.1` やLinuxのIPに置き換えません。
2. EntraのSPA登録に `http://localhost:5173/auth-redirect.html` があることを確認します。
3. [SSO確認手順](entra-sso-verification.md) の5節以降を実施します。4節のローカル起動手順は、この手順の2〜4節に置き換えます。

ログイン、認証付きAPI、プロジェクト作成、別ユーザーとの分離、ログアウトを実際に確認して記録します。
Linuxのcurlや自動試験だけでは「実Entra SSO確認済み」としません。localhostのリダイレクトURIはポートだけ違う値を重複登録せず、SSO手順の3.2に従います。

証跡は実施日時、確認項目、HTTPステータス、合否だけに限定します。
パスワード、認可コード、JWT、Authorization、Cookie、DB接続URL、利用者の個人情報を保存・共有しないでください。

## 6. エラーの切り分けと安全な終了

| 症状                                           | 主な原因                                           | 対応                                                              |
| ---------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| 起動ガードが拒否する                           | アプリ未起動、公開・IPv6・混在待受、検査ツール失敗 | 2節のアプリ設定と3節の待受検査を確認する。ガードを無効化しない    |
| ポート18080を使用できない                      | Linux側の既存サービスと競合                        | `ss` で確認し、所有者に確認する。無断で停止しない                 |
| `Address already in use` / 転送失敗            | Windows側5173を使用中                              | 既存のSSHトンネルやローカル開発サーバーを確認する                 |
| `administratively prohibited`                  | SSH側で転送が許可されていない                      | 管理者に転送可否を確認する。この作業でSSH設定を変更しない         |
| 502 / `unhealthy`                              | Node.js停止、待受変更、上流HTTP応答の失敗          | Linux側のアプリを確認する。状態検査だけでは自動停止されない       |
| `/health/live` は200だがプロジェクト操作に失敗 | DBや認可の問題                                     | SSO手順の疎通・DB・ユーザー権限の確認へ進む                       |
| リダイレクトURI不一致                          | ブラウザーURL、`PUBLIC_ORIGIN`、SPA登録の不一致    | 3つをlocalhost:5173の構成にそろえる。Implicit grantは有効化しない |
| SSH終了後にアクセスできない                    | トンネルを閉じた                                   | 4節のSSHコマンドで再接続する                                      |

終了時は、LinuxのターミナルBでnginxだけを停止します。

```bash
npm run proxy:stop
```

次に、WindowsのSSH用PowerShellで `Ctrl+C` を押してトンネルを閉じます。
必要なら、自分で起動したNode.jsのターミナルAでも `Ctrl+C` を押します。既存DB・SSHサーバー・他ユーザーのサービスは停止しません。
