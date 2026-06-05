# 監視リスト自動同期（Drive→GitHub）セットアップ — 再開メモ

> 中断日: 2026-06-04 / 状態: **コード実装は完了・GCP設定の途中で中断**
> 再開するときは、このファイルの「残タスク」を上から進めればOK。

## ゴール

Google Drive の取引マスター（`TradeBook_master.json`）で売買している銘柄を、
毎日のワークフローが自動で監視リスト（`data/indicators_universe.json`）へ追記し、
「銘柄を買う → その夜のうちに客観スナップショットが自動表示」までを全自動にする。

## 完了済み（コード側・main反映済み）

- `tools/sync_universe_from_drive.py`: サービスアカウント(SA)認証でDriveの取引マスターを読み、
  売買銘柄を監視リストへ追記マージするスクリプト（PR #17）
- `.github/workflows/update-prices.yml`: `gen_indicators` の前に同期ステップを追加。
  Secret 未設定なら自動スキップ（後方互換）。実行時刻は 22:00 JST ＋ 07:30 JST の2回（PR #19）
- `tools/test_sync_universe_from_drive.py`: 単体テスト7件

→ **あとは認証情報(Secret)を登録すれば動く**状態。

## GCP側の進捗

- GCPプロジェクト: `My First Project`（組織 `mfamily-shogo0924-org`）
- Google Drive API: 有効化済み（※未確認なら要確認）
- サービスアカウント: **`tradebook-sync` 作成済み**
- SAのJSONキー: **未作成（組織ポリシーでブロック中）** ← ここで中断

### ⚠️ 中断の原因（ブロッカー）

SAキーのダウンロードが組織ポリシーで禁止されている:

```
組織ポリシー ID: iam.disableServiceAccountKeyCreation
（Google の「デフォルトで保護」で新規組織に自動適用される）
```

## 残タスク（再開時はここから）

### 方針を1つ選ぶ

- **Path 1（推奨・速い）: ポリシーをオフにしてSAキーを作る**
  1. メニュー →「IAM と管理」→「組織のポリシー」
  2. リソース選択を「My First Project」にする
  3. 検索: `disableServiceAccountKeyCreation`
  4. 「サービス アカウント キーの作成を無効にする」→「ポリシーを管理」
  5. 「親のポリシーをオーバーライドする」→ 適用を「オフ」→「保存」
  6. 1〜2分待ってから、SA `tradebook-sync` →「鍵」タブ →「鍵を追加」→「JSON」でダウンロード

- **Path 2（キー不要・より安全）: Workload Identity 連携(WIF)**
  - ポリシーを触らない代わりに、スクリプトとワークフローの書き換えが必要。
  - 採用する場合は Claude に「WIFで」と伝える（コード側を改修する）。

### キー取得後の共通ステップ

1. **Driveでファイルを共有**: `TradeBook_master.json` を右クリック →「共有」→
   SAのメール（`tradebook-sync@<プロジェクトID>.iam.gserviceaccount.com`）を「閲覧者」で追加
2. **GitHub Secret を2つ登録**（public-repository → Settings → Secrets and variables → Actions）:
   | Name | Value |
   |---|---|
   | `GDRIVE_SA_JSON` | ダウンロードしたJSONキーの中身を丸ごと |
   | `TRADEBOOK_DRIVE_FILE_ID` | `16KHsfGCH5orr-fcKd5M-ZI45nkhgG9ZA` |
3. **動作確認**: GitHub「Actions」→「Update latest prices」→「Run workflow」で手動実行。
   `data/indicators_universe.json` に取引銘柄が自動追記されれば成功。
   （自動では 22:00 JST の定期実行で同期される）

## 参考値

- 取引マスターのファイルID: `16KHsfGCH5orr-fcKd5M-ZI45nkhgG9ZA`
- 既存OAuthクライアント（Drive同期用・別物）: `TradeBook Web`
- 設定手順の詳細は README「監視リストの自動同期」も参照
