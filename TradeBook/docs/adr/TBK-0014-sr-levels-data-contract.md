# [TBK-0014] 支持線・抵抗線のデータ契約（sr_levels.json）

## 📜 ステータス

| 項目 | 値 |
|------|---|
| **Status** | `Superseded` |
| **Date** | 2026-07-19 |
| **Supersedes** | — |
| **Superseded by** | TBK-0015 |

## ❓ コンテキスト（背景と課題）

買い時ボード（TBK-0006）の L6 は「直近60日最安**終値**」をサポートラインの**代理**として
使ってきた。本物のスイング支持線・抵抗線には高値・安値が必要だが、jquants-data には
終値系しか無かったためである。TBK-0013 のデータソース切替により、QDP R2 の
`fact_prices_daily` から**調整後四本値（adj_high / adj_low・QDP-0040 権威導出）**が
読めるようになり、この制約が解消した。

支持線・抵抗線の定義には、HypoLab で検証済みの S/R エンジン（`srlevels.py`・HYP-0005
共通プロトコル）の**スイング水準**を採用する。HypoLab サポートライン台帳第1弾
（HYP-0021）の知見も踏まえる:

- 採用: **スイング水準**（HYP-0005 の基盤定義。タッチ・反転統計の土台として検証済み）
- 不採用: 回転率減衰 Volume Profile（H163 ❌不支持）・ネットキャッシュ床（H170 ❌不支持）
- 将来拡張: レジーム依存の強弱表示（H178 ✅支持「支持は平均回帰局面でのみ効く」）・
  アンカードVWAP床（H162 ⚠️部分支持）は本契約の改訂候補として記録するに留める。

## 💡 決定事項（Decision）

1. **生成方式は TBK-0006 の流儀を踏襲**: 監視リスト（`data/indicators_universe.json`）の
   銘柄のみを対象に、`tools/gen_sr_levels.py` が調整後四本値からスイング水準を事前計算し、
   `data/sr_levels.json` 1ファイルに出力する。**入力は TRADEBOOK_DATA_SOURCE=r2 必須**
   （adj_high/adj_low は R2 のみ。local 実行は明示エラー・exit 2）。
2. **水準定義（HypoLab config [sr] の検証済みパラメータと一致させる）**:
   - スイング高値/安値: 前後 `swing_n=4` 日より突出し、プロミネンス ≥ `0.5 × ATR14` の極値。
   - **誕生日 = 極値日 + swing_n 日**（確定遅延・look-ahead 排除＝PIT 安全）。
   - 寿命 `life_days=120` 営業日。±`merge_pct=1%` の重複水準は古い方に統合。
   - 支持/抵抗の役割は固定しない: **現在値より下＝支持線・上＝抵抗線**（役割転換を自然に含む）。
   - 高安欠損日は終値で埋める（TR が過小になり水準は減る方向＝誤検出しない保守側）。
3. **JSON スキーマ**:
   ```json
   {
     "updated": "YYYY-MM-DD",
     "source": "qdp-r2 fact_prices_daily (調整後四本値)",
     "params": { "swing_n": 4, "prom_atr": 0.5, "life_days": 120,
                 "merge_pct": 0.01, "atr_window": 14, "max_levels": 3 },
     "stocks": [ { "code": "7203", "close": 3000,
                   "support": [2900, 2750], "resistance": [3100, 3250] } ]
   }
   ```
   - `support`: 現在値より下の有効水準・**近い順（降順）**・最大 `max_levels` 本。
   - `resistance`: 現在値より上の有効水準・**近い順（昇順）**・最大 `max_levels` 本。
   - 価格は調整後価格空間・小数1桁丸め。
4. **表示（表示専用・判定に使わない）**:
   - 保有銘柄カード: 「支持/抵抗」列に現在値に最も近い R（抵抗・上段）/ S（支持・下段）と
     距離%。場中価格が水準を跨いだ場合は `nearestSr()` がクライアント側で振り分け直す。
   - 買い時ボード: 「支持線」「抵抗線」列（L レベルと同型の価格＋距離セル）。判定基準は
     他レベルと同じく**終値**。
   - `sr_levels.json` 未配信時は列・セルを出さない（劣化動作・後方互換）。
5. **禁止事項**: 本データを実現損益・税・通知判定に混ぜない（表示専用）。L1〜L6（TBK-0006）の
   定義・配信は変更しない（L6 の代理サポートは当面併存させ、置換の是非は運用後に別 ADR で判断）。

## 📈 結果・影響（Consequences）

- 買い時ボードに「本物の」支持線、保有カードに利確目標（TBK-0010）と並ぶ抵抗線の目安が加わる。
- 生成は R2 依存のため、当面は VPS / 手動実行で配信する（Actions の local 経路では生成不可。
  update-prices.yml への組み込みは Actions の R2 切替と同時に行う）。
- HYP-0021 の知見（レジーム依存等）を将来この契約の改訂として取り込める。

## 📊 Eval 定義（ティアA）

- **対象 (Target)**      : gen_sr_levels.py のスイング水準生成と sr_levels.json 契約
- **成功条件 (Success)**  : (1) スイング判定・統合・寿命が HypoLab srlevels と同一定義、
  (2) 誕生日 = 極値日 + swing_n（look-ahead 0）、(3) 出力 JSON がスキーマ適合し
  support/resistance が現在値との位置関係・近い順ソートを満たす
- **Grader (採点器)**     : Code。`tools/test_gen_sr_levels.py`（11 テスト: PIT 誕生日・
  プロミネンス棄却・統合・失効除外・スキーマ）＋ `tests/srlevels.test.js`（表示側 6 テスト）
- **合格閾値 (Threshold)** : 全テスト PASS（スキーマ適合・PIT 違反 0）
- **反例 (Negatives)**    : 極値日当日に水準が誕生する（look-ahead）／失効水準が表示される／
  現在値より上の水準が support に混じる／プロミネンス未満の微小スパイクが水準になる
- **状態 (State)**        : Running
  - 2026-07-19 実測: Python 11 テスト・JS 6 テスト全 PASS。合成高安スタブ（実データ300日規模）で
    監視リスト 11/11 銘柄の生成成功・local 実行は明示エラー（exit 2）を確認。
  - 2026-07-20 **実 R2 初回生成**: 本物の adj_high/adj_low（QDP-0040）から 11/11 銘柄・
    基準日 2026-07-17 で生成成功。スキーマ検証 PASS（全銘柄で 支持<現在値<抵抗・近い順ソート）。
    初回の `data/sr_levels.json` として同梱。アプリ上の表示の目視確認は Pages 反映後に行うこと。

## 🔧 実行可能チェック（Enforcement）

```bash
python TradeBook/tools/test_gen_sr_levels.py
cd TradeBook && node --test tests/srlevels.test.js

# 生成（要 R2。ミラー検証は TRADEBOOK_R2_URL_BASE でも可）
TRADEBOOK_DATA_SOURCE=r2 python TradeBook/tools/gen_sr_levels.py
```
