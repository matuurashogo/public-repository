# TradeBook — エージェント向けガイド

> [!IMPORTANT]
> このファイルは TradeBook における AI エージェント向けのコンテキスト・設計方針です。
> **変更前に必ず本ファイルを読み、設計原則と禁止パターンを確認してください。**

松井証券向けの損益計算 PWA。取引を手入力で記録し、平均法で実現損益・概算税額を計算して年間/月間/銘柄別に集計・可視化する、iPhone想定のクライアント完結型 Web アプリ。

## 📍 目的・役割

- **入力**: ユーザーが手入力する取引（約定日 / 銘柄コード / 売買 / 数量 / 約定単価 / 口座区分）。
- **出力**: 実現損益（平均法）・概算税額（20.315%・NISA非課税）・KPI・含み損益・買い時ボードの画面表示。
- **データの正**: Google Drive 上の単一マスター JSON（`TradeBook_master.json`）。未設定時は localStorage のみで動作。
- **責務の境界**: アプリは「記録・計算・表示」に専念。価格/指標などの**データ生成は `tools/` の Python が日次バッチで行い**、結果を静的 JSON として同梱する（アプリ実行時に重い計算をしない）。

## ⚖️ コアルール / 設計原則（必読）

- **損益・税・手数料・KPI・買いレベルのロジックは純粋関数**（`js/pnl.js` 等）に置き、`tests/` で検証する。UI から計算ロジックを分離する。
- **算術はコード、判断のみ人間/LLM**: 金額・税・順位の計算を曖昧にしない（`.claude/rules/eval_first.md`）。
- **データ契約は ADR で固定**: `data/*.json` のスキーマは `docs/adr/TBK-*` のデータ契約に従う。契約を変えるなら新ADR＋テスト更新をセットで。
- **クライアント完結**: バックエンドサーバを持たない。外部通信は Google Drive（`drive.file` スコープ）と静的データ取得のみ。
- **PWA配信前提**: 相対パスで動くこと。`sw.js` のキャッシュ版数（`tradebook-shell-vN`）はデータ更新時に上げる。
- **禁止パターン**: ① 実現損益計算に未確定の含み損益を混ぜない（含み益は `calcUnrealized()` で別管理）。② 月別・銘柄別に税額を出さない（申告分離課税のため税は**年単位のみ**）。③ NISA を課税計算に含めない。

## 🔗 データソース・連携

| データ | パス | 用途 / 連携方式 |
|---|---|---|
| 最新終値 | `data/latest_prices.json` | 含み損益。jquants-data（private）から Actions が日次生成（read-only参照） |
| エントリー指標 | `data/indicators/<code>.json` | 型別成績の客観軸。監視リスト方式（`data/indicators_universe.json`） |
| 買いレベル | `data/buy_levels.json` | 買い時ボード（TBK-0006）。日次生成 |
| ボラティリティ | `data/volatility.json` | 利確目標（TBK-0010） |
| 支持線・抵抗線 | `data/sr_levels.json` | 保有カード・買い時ボードの S/R 表示（TBK-0014）。**生成は r2 必須**（adj_high/adj_low） |
| 場中価格 | orphan ブランチ `intraday` の `data/intraday_prices.json` | 表示専用（TBK-0008・約20分遅延）。`js/intraday.js` が raw URL で取得。生成は Actions（`intraday-prices.yml`）/ VPS（`scripts/vps_intraday_update.sh`）の2経路（後者が本命・専用IP） |
| 銘柄名 | `data/stocks.json` | コード→銘柄名。生成は private の JQuantsExtractor 依存（この公開リポ単体では再生成不可） |

外部依存（jquants-data）は **read-only**。アプリは生成済み JSON を読むだけで、生成ロジックを持ち込まない。

### データ生成ツールの入力切替（TBK-0013）

`tools/gen_*.py` の入力は共通層 `tools/datasource.py` 経由で二系統から選べる:

| バックエンド | 切替 | 入力 |
|---|---|---|
| `local`（既定） | — | jquants-data の Parquet（従来。`JQUANTS_PARQUET_REPO` or 兄弟ディレクトリ） |
| `r2` | `TRADEBOOK_DATA_SOURCE=r2` | QDP silver（`r2://<bucket>/qdp/silver/fact_prices_daily.parquet` / `dim_listed.parquet`。要 `R2_*` 環境変数・duckdb） |

どちらも戻り値は従来列名に正規化される（`trading_value`←`turnover_value` 等）。
**adj_high / adj_low は r2 にしか無い**（local で要求すると ValueError。支持線・抵抗線系はこれに依存）。

## 🚀 主要コマンド

```bash
# ローカル確認（静的配信。例: 任意の簡易サーバ）
#   index.html をルートに置いて配信する

# データ生成（Python・jquants-data 等が必要。通常は GitHub Actions が日次実行）
python tools/gen_prices.py        # 最新終値
python tools/gen_indicators.py    # エントリー指標スナップショット
python tools/gen_buy_levels.py    # 買い時ボード
python tools/gen_volatility.py    # 利確目標用ボラティリティ
python tools/gen_stocks.py        # 銘柄名マスター（private データ依存。r2 なら単体生成可）

# R2（QDP silver）から生成する場合（TBK-0013。要 R2_* 環境変数・duckdb）
TRADEBOOK_DATA_SOURCE=r2 python tools/gen_prices.py
TRADEBOOK_DATA_SOURCE=r2 python tools/gen_sr_levels.py  # 支持線・抵抗線（TBK-0014・r2 必須）
python tools/eval_datasource_parity.py --days 30   # local/r2 突合の Code-grader
```

> デプロイ: アプリ実体は `TradeBook/` にあり、ルートの `.github/workflows/deploy-pages.yml` が
> `TradeBook/` をサイトルートとして GitHub Pages へ配信する。価格更新ワークフローのパスも `TradeBook/` 基準。

## 🧪 テストコマンド

```bash
# 損益計算ロジック等の単体テスト（JS・主）
node --test tests/*.test.js

# データ生成ツールの単体テスト（Python・pandas 等が必要なものあり）
python tools/test_gen_indicators.py
python tools/test_gen_buy_levels.py
python tools/test_gen_volatility.py
python tools/test_datasource.py
python tools/test_gen_sr_levels.py
```

## ⚠️ 既知のミスパターン

> 最重要セクション。バグを踏んで直したら、その教訓をここに1行追記すること。

- `data/stocks.json` 未収録のコード（例: 7203 トヨタ）は銘柄名が空欄になる（記録・計算は可能）。
- `tools/gen_stocks.py` は private の JQuantsExtractor データに依存するため**この公開リポ単体では再生成不可**。同梱済みの `data/stocks.json` を使う。
- 場中価格は**表示専用**。判定・通知・実現損益は終値ベースのまま混ぜない。古い asOf（90分超）は終値へフォールバック。
- 価格データ更新時は `sw.js` のキャッシュ版数を上げないと PWA に新データが届かない（update-prices.yml が自動で +1 する）。
- リポジトリ再配置により、ワークフローのパスは `TradeBook/tools/...`・`TradeBook/data/...` 基準。`tools/*.py` 自体は `__file__` で自己解決するため cwd 非依存。
- `TRADEBOOK_DATA_SOURCE=r2` で gen を実行すると出力 JSON の `source` ラベルが変わる（値は同一・TBK-0013 で検証済み）。コミット前にどちらの経路で生成したかを意識すること。
- R2 の CREATE SECRET SQL を例外・ログへ出さない（鍵漏洩。`datasource.py` は握り潰す実装になっている——変更時に壊さないこと）。
- **jquants-data の日別ファイルは分割を遡及調整しない（stale adj）**。分割銘柄で local と r2 の adj_close が異なるのは **r2 が正**（QDP-0040 の権威遡及）。local 経路では分割跨ぎの MA 等が不連続になる既知の限界がある。
- r2 は ETF/REIT・新形式コード等も収録するため latest_prices.json は local より銘柄数が多くなる（上位集合・無害）。

## 📝 ADR 参照

- ADR 一覧: `docs/adr/`（`TBK-NNNN`。データ契約・K調整・型別成績など）
- 設計ドキュメント: `docs/plans/`
- 採番・ライフサイクル: `../.claude/rules/adr.md`
