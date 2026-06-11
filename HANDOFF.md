# TradeBook 引き継ぎメモ（次のチャット用）

> このファイルは、別チャット（公開リポジトリ）で作業を続けるための引き継ぎ資料です。
> パスはすべて**このリポジトリのルート＝アプリのルート**を基準に記載しています。

## これは何か

松井証券向けの **損益計算Webアプリ（TradeBook）**。取引を手入力で記録し、平均法で実現損益を計算、
年間/月間/銘柄別に集計・可視化する。iPhoneのブラウザ（PWA）で利用。データの正は **Google Drive 上の単一マスターJSON**。

- もともと非公開の `private-repository` 内 `TradeBook/` として開発。**ソースの正は `private-repository/TradeBook/`**。
  本リポジトリ（`public-repository`）は、その `TradeBook/` の中身をルートに配置した公開デプロイ用リポジトリ。
- 詳細な設計/採用判断は元の非公開リポにある（`private-repository/docs/plans/2026-05-30-tradebook-pnl-design.md`、
  `private-repository/docs/adr/GLOB-0002-tradebook-frontend-cloud-stack.md`）。

## 実装済み（MVP・動作確認済み）

- `js/pnl.js`: 損益計算ロジック（平均法・概算税20.315%）。純粋関数。`tests/pnl.test.js` で7件PASS。
- `js/app.js`: 画面統合（入力フォーム・編集/削除・年間/月間/銘柄別集計・同期ステータス）。
- `js/charts.js` + `js/vendor/chart.umd.min.js`: 累積損益の折れ線グラフ（Chart.js同梱・オフライン可）。
- `js/store.js`: マスター状態管理＋localStorage読み取りキャッシュ。
- `js/drive.js` + `js/config.js`: Google Drive連携（`drive.file`スコープ、OAuthトークンフロー）。
- `js/stocks.js` + `data/stocks.json`: コード→銘柄名 自動表示（約3,800銘柄。主データ=subsector_master 約2,200 ＋ jquants-data の `full/` `company` 列から不足分を補完）。
- `js/prices.js` + `data/latest_prices.json`: 最新終値（jquants-data の `prices_latest`）を読み、保有銘柄カードに**含み損益（評価損益・未実現）**を表示。`pnl.js` の `calcUnrealized()` で算出（`tests/unrealized.test.js` で7件PASS）。設計: `docs/plans/2026-05-31-tradebook-holdings-pnl-design.md`。
- `tools/gen_prices.py` + `.github/workflows/update-prices.yml`: `latest_prices.json` を jquants-data から生成。Actions が毎日 07:30 JST に自動再生成・コミット（要 Secret `JQUANTS_DATA_TOKEN` = jquants-data 読取用 Fine-grained PAT）。
- `index.html` / `css/style.css` / `manifest.webmanifest` / `sw.js` / `icons/`: UIとPWA一式。
- `README.md` / `DEPLOY.md`: 利用・デプロイ手順。
- **監視銘柄のアプリ内編集（TBK-0007）**: 買い時ボードカードの「監視銘柄を編集」から追加・削除。Drive マスターの `watchlist`（配列LWWマージ）に保存し、`tools/sync_universe_from_drive.py` が夜間に `indicators_universe.json` へ反映（削除も伝播。**GCP Secret 設定が完了するまで自動反映は保留** → `docs/tradebook-drive-sync-setup-todo.md`）。
- **取引追加のフローティングボタン**: 「＋」を画面右下に固定（`.add-btn`）。スクロール不要でフォームを開ける。
- `js/intraday.js` + `tools/fetch_intraday_prices.py` + `.github/workflows/intraday-prices.yml`: **場中価格表示**（TBK-0008・表示専用）。Yahoo チャートAPI（約20分遅延）から監視リスト銘柄を平日9:00〜15:30の15分ごとに取得し、orphan ブランチ `intraday` へ force-push（main の履歴を汚さない）。保有銘柄の含み損益とボードの現在値が場中も更新される（「13:30時点」併記）。**判定・通知は終値ベースのまま**。古いデータ（90分超）は自動で終値表示にフォールバック。
- `js/buylevels.js` + `tools/gen_buy_levels.py` + `data/buy_levels.json`: **買い時ボード**。監視リスト銘柄の「あといくら下がったら買いか」（レベル価格6本: 25日線/−5%/−8%・20日高値−10%/−15%・60日安値）を日次計算して表示（🟢到達/🟡接近/↗陽転）。データ契約は `docs/adr/TBK-0006-buy-levels-data-contract.md`、設計は `docs/plans/2026-06-10-buy-levels-board-design.md`。LINE 通知は private 側 `BuyLevels/notify.py`（テスト: `tests/buy_levels.test.js` / `tools/test_gen_buy_levels.py`）。

## 次にやること（このチャットの続き）

1. **GitHub Pages 有効化**: `public-repository` の Settings → Pages → Source「Deploy from a branch」→ `main` / `/(root)`。
   公開URL: `https://matuurashogo.github.io/public-repository/`
2. **Google OAuth 設定**: Google Cloud で OAuth クライアントID（ウェブアプリ）を発行し、
   「承認済み JavaScript 生成元」に Pages オリジン `https://matuurashogo.github.io` を追加。
   発行したIDを `js/config.js` の `GOOGLE_CLIENT_ID` に設定して commit/push。
3. **iPhoneで動作確認**: Safariで公開URL → 共有 → ホーム画面に追加。
4. （任意）**自動デプロイ化**: mainへのpushで公開する GitHub Actions ワークフローを追加してもよい。

## 次フェーズ候補（未実装）

- CSVインポート/エクスポート（バックアップ・松井CSV取込）
- 手数料の取引別入力（現状は0円扱い）
- 評価損益（含み損益）・現在株価取得、配当
- 銘柄名の完全網羅（現状は jquants-data の `full/` で約3,800銘柄を補完済み。さらに J-Quants `listed_info` の全銘柄マスター `equity_master.jsonl` を `JQuantsExtractor/tools/export_equity_master.py` で生成し `tools/gen_stocks.py` に読ませれば全銘柄化できる）

## 開発メモ

- テスト: `node --test tests/*.test.js`（`package.json` に `type:module`）。
- `tools/gen_stocks.py` は元の非公開リポの `JQuantsExtractor` データに依存するため、**この公開リポ単体では再生成不可**。
  `data/stocks.json` は生成済みを同梱しているのでそのまま使える。
- 既知の制約: `data/stocks.json` 未収録のコード（例: 7203 トヨタ）は銘柄名が空欄になる（記録・計算は可能）。
