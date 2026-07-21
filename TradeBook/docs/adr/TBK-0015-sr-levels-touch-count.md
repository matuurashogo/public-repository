# [TBK-0015] 支持線・抵抗線データ契約 v2（タッチ回数=信頼度の追加）

## 📜 ステータス

| 項目 | 値 |
|------|---|
| **Status** | `Superseded` |
| **Date** | 2026-07-20 |
| **Supersedes** | TBK-0014 |
| **Superseded by** | TBK-0017 |

## ❓ コンテキスト（背景と課題）

TBK-0014 の `sr_levels.json` は水準の価格のみで、**どの水準がどれだけ「効いている」か**
（信頼度）の情報が無かった。また表示は現在値からの距離%を付けていたが、ユーザーの
実運用では距離%は不要で、代わりに**水準の信頼度**が欲しいという要望が出た。

HypoLab の S/R 研究（HYP-0005）にはタッチ・反転の検証プロトコルがあり、その簡易版として
「水準の価格帯で取引された回数（タッチ回数）」を信頼度の代理指標に採用できる。

## 💡 決定事項（Decision）

1. **タッチ回数の定義**（`gen_sr_levels.count_touches`・PIT 安全）:
   - 水準の**誕生日以降**の各営業日について、日中レンジ [adj_low, adj_high] を
     ±`touch_band_atr(=0.5)×ATR14` のバンドで拡張し、水準がその中に入れば「タッチ」。
   - 連続した接触は1回に数える（`touch_cooldown(=10)` 営業日スキップ。HYP-0005 の
     band_atr / cooldown_days と同値）。
   - タッチ後の反発までは検証しない（反転統計は HypoLab の領分。ここは軽量な代理指標）。
2. **JSON スキーマ v2（追記のみ・後方互換）**: 各 stock に価格配列と**同順・同長の並行配列**
   `support_touches` / `resistance_touches`（int・0以上）を追加。既存の `support` /
   `resistance`（価格のみ）は不変＝旧クライアントはそのまま動く。`params` に
   `touch_band_atr` / `touch_cooldown` を追加。
3. **表示**: 詳細モーダルの支持線・抵抗線は**距離%をやめ、タッチ回数を表示**する
   （`タッチn回` / 0回は `未検証`）。保有カード・買い時ボードの距離%表示は据え置き
   （一覧では「あとどれだけ」が実用のため）。

## 📈 結果・影響（Consequences）

- どの水準が市場に意識されているかが一目で分かる（タッチ多い=信頼度高い水準）。
- touches が未配信の旧データを読んでも 0 扱いで完走（アプリ側フォールバック）。
- タッチ回数は反発を検証しない単純カウントのため、「何度も試されて最終的に割れた」水準も
  回数は多く出る（限界として明記。反転率ベースの信頼度は将来 HYP-0005 準拠で拡張可能）。

## 📊 Eval 定義（ティアA）

- **対象 (Target)**      : count_touches の PIT 安全性と v2 スキーマ適合
- **成功条件 (Success)**  : (1) 誕生日前の接近を数えない、(2) 連続接触は cooldown で1回に
  まとまる、(3) touches 配列が価格配列と同順・同長・int≥0、(4) 旧契約データでもアプリが完走
- **Grader (採点器)**     : Code。`tools/test_gen_sr_levels.py`（15テスト）＋
  `tests/detail.test.js`（touches 対応・旧データフォールバック）
- **合格閾値 (Threshold)** : 全テスト PASS
- **反例 (Negatives)**    : 誕生日前のタッチが混入（look-ahead）／毎日接触で回数が水増しされる／
  touches と価格の順序がずれる
- **状態 (State)**        : Shipped
  - 2026-07-20: Python 15・JS 130 全 PASS。実 R2 から 11/11 銘柄を v2 契約で再生成
    （基準日 2026-07-17・スキーマ検証 PASS）。実例 5016: 抵抗 3,606 タッチ6回（現在値が
    攻防中の水準ほど回数が多く出る・意図どおり）／支持 3,481 タッチ3回。Chromium 実機で
    モーダルの「タッチn回」表示・距離%の非表示を確認。

## 🔧 実行可能チェック（Enforcement）

```bash
python TradeBook/tools/test_gen_sr_levels.py
cd TradeBook && node --test tests/detail.test.js
TRADEBOOK_DATA_SOURCE=r2 python TradeBook/tools/gen_sr_levels.py
```
