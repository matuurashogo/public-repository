# [TBK-0017] 支持線・抵抗線データ契約 v3（反発率＝信頼度）

## 📜 ステータス

| 項目 | 値 |
|------|---|
| **Status** | `Accepted` |
| **Date** | 2026-07-20 |
| **Supersedes** | TBK-0015 |
| **Superseded by** | — |

## ❓ コンテキスト（背景と課題）

TBK-0015 のタッチ回数は「その価格帯に何回近づいたか」の単純カウントで、**そこで実際に
反発したか（＝本当に効いたか）を検証していなかった**。ユーザーから「タッチは何回なら
精度が高いのか」という問いがあり、回数だけでは信頼度として弱いことが明確になった
（例: 何度も試されて結局割れた水準も回数は多く出る）。

HypoLab の S/R 研究（HYP-0005）の `detect_touches` / `classify_outcome` は、
**バンド外からの接近**を厳密にタッチとして検出し、タッチ後に反発したか／ブレイクしたかを
判定する。これを移植して**反発率**を出せば、より本物の信頼度になる。

## 💡 決定事項（Decision）

1. **タッチ定義を厳密化（HYP-0005 detect_touches 準拠）**: TBK-0015 の「毎日バンド内か」から
   **「前日終値がバンド外 かつ 当日レンジがバンドに触れる（＝外からの接近）」**へ変更。
   連続日は `touch_cooldown(=10)` で1回に数える。これにより「ジリジリ貼り付いていた」だけの
   水増しカウントが排除される（フラット系列はタッチ0）。
2. **反発判定（HYP-0005 classify_outcome の reversal 部分）**: タッチ後 `react_days(=5)` 日以内に、
   逆方向へ `reversal_atr(=1.0)×ATR` 動き、かつバンドの向こうへ終値が抜けなかったら「反発」。
   - 抵抗（下から接近）: 安値が touch 終値 − 1.0×ATR まで下押し ∧ 終値が level+band を超えない。
   - 支持（上から接近）: 高値が touch 終値 + 1.0×ATR まで上昇 ∧ 終値が level−band を割らない。
3. **JSON スキーマ v3（追記のみ・後方互換）**: 各 stock に `support_reversals` /
   `resistance_reversals`（価格・touches と同順同長の並行配列・0 ≤ reversals ≤ touches）を追加。
   `params` に `reversal_atr` / `react_days` を追加。**反発率 = reversals / touches は
   クライアント側で算出**（touches=0 は null＝未検証）。
4. **表示**: 詳細モーダルの支持線・抵抗線は「**反発 r/t（xx%）**」を表示（0タッチは「未検証」）。
   反発率で色分け（≥60% 緑=強い / 40–59% 橙 / <40% 灰）。

## 📈 結果・影響（Consequences）

- 「タッチは多いが反発率が低い＝実は弱い」水準を見抜ける（実例 6855: 抵抗 6,350 は
  タッチ6回だが反発3回=50%、直上の 6,080 は反発0%）。距離%より遥かに実用的な信頼度になった。
- タッチ定義の厳密化で、TBK-0015 時点のタッチ回数とは値が変わる（外からの接近のみを数える）。
- 反発率は「その後の値動き react_days 日」を使うため、**最新数日に生まれたばかりの接近は
  反発判定が未確定**になりうる（タッチにはカウントされるが reversal は付きにくい）。限界として明記。
- 旧データ（reversals 無し）を読んでも 0 扱いで完走。

## 📊 Eval 定義（ティアA）

- **対象 (Target)**      : count_touches（接近検出＋反発判定）の PIT 安全性と v3 スキーマ適合
- **成功条件 (Success)**  : (1) 外からの接近のみタッチ（フラット系列=0）、(2) 反発した接近を
  reversal に数え、割れた接近は数えない、(3) 誕生日前の接近は0、(4) reversals 配列が
  価格・touches と同順同長で 0≤rev≤touch、(5) 旧データでアプリ完走
- **Grader (採点器)**     : Code。`tools/test_gen_sr_levels.py`（16テスト・接近/反発/PIT）＋
  `tests/detail.test.js`（反発率算出・未検証・上値メド）
- **合格閾値 (Threshold)** : 全テスト PASS・0≤reversals≤touches を実データ全銘柄で満たす
- **反例 (Negatives)**    : 貼り付き（バンド内継続）をタッチに数える／割れたのに反発とする／
  reversals が touches を超える／誕生日前のタッチ混入
- **状態 (State)**        : Shipped
  - 2026-07-20: Python 16・JS 132 全 PASS。実 R2 から 11/11 銘柄を v3 契約で再生成。
    実例 6855: 抵抗 6,350 反発 3/6（50%）・6,470 反発 1/1（100%）・6,080 反発 0/1（0%）。
    Chromium 実機でモーダルの反発率表示・色分けを確認。

## 🔧 実行可能チェック（Enforcement）

```bash
python TradeBook/tools/test_gen_sr_levels.py
cd TradeBook && node --test tests/detail.test.js
TRADEBOOK_DATA_SOURCE=r2 python TradeBook/tools/gen_sr_levels.py
```
