# [TBK-0002] エントリー・スナップショットのデータ契約 v2（rsi/hv 軸を追加）

## 📜 ステータス

| 項目 | 値 |
|------|---|
| **Status** | `Accepted` |
| **Date** | 2026-06-04 |
| **Supersedes** | `TBK-0001` |
| **Superseded by** | — |

## ❓ コンテキスト（背景と課題）

`TBK-0001` でエントリー・スナップショットのデータ契約（凹みの深さ・出来高急増度・トレンド位置の3軸）を
定めた。運用の中で、客観での「答え合わせ」をより多面的に行うため、**RSI（売られすぎ度）と
年率ヒストリカル・ボラティリティ（HV）**を分析軸として追加したい。いずれも終値ベースで計算でき、
既存パイプラインに軽く足せる。スキーマ（`rows` の列）が変わるため、`TBK-0001` を `Superseded` にして
本 ADR で契約を更新する。

## 💡 決定事項（Decision）

`TBK-0001` の方針（監視リスト方式・Python事前計算→銘柄別JSON遅延取得・VolDipSignals同一定義）を
**そのまま継承**し、出力スキーマに 2 列を追加する。

1. **指標を2つ追加**（VolDipSignals の定義と一致）:
   - `rsi` = RSI(14)（単純移動平均版・下げ無し区間は 100）
   - `hv` = 日次 log 収益率の20日標準偏差 × √250（年率HV・小数=割合）
2. **出力スキーマ `data/indicators/<code4>.json`**（直近約500営業日・日付昇順）:
   ```json
   {
     "code": "7203",
     "updated": "2026-06-03",
     "source": "jquants-data prices (VolDipSignals指標と同一定義)",
     "rows": [ {"d": "2024-06-04", "dev": -0.0123, "abv": false, "vol": 1.42, "rsi": 48.2, "hv": 0.243}, ... ]
   }
   ```
   丸めは `dev` 4桁 / `vol` 2桁 / `rsi` 1桁 / `hv` 3桁。`abv` は真偽値。
3. **客観の集計軸を5つに拡張**: 既存の `dip` / `vol` / `trend` に加え、
   - `rsi`: 売られすぎ `≤30` / 中立 `30〜50` / 強め `>50`
   - `hv`: 低ボラ `<20%` / 中ボラ `20〜40%` / 高ボラ `≥40%`
4. その他（監視リスト・遅延取得・派生キャッシュ・「データなし」の劣化動作）は `TBK-0001` を踏襲する。

## 📈 結果・影響（Consequences）

- 「RSI30以下で拾った時の勝率」「高ボラ局面エントリーの成績」など、押し目の質を多面的に検証できる。
- `rsi`/`hv` を含む既存JSONは日次ジョブで自動的に上書き再生成される（監視リスト銘柄のみ）。
- 旧スキーマ（rsi/hv 無し）の JSON が残っていても、アプリ側は欠損軸を「データなし」として除外し劣化動作する。
- 「シグナル一致」軸（VolDipSignals のユニバース・地合いを要する）は引き続きスコープ外（将来 ADR で検討）。

## 🔧 実行可能チェック（Enforcement）

- 指標計算 `compute_payloads` を `tools/test_gen_indicators.py`（合成データで RSI=100・HV>0 等を検証）でチェック。
- アプリ側の引き当て・バケット境界は `tests/indicators.test.js`（`lookupSnapshot` の rsi/hv 透過、`bucketOf` の rsi/hv 境界）でチェック。
- スキーマ（列・丸め桁）を変更する場合は本 ADR を `Superseded` にし、新 ADR を起こすこと。

## 関連

- 前身: `docs/adr/TBK-0001-tradebook-entry-snapshot-data-contract.md`
- 設計: `docs/plans/2026-06-04-tradebook-entry-rationale-design.md`
