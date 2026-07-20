# [TBK-0013] データ生成ツールの入力を R2（quant-data-platform）へ切替可能にする（datasource 層）

## 📜 ステータス

| 項目 | 値 |
|------|---|
| **Status** | `Accepted` |
| **Date** | 2026-07-19 |
| **Supersedes** | — |
| **Superseded by** | — |

## ❓ コンテキスト（背景と課題）

TradeBook のデータ生成（`tools/gen_prices.py` / `gen_indicators.py` / `gen_buy_levels.py` /
`gen_volatility.py` / `gen_stocks.py`）は、兄弟リポジトリ `jquants-data` の Parquet を直接読んでいた。
一方、private ワークスペースでは point-in-time データ基盤 **quant-data-platform（QDP）** が並行構築され、
G2 突合（ライブ独立フェッチで raw 全件一致・2026-06-22）を経て silver/gold 全14表を
Cloudflare R2 へ日次 publish している（QDP-0026/0031）。

jquants-data 経路には次の制約がある:

1. GitHub Actions から private リポジトリを PAT + sparse clone で読む必要がある（トークン管理・clone コスト）。
2. **high / low が存在しない**（close 系のみ）。支持線・抵抗線（スイング水準）の算出に必要な
   adj_high / adj_low は QDP の `fact_prices_daily`（QDP-0040 権威導出）にしか無い。
3. 銘柄名（`stocks.json`）の主データが private の JQuantsExtractor 依存で、公開リポ単体で再生成できない。

## 💡 決定事項（Decision）

1. **共通データソース層 `tools/datasource.py` を新設**する。gen ツールは jquants-data の Parquet を
   直接読まず、この層を経由する。バックエンドは環境変数 `TRADEBOOK_DATA_SOURCE` で切替:
   - `local`（**既定**）: 従来どおり jquants-data（`JQUANTS_PARQUET_REPO` または兄弟ディレクトリ）。
   - `r2`: QDP silver 表を DuckDB httpfs で直読み。
     - `r2://<R2_BUCKET>/qdp/silver/fact_prices_daily.parquet`（価格）
     - `r2://<R2_BUCKET>/qdp/silver/dim_listed.parquet`（銘柄名・33業種）
2. **列名の正規化契約**: どちらのバックエンドでも、戻り値は従来の jquants-data 列名に正規化する。
   下流の gen ツール・出力 JSON 契約（TBK-0004/0006/0009/0010 等）は**一切変えない**。

   | 正規化後（従来名） | local（jquants-data） | r2（fact_prices_daily） |
   |---|---|---|
   | `code`（5桁 str） | `code` | `code5` |
   | `date` | `date` | `date` |
   | `adj_close` / `close` / `adj_volume` / `adj_factor` / `is_limit` | 同名 | 同名 |
   | `trading_value` | `trading_value` | `turnover_value` |
   | `adj_open` / `adj_high` / `adj_low` | **提供不可**（要求時 ValueError） | 同名（QDP-0040） |

   - 業種マップ（TBK-0009 連れ安度）: local は `full/sector33_<S33>_full.parquet` のファイル名方式、
     r2 は `dim_listed.sector33`。契約は「同一業種の銘柄が同じキーに集まる」こと（キー表記の一致は求めない）。
   - 銘柄名: r2 は `dim_listed.company_name` を補完ソースに使う（`gen_stocks.py`）。
     **r2 選択時は私有マスター無しでも stocks.json を生成できる**（公開リポ単体再生成の制約解消）。
3. **R2 資格情報**は QDP と同じ命名（`R2_BUCKET` / `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` /
   `R2_SECRET_ACCESS_KEY`。読み取り専用トークン `R2_RO_*` へフォールバック）。
   **CREATE SECRET の SQL を例外・ログへ出さない**（鍵漏洩防止・QDP r2_reader と同方針）。
   実値のコミットは GLOB-0005 に従い禁止。
4. **既存経路の維持（後方互換）**: 既定は `local` で従来挙動を byte 一致で維持する。
   GitHub Actions（update-prices.yml）は当面 local のまま運用し、本 ADR の eval が実 R2 で
   PASS した後に切替える（切替自体は環境変数の追加のみ）。
5. **テスト/ミラー用フック**: `TRADEBOOK_R2_URL_BASE` でテーブル URL の基底を差し替えられる
   （ローカルミラー読み・資格情報不要）。単体テストと事前検証に使う。

## 📈 結果・影響（Consequences）

- gen ツール本体の計算ロジック・出力 JSON 契約は不変（出力の `source` ラベルのみ入力源を反映）。
- 支持線・抵抗線（次期 TBK-0014 予定）が必要とする adj_high / adj_low への道が開く。
- jquants-data への依存は残る（local 経路）。QDP 側の障害時は `TRADEBOOK_DATA_SOURCE` を
  戻すだけで復旧できる。
- r2 経路には `duckdb` の追加依存が生じる（local 経路では不要・import しない）。

## 📊 Eval 定義（ティアA）

- **対象 (Target)**      : datasource 層の local / r2 バックエンドの入力パリティ（＝出力 JSON の同等性）
- **成功条件 (Success)**  : 同一時点のデータに対し、(1) local の全 (code,date) キーを r2 が被覆
  （**local ⊆ r2**。r2 のみの行＝ETF/REIT・新形式コード等の追加収録は許容）、(2) 共通キーで
  trading_value / close が完全一致、(3) adj_close の不一致は**銘柄内で r2/local 比が一定**
  （＝分割の遡及調整差。R2 が権威・QDP-0040。jquants-data の日別ファイルは凍結で stale）に限る
- **Grader (採点器)**     : Code。`tools/eval_datasource_parity.py`（P1 日付集合 / P2 local⊆r2 被覆 /
  P3 値一致＋遡及差判別 / P4 最新終値）＋ `tools/test_datasource.py`（fixture パリティ）
- **合格閾値 (Threshold)** : P1 完全一致・P2/P4 被覆率 ≥ 99.9%・P3「遡及差で説明できない不一致」0 行
- **反例 (Negatives)**    : trading_value に turnover_value 以外の列を対応させて桁が変わる／
  adj_close の比が銘柄内で**一定でない**のに許容してしまう採点器／日付窓のズレで P1 が崩れるのに
  PASS する採点器
- **状態 (State)**        : **Shipped**（実 R2 測定 PASS）
  - 2026-07-19 サンドボックス実測（jquants-data 789営業日から構築した R2 ミラー形式スタブ vs local）:
    P1〜P4 全 PASS（30日窓・126,271行・不一致0）。gen 4種の出力 JSON **22/22 ファイル一致**（source 除く）。
  - 2026-07-20 **実 R2 バケット測定（Refine 後）**: P1〜P4 全 PASS。差分はすべて説明可能——
    (a) r2 のみ 6,992 行（224 銘柄/日。ETF/REIT・新形式コード等 jquants-data 抽出対象外の追加収録）、
    (b) adj_close 遡及差 34 銘柄 515 行（例: 1663 の 2026-06-29 1:2 分割 ×0.5、2237 の 1:50 併合 ×0.02。
    R2 が過去へ遡及調整・local は凍結ファイルで stale＝**R2 が正**）。説明不能な不一致 0 行。
  - 初回測定（Refine 前の完全一致意味論）は上記 (a)(b) を FAIL 扱いにしていたため、成功条件を
    本節のとおり精緻化した（Run↔Refine）。**切替は劣化ではなく改善**: 分割跨ぎの指標（MA25 等）は
    local では価格空間が不連続だったが、r2 では正しく連続する。

## 🔧 実行可能チェック（Enforcement）

```bash
# fixture パリティ（資格情報・ネットワーク不要。ハーネスで常時実行）
python TradeBook/tools/test_datasource.py

# 実データ突合（jquants-data ローカル + R2 資格情報 or TRADEBOOK_R2_URL_BASE が必要）
python TradeBook/tools/eval_datasource_parity.py --days 30
```
