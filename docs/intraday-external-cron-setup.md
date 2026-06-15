# 場中価格の自動起動を外部cronで確実化する手順

> 対象ワークフロー: `.github/workflows/intraday-prices.yml`（場中価格・表示専用・TBK-0008）
> 背景: GitHub のスケジュール（cron）起動は間引き・遅延・スキップが多く、実運用では1日2回程度しか
> 発火せず更新が止まっていた。**取得処理自体は正常**で、不安定なのは「起動の1回目」だけ。
> そこで起動を外部cronサービスから `workflow_dispatch`（API）で確実に叩く方式にする。
> 起動さえすれば、ジョブ内の15分ループがセッション終了時刻まで確実に回る。

ワークフロー側の変更は不要（`workflow_dispatch` と起動時刻からのセッション判定は実装済み）。
以下の「①PAT発行 → ②外部cron設定」を一度行えば、起動ドロップは事実上なくなる。

---

## ① Fine-grained PAT を発行する（最小権限）

GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → Generate new token

| 項目 | 設定値 |
|---|---|
| Token name | `intraday-dispatch`（任意） |
| Expiration | 任意（例: 90日。期限切れ前にローテーション） |
| Repository access | **Only select repositories** → `matuurashogo/public-repository` のみ |
| Permissions → Repository permissions → **Actions** | **Read and write**（`workflow_dispatch` に必須） |

> 他の権限は付けない。万一漏れても、できるのは「場中価格ワークフローの起動」だけに限定される。

発行後のトークン文字列（`github_pat_...`）を控える（後で外部cronのヘッダに貼る）。

---

## ② 外部cronサービス（例: cron-job.org）を設定する

無料の cron-job.org を例にする（UptimeRobot 等でも可）。アカウント作成後、**2つのcronジョブ**を作る
（前場9:00・後場12:30 JST で起動時刻の「分」が違うため、ジョブを分けるのが簡単）。

### 共通のリクエスト内容（両ジョブで同一）

- **URL**:
  `https://api.github.com/repos/matuurashogo/public-repository/actions/workflows/intraday-prices.yml/dispatches`
- **Method**: `POST`
- **Headers**（cron-job.org の「Headers」タブで追加）:
  ```
  Authorization: Bearer github_pat_ここに①のトークン
  Accept: application/vnd.github+json
  X-GitHub-Api-Version: 2022-11-28
  Content-Type: application/json
  ```
- **Request body**:
  ```json
  {"ref":"main"}
  ```

### スケジュール（タイムゾーンは Asia/Tokyo を選択）

| ジョブ | 曜日 | 時刻(JST) | 用途 |
|---|---|---|---|
| ジョブA | 月〜金 | **09:00** | 前場の起動（〜11:30 まで15分ループ） |
| ジョブB | 月〜金 | **12:30** | 後場の起動（〜15:30 まで15分ループ） |

> cron-job.org の場合: タイムゾーンに `Asia/Tokyo` を設定し、曜日は Mon–Fri のみチェック、
> 時 `9`・分 `0`（ジョブA）／ 時 `12`・分 `30`（ジョブB）を指定する。

---

## 動作確認

1. 設定後、cron-job.org の各ジョブで **「TEST RUN」** を実行 → レスポンスが **HTTP 204**（成功）であること。
   - 401/403 が返る場合はトークンの権限（Actions: Read and write）かヘッダの綴りを見直す。
2. GitHub の Actions → `Update intraday prices` に `workflow_dispatch` 起動の実行が現れる。
3. 数分後、`intraday` ブランチの `data/intraday_prices.json` の `asOf` が当日の日時に更新される:
   `https://raw.githubusercontent.com/matuurashogo/public-repository/intraday/data/intraday_prices.json`

---

## 補足

- ワークフロー側の `schedule:`（GitHub cron）は**残してある**。外部cronと両方から起動されても、
  `concurrency`（`cancel-in-progress: true`）で古いセッションが打ち切られて回り直すだけで害はない。
  GitHub cron が偶然発火すれば保険になり、落ちても外部cronが起動を担保する。
- 場中価格は **表示専用**（TBK-0008）。買いレベルの到達判定・LINE通知・ExitLab検証は終値ベースのまま。
  この起動方式の変更はデータ契約に影響しない。
- PAT は期限切れ前にローテーションする。期限切れになると外部cronが 401 になり、起動だけが止まる
  （その間も画面は終値へ静かにフォールバックするだけで壊れない）。
