# Notebook の隔離クラスタ検証

この手順は、Kubernetes と kind を操作できる開発者が、使い捨てクラスタで Notebook の隔離とライフサイクルを検証するためのものです。本番環境への導入手順ではありません。

更新: 2026-11-25。実装契約は [Notebook 仕様](../.sdd/specs/notebook-runtime.md) を参照してください。

## 実行前に用意するもの

- 専用の単一ノード kind クラスタ。API の接続先は loopback、context 名は `kind-` で始めます。ノードには `aira.nexus/purpose=notebook-qualification` と `aira.nexus/owner` ラベルが必要です。
- `kata` handler を持つ `RuntimeClass` と、NetworkPolicy を実際に適用する CNI。`k8s/notebook/kernels.yaml` は RuntimeClass の定義であり、Kata 自体をインストールしません。
- Linux ホストに `kind`、`kubectl`、Node.js 24 を用意します。対象クラスタだけを参照する絶対パスの kubeconfig と、設定済みのクラスタ管理権限も必要です。
- 現在のソースから作成した API イメージと、`Dockerfile` の `notebook-kernel` stage から作成した kernel イメージ。どちらも専用ノードから利用できるようにし、kernel イメージは `@sha256:` 付きの参照を指定します。
- `k8s/notebook/api-worker.yaml` の pinned Azurite と `test-postgres.yaml` の pinned PostgreSQL イメージ。manifest は linux/amd64 用です。
- ホストの利用可能メモリ 20 GiB 以上。試験中に利用可能メモリが 20 GiB 未満、swap 使用量の増加が 512 MiB 超、または 1 分平均 load が 18 超になると、試験を中断します。8 台の VM の同時負荷を考慮し、load の閾値を 12 コアの 1.5 倍に設定しています。

`aira-notebook-qualification` namespace、同名の ClusterRole と ClusterRoleBinding が既に存在する場合、試験は上書きせず失敗します。既存のクラスタや他者のリソースを転用しないでください。

この手順は、クラスタ、Kata、CNI、イメージを準備済みの開発者を対象とします。準備そのものや、ローカルイメージの digest 解決は対象外です。script の context 名、接続先、ラベルの確認だけでは、クラスタが本当に使い捨てかどうかは証明できません。実行者が `kind get clusters` と kubeconfig の接続先を照合し、対象の単一ノードと所有者を確認してください。

## 使い捨てクラスタで試験する

1. リポジトリのルートで、対象クラスタ専用の kubeconfig と context を環境変数 `KUBECONFIG`、`NOTEBOOK_VERIFY_CONTEXT` に設定します。`KUBECONFIG` は単一ファイルの絶対パスを指定します。
2. ノードに読み込んだ API イメージ参照を `NOTEBOOK_VERIFY_API_IMAGE`、kernel の digest 参照を `NOTEBOOK_VERIFY_KERNEL_IMAGE` に設定します。
3. 明示的な使い捨てクラスタ指定を有効にして試験します。

   ```bash
   export NOTEBOOK_VERIFY_DISPOSABLE=true
   node scripts/verify-notebook-cluster.mjs
   ```

成功すると、HTTP 認可、Python/R の分離、読み取り専用 staging、Azurite artifact の各 `PASS` が表示されます。CPU/メモリ制限、120 秒 timeout、8 個の Kata kernel Pod と 9 台目の拒否、idle と trash/restore の結果も PASS と表示されます。Pod の数は QEMU プロセス数の個別確認ではありません。最後の `PASS qualification resources removed` は、試験が作成した namespace、ClusterRole、ClusterRoleBinding の撤収を示します。

試験は専用 namespace に一時 PostgreSQL と loopback 専用 Azurite を起動します。DB と blob の認証情報は試験ごとに生成し、namespace の削除時に破棄します。実際の Azure アカウントや本番 DB は使用しません。

## 検証範囲と失敗時の対応

kernel はプロジェクトごとの namespace に作成されます。実装が NetworkPolicy を生成し、正しい gateway 接続の成功、別 pod・別 namespace・kernel egress の拒否を確認してから起動します。`network-policy.yaml` は専用 gateway 名に対応するポリシー例であり、既存 namespace へ適用しないでください。

CPU とメモリは cgroup の 1 コア・2 GiB 設定と、CPU 実負荷および 512 MiB のメモリ確保を確認します。試験スクリプトだけでは、2 GiB を超える確保の挙動や、本番 CNI・本番 runtime の同等性は証明できません。

| 状況                     | 確認と対応                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 起動前に拒否された       | kubeconfig、context、ノードラベル、image 参照、既存リソースとホスト余力を確認します。別のクラスタで試すために安全確認を迂回しないでください。                                |
| Pod が Ready にならない  | 専用クラスタの Pod 状態とイベントを確認します。Kata handler、CNI、image digest、registry へのアクセスを調べます。                                                            |
| 試験または撤収が失敗した | 出力の失敗箇所を記録し、試験用 namespace と `aira-qual-` で始まる namespace の所有ラベルを確認します。所有者が特定できないリソースは削除せず、クラスタ管理者に引き継ぎます。 |

強制終了やホスト停止時は自動撤収を保証できません。正常終了後も専用クラスタ自体は残るため、作成者がクラスタと専用 image の撤収を別途確認してください。

試験開始時の `Qualification deployment` と `Created ... uid=...` の出力を保存してください。中断後は、専用 kubeconfig と context を明示して残存リソースを確認します。次の `DEPLOYMENT_ID` には、その試験の出力に記録された ID を設定します。

```bash
kubectl --kubeconfig "$KUBECONFIG" --context "$NOTEBOOK_VERIFY_CONTEXT" -n aira-notebook-qualification get configmap notebook-qualification -o jsonpath='{.data.deployment-id}'
kubectl --kubeconfig "$KUBECONFIG" --context "$NOTEBOOK_VERIFY_CONTEXT" get namespaces -l "aira.nexus/component=notebook-project,aira.nexus/deployment=$DEPLOYMENT_ID" --show-labels
kubectl --kubeconfig "$KUBECONFIG" --context "$NOTEBOOK_VERIFY_CONTEXT" get namespace/aira-notebook-qualification clusterrole/notebook-qualification clusterrolebinding/notebook-qualification -o yaml --ignore-not-found
```

出力を失った場合、固定 namespace の ConfigMap が残っていれば最初のコマンドで ID を確認できます。すでに ConfigMap が削除されている場合は、ID を推測せず管理者へ引き継いでください。

動的 namespace は出力された deployment ID と `aira.nexus/component=notebook-project` を照合します。UID は記録されません。固定 namespace と ClusterRole、ClusterRoleBinding は、ログに出た UID を照合します。名前やラベルだけで所有者を断定せず、試験の出力と照合できない場合は削除せずにクラスタ管理者へ引き継いでください。

削除対象が自分の使い捨てクラスタにあることを確認し、動的 namespace、ClusterRoleBinding、ClusterRole、固定 namespace の順に `kubectl delete` で個別に撤収します。残存する固定リソースは次回の試験開始を妨げます。専用 kind クラスタ自体は、その名前と所有者を確認した作成者が `kind delete cluster --name <専用クラスタ名>` で撤収します。context 名の先頭に付く `kind-` はクラスタ名から除きます。

## 権限と隔離の制約

試験開始と撤収には実行者の kubeconfig の権限を使います。gateway Pod の試験用 ServiceAccount は、動的 namespace の作成・削除と、その中の Pod 作成・exec にクラスタ全体の権限を必要とします。Kubernetes RBAC は namespace 名や作成時のラベルでこの権限を限定できません。`rbac.yaml` は使い捨て検証専用であり、共有クラスタや本番へ適用しないでください。本番利用には別途 admission 制御と権限設計の承認が必要です。

NetworkPolicy は node 起点の通信を含む完全な敵対的コード隔離を保証しません。実環境の runtime、CNI、運用権限を個別に評価するまで、本番で Notebook を有効にしないでください。
