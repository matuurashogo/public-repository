# TradeBook 保有銘柄 含み損益（評価損益）設計

- 日付: 2026-05-31
- 対象: 公開リポジトリ（TradeBook 本体）+ jquants-data（株価ソース）
- 前提: 保有銘柄カード（`2026-05-31-tradebook-holdings-card-design.md`）が実装済み

## 背景と目的

保有銘柄カードは現在「銘柄 / 保有数 / 平均取得単価」の3列のみで、**今いくらの含み損益か**が分からない。
保有カード設計でも「含み損益（損益列）は価格連携の導入時に列追加」と明記しており、本設計でその価格連携を行う。

別リポジトリ [`jquants-data`](https://github.com/matuurashogo/jquants-data) が J-Quants から取得した
日次株価（終値）を保持しているため、これを使って保有銘柄の**評価額・含み損益・含み損益率**を算出する。

## スコープ

- 保有銘柄カードに **現在値 / 評価額 / 含み損益（率）** の列を追加する。
- 価格は **最新営業日の終値（1本）** のみ同梱する（時系列・任意日評価は対象外）。
- 含み損益は**未実現**。既存の実現損益（`calcRealized`）とは別概念として扱い、税額計算には一切含めない。

## データソース調査（確定事項）

### jquants-data 側

- `prices/prices_latest.parquet`（最新営業日の全銘柄終値・重複ファイル）
  - スキーマ: `code(string)`, `date`, `close(double)`, `adj_close(double)`, `adj_volume`, `trading_value`, `is_limit`, `adj_factor`, `extracted_at`
  - 件数: **4,215銘柄**、最新日 **2026-05-29**（調査時点）
  - `code` は J-Quants 5桁形式（例 `72030`）。先頭4桁で TradeBook の `7203` と突合可能。
- 日次ファイル `prices/prices_YYYYMMDD.parquet` も 754 日分あるが、本設計では使わない（最新のみ）。

### TradeBook 側

- `calcRealized(trades)` が既に `holdings = { code: { quantity, cost } }` を返す
  （`quantity`=残株数、`cost`=手数料込みの取得原価）。**保有計算の追加実装は不要**。
- `renderHoldings(holdings)` が保有カードを描画中。ここに列を足す。

## 同梱する価格データ（latest_prices.json）

`prices_latest.parquet` を JSON 化して public リポに同梱する（`stocks.json` と同じ方式）。

### フォーマット案

```json
{
  "date": "2026-05-29",
  "source": "jquants-data prices_latest",
  "prices": {
    "7203": 3042,
    "8306": 2999
  }
}
```

- キー = 4桁証券コード（5桁→先頭4桁）、値 = **`adj_close`（調整後終値）**。
  - **調整後終値を採用する理由**: 株式分割等の影響を吸収済みで、現在の1株価値を表す。
    取得原価（過去の約定単価ベース）との比較で「現在値×保有数」を素直に評価できる。
    ※厳密には取得原価側も分割調整が必要なケースがあるが、本MVPでは現値側のみ調整後を使い、
      分割をまたぐ銘柄の含み損益はラフ表示とする（下記「既知の限界」参照）。
- サイズ: 約 **58KB**（4,215銘柄、コンパクトJSON）。`stocks.json` 同様に PWA キャッシュに収まる軽量さ。
- 配置: `data/latest_prices.json`。

## 計算式（新規・純粋関数として pnl.js へ追加）

保有 1 銘柄あたり:

```
現在値      = prices[code]                      （無ければ評価不能=null）
評価額      = 現在値 × 保有数(quantity)
含み損益    = 評価額 − 取得原価(cost)            （cost は手数料込み）
含み損益率  = 含み損益 / 取得原価
```

ポートフォリオ合計:

```
評価額合計     = Σ 評価額
取得原価合計   = Σ cost
含み損益合計   = 評価額合計 − 取得原価合計
```

### 追加する純粋関数（案）

```js
// pnl.js
// holdings: { code: { quantity, cost } }
// priceMap: { code: number }  最新終値（4桁コード）
// 戻り値: { rows: [{ code, quantity, cost, avg, price, marketValue, unrealized, unrealizedRate, priced }],
//          total: { cost, marketValue, unrealized, unrealizedRate, pricedAll } }
export function calcUnrealized(holdings, priceMap) { ... }
```

- `price` が無い銘柄は `priced=false` とし、評価額・含み損益を `null`（UIで「—」表示）。
- 合計は **値が取れた銘柄のみ**で集計し、`pricedAll=false`（一部欠損）を立ててUIに注記。

## 画面（保有銘柄カードの拡張）

テーブルを 3 列 → 6 列へ拡張する。

| 列 | 内容 | 出所 |
|---|---|---|
| 銘柄 | 社名 ＋ コード | `codeToName(code)` ＋ code |
| 保有数 | 残株数 | `holdings[code].quantity` |
| 平均取得単価 | 円（手数料込み） | `cost / quantity` |
| 現在値 | 円（最新終値） | `priceMap[code]` |
| 評価額 | 円 | `price × quantity` |
| 含み損益 | 円（+/−色分け）・率 | `marketValue − cost` |

- カード見出し脇に **基準日**（`latest_prices.json.date`）と「終値ベース・未実現」を明記。
- カード下部に**ポートフォリオ合計**（取得原価合計 / 評価額合計 / 含み損益合計）を表示。
- 価格欠損銘柄は現在値以降を「—」、合計に注記（例: 「N銘柄は価格未取得のため合計から除外」）。
- スマホ幅で6列は窮屈なため、CSSで現在値列は折りたたむ等の調整余地あり（実装時に確認）。

## 更新運用（latest_prices.json の再生成）

第一候補は **案A: 手動スクリプト**（`stocks.json` と同じ流儀。確実・単純）。

### 案A: 手動スクリプト（推奨・MVP）

- `tools/gen_prices.py` を追加。`gen_stocks.py` と同様に jquants-data を兄弟ディレクトリ
  または環境変数 `JQUANTS_PARQUET_REPO` で検出し、`prices/prices_latest.parquet` を読んで
  `data/latest_prices.json` を生成する。
- 株価を更新したいタイミングで手動実行 → commit/push。
- pyarrow は任意依存（gen_stocks.py と同じ扱い）。

### 案B: GitHub Actions 自動化（将来・任意）

- 平日夕方などに定期実行し `latest_prices.json` を自動再生成・コミット。
- 課題: jquants-data は **private**。Actions から読むには PAT/deploy key 等の認証設定が必要。
- 後付け可能なため、MVP では採用せず論点として記録に留める。

## ⚠️ 重要な前提・確認が必要な事項

1. **データ再配布の可否（最優先）**
   - TradeBook 本体は **public**、jquants-data は **private**。
   - `latest_prices.json` を public リポに置くと **J-Quants 由来の終値が公開**される。
   - J-Quants の利用規約で「終値の再配布／公開」が許諾されているか**要確認**。
   - 許諾されない場合の代替: アプリも private 化する / 価格を同梱せず利用者が自分の
     jquants-data から生成する運用にする / Drive に置く 等。**実装前に必ず判断する。**

2. 株価の鮮度
   - 最新終値は「最新営業日の引け値」。リアルタイム株価ではない。UIに基準日を明示して誤解を防ぐ。

## 既知の限界（MVP）

- **分割調整の非対称**: 現在値は `adj_close`（調整後）、取得原価は約定当時の生値。分割を
  またいで保有している銘柄は含み損益がずれる可能性がある。MVPではラフ表示とし、将来
  `adj_factor` や取得側の調整で精緻化する。
- 価格未収録銘柄（新規上場直後・対象外銘柄）は含み損益を「—」表示。
- 単元未満・端株の特別表示はしない（保有カード設計を踏襲）。
- 為替・配当・信用は対象外。

## 実装対象（案A採用時）

- `tools/gen_prices.py`（新規）: parquet → `data/latest_prices.json` 生成。
- `data/latest_prices.json`（新規・生成物）。
- `js/prices.js`（新規）: `latest_prices.json` を fetch して priceMap を返す（`stocks.js` と対）。
- `js/pnl.js`: `calcUnrealized(holdings, priceMap)` を追加（純粋関数・テスト対象）。
- `js/app.js`: 価格ロードを起動時に追加し、`renderHoldings` を含み損益対応に拡張。
- `index.html` / `css/style.css`: 列追加・合計行・基準日表示。
- `sw.js`: `data/latest_prices.json` を ASSETS に追加し、キャッシュ版数を v10 → v11 へ。

## テスト

- `pnl.js` の `calcUnrealized` に単体テストを追加（`node --test`）:
  - 通常銘柄の評価額・含み損益・率。
  - 価格欠損銘柄が `priced=false`・合計から除外されること。
  - 保有0銘柄が除外されること。合計の整合。
- 既存テスト（実現損益・KPI・store）の非回帰を確認。
- 実画面はスクリーンショットで目視確認。

## 非対象（将来）

- 任意基準日・時系列の評価額推移グラフ（日次parquetを使えば可能だがデータ量増）。
- 分割調整の精緻化、配当込みトータルリターン。
- GitHub Actions による価格自動更新（案B）。
