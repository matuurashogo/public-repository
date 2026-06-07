# [TBK-0001] エントリー・スナップショットのデータ契約（指標履歴JSON・監視リスト方式）

## 📜 ステータス

| 項目 | 値 |
|------|---|
| **Status** | `Superseded` |
| **Date** | 2026-06-04 |
| **Supersedes** | — |
| **Superseded by** | `TBK-0002`（rows に rsi/hv を追加してスキーマ拡張） |

## ❓ コンテキスト（背景と課題）

TradeBook は公開 GitHub Pages 上の静的 PWA で、取引データの正はユーザーの Google Drive（非公開）にある。
「エントリー型別成績」を自己申告タグだけでなく**客観データ**でも検証するには、買った日付×銘柄の時点の
テクニカル指標（凹みの深さ・出来高急増度・トレンド位置）が必要になる。これには過去日付の終値・売買代金の
時系列が要る一方、クライアント完結・オフライン可・iPhone でのダウンロード量という制約がある。

素朴に「全約3,800銘柄の指標履歴を銘柄別 JSON で毎日コミット」すると、ほぼ全ファイルが日々更新され
**git 履歴が日数十MB級で肥大化**する（年で数十GB）。リポジトリの健全性を損なうため採用できない。

## 💡 決定事項（Decision）

エントリー・スナップショット用の指標履歴を、以下のデータ契約で **Python 事前計算 → 銘柄別JSON遅延取得** とする。

1. **監視リスト方式でチャーンを限定する。** `data/indicators_universe.json` の `codes`（4桁）に挙げた
   銘柄のみ生成対象とする。エントリーした銘柄をリストに追加する運用。
2. **生成は `tools/gen_indicators.py`。** `jquants-data` の日次株価 `prices/prices_YYYYMMDD.parquet`
   （`code, date, adj_close, trading_value`）を結合し、指標を計算して銘柄別 JSON を出力する。
   既存の `update-prices.yml`（毎営業日 07:30 JST）に生成ステップを追加し、変更時のみコミットする。
3. **指標定義は VolDipSignals の `add_indicators` と一致させる**（終値ベース・四本値なし）:
   - `dev` = `adj_close / ma25 - 1`（25日線乖離率＝凹みの深さ）
   - `abv` = `adj_close > ma75`（75日線の上か＝トレンド位置）
   - `vol` = `trading_value / 売買代金20日平均`（出来高急増度）
4. **出力スキーマ `data/indicators/<code4>.json`**（直近約500営業日・日付昇順）:
   ```json
   {
     "code": "7203",
     "updated": "2026-06-03",
     "source": "jquants-data prices (VolDipSignals指標と同一定義)",
     "rows": [ {"d": "2024-05-16", "dev": -0.0618, "abv": false, "vol": 0.88}, ... ]
   }
   ```
   `dev` は小数4桁、`vol` は小数2桁に丸める。`abv` は真偽値。
5. **アプリは遅延取得・派生キャッシュ。** 取引した銘柄のファイルだけ取得し、買い日付に対し `d <= date` の
   最後の行（直近営業日）を引く。監視リスト外・期間外・未取得は「データなし」とし、客観軸の集計から除外する。
   取得結果は派生データとしてのみ扱い、master.json（Drive）には保存しない。

## 📈 結果・影響（Consequences）

- git チャーンが監視銘柄数に限定され、各銘柄は約2年の履歴をカバーできる（過去トレードの遡及も可）。
- 指標ロジックが VolDipSignals と一字一句同じ定義になり、シグナル発と裁量エントリーを同一軸で比較できる。
- 監視リスト未登録の銘柄は客観スナップショットが出ない（明示的な運用コスト）。アプリは「データなし」と
  注記して劣化動作する。
- 四本値を持たないデータ源のため、ローソク足パターンや日中レンジ依存の指標は対象外（スコープ外）。

## 🔧 実行可能チェック（Enforcement）

- 指標計算の純粋関数 `compute_payloads` を `tools/test_gen_indicators.py`（合成データで手計算と一致）で検証する。
- アプリ側の引き当て・バケット境界は `tests/indicators.test.js`（`lookupSnapshot` / `bucketOf`）で検証する。
- スキーマ（`d/dev/abv/vol`、日付昇順、丸め桁）を変更する場合は本 ADR を `Superseded` にし、新 ADR を起こすこと。

## 関連

- 設計: `docs/plans/2026-06-04-tradebook-entry-rationale-design.md`
- 実装計画: `docs/plans/2026-06-04-tradebook-entry-rationale-phase1-plan.md`
