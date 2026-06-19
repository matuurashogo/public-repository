# [TBK-0004] エントリー・スナップショットのデータ契約 v3（終値 c を追加）

## 📜 ステータス

| 項目 | 値 |
|------|---|
| **Status** | `Accepted` |
| **Date** | 2026-06-07 |
| **Supersedes** | `TBK-0002` |
| **Superseded by** | — |

## ❓ コンテキスト（背景と課題）

`TBK-0002` で指標履歴JSON（`dev`/`abv`/`vol`/`rsi`/`hv`）のデータ契約を定めた。
これは「エントリー時点の状態」を表す軸で、買い時の良し悪しを*入口の条件*として検証できる。

一方、「買い時の言語化」を進めるには **結果側**（エントリー後にどう動いたか）の指標が要る:
MFE/MAE（保有後の最大含み益・最大含み損）や N営業日後リターンなど。これらは
**日々の終値の時系列**が無いと計算できないが、現行スキーマには終値が含まれていない
（`dev` は乖離率、`vol` は出来高比で、生の価格は復元できない）。

生成器 `tools/gen_indicators.py` は既に `adj_close` をパネルに読み込んでいるため、
**行に終値 `c` を1列足すだけ**で結果メトリクスの計算基盤が整う。スキーマ（`rows` の列）が
変わるため、`TBK-0002` を `Superseded` にして本 ADR で契約を更新する。

## 💡 決定事項（Decision）

`TBK-0002` の方針（監視リスト方式・Python事前計算→銘柄別JSON遅延取得・VolDipSignals同一定義）を
**そのまま継承**し、出力スキーマに 1 列を追加する。

1. **終値を追加**:
   - `c` = 調整後終値（`adj_close`）。小数1桁に丸める。
2. **出力スキーマ `data/indicators/<code4>.json`**（直近約500営業日・日付昇順）:
   ```json
   {
     "code": "6855",
     "updated": "2026-06-05",
     "source": "jquants-data prices (VolDipSignals指標と同一定義)",
     "rows": [ {"d": "2026-06-05", "dev": 0.0139, "abv": true, "vol": 0.66, "rsi": 56.3, "hv": 0.795, "c": 7720.0}, ... ]
   }
   ```
   丸めは `dev` 4桁 / `vol` 2桁 / `rsi` 1桁 / `hv` 3桁 / `c` 1桁。`abv` は真偽値。
3. **用途**: アプリ側で結果メトリクス（MFE/MAE・+5/+20営業日リターン）を `c` の時系列から計算する
   （`TBK-0005`）。引き当て（`lookupSnapshot`）の戻り値や既存の客観バケットは変更しない。
4. その他（監視リスト・遅延取得・派生キャッシュ・「データなし」の劣化動作）は `TBK-0002` を踏襲する。

## 📈 結果・影響（Consequences）

- 終値の時系列が手に入り、エントリー後の値動き（MFE/MAE・N日後リターン）を計算できる。
- `c` を含む既存JSONは日次ジョブで自動的に上書き再生成される（監視リスト銘柄のみ）。
- 旧スキーマ（`c` 無し）の JSON が残っていても、アプリ側は結果メトリクスを「データなし」として
  スキップし劣化動作する。
- **留意**: `c` は調整後終値。約定単価（生）と混在させて%を測るため、起点〜計算終点の間に
  株式分割があると僅かにズレうる（短期20日では稀・調整後は直近≒生）。質的分析には十分。

## 🔧 実行可能チェック（Enforcement）

- 終値出力 `compute_payloads` を `tools/test_gen_indicators.py`（合成データで末尾 `c==120.0`）で検証。
- 結果メトリクス計算は `tests/indicators.test.js`（`computeEntryOutcome`）で検証（`TBK-0005`）。
- スキーマ（列・丸め桁）を変更する場合は本 ADR を `Superseded` にし、新 ADR を起こすこと。

## 関連

- 前身: `docs/adr/TBK-0002-tradebook-entry-snapshot-data-contract-v2.md`
- 結果メトリクスの凍結: `docs/adr/TBK-0005-tradebook-entry-outcome-freeze.md`
- 設計: `docs/plans/2026-06-04-tradebook-entry-rationale-design.md`
