# [TBK-0012] 連れ安度の2段化（confirmed / candidate 観測層の追加）

## 📜 ステータス

| 項目 | 値 |
|------|---|
| **Status** | `Accepted` |
| **Date** | 2026-06-17 |
| **Supersedes** | TBK-0009 |
| **Superseded by** | — |
| **関連** | TBK-0006（買いレベルのデータ契約・§7 較正ループ） |

## ❓ コンテキスト（背景と課題）

TBK-0009 で導入した連れ安度バッジ（tsureyasu）は、リリース以降アプリ上で一度も表示されたことが
なかった。原因を調査したところ、表示・CI・コードのいずれの不具合でもなく、**急落イベントが一度も
成立していない**ためと判明した。

事実関係:

- コミット済み `data/buy_levels.json`（監視11銘柄）の `tsureyasu` キーは常に 0 件。
- 監視銘柄の直近5営業日下落率（r5）は最大でも **−6.06%**。発火ゲート（hard_drop −15%）まで
  約9%の開きがある。
- σルール（`r5 ≤ −3σ√5`）は本ユニバースでは閾値が **−17%〜−36%** に着地し、全銘柄で
  hard_drop(−15%) より深い。日次σが高い（2.5〜5.4%）ためで、σルールは先に発火する余地がなく
  実質デッドロジック。実効ゲートは常に hard_drop(−15%) 単独。

つまり連れ安度は「−15%級の急落」という稀なイベントでしか発火せず、TBK-0006 §7 の較正ループに
必要なデータが永遠に貯まらない構造になっていた。

緩和の際に守るべき制約は「数字」ではなく「検証ドメイン」である。H84（HYP-0015）が検証したのは
「**急落が起きた銘柄に限り**、連れ安は個別急落よりリバウンドしやすい」という残差の優位性であり、
`−15% / −3σ` の急落ゲート自体は HYP-0011 由来の入口にすぎない。ゲートを緩めて H84 が未検証の
軽い下げにまで「連れ安 / 個別急落」判定を付けると、検証結果と乖離する。

## 💡 決定事項（Decision）

連れ安度を **2段** に分ける。検証済みの主張（confirmed）は一切変えず、その下に較正用の観測層
（candidate）を足す。

### 1. confirmed（検証済み層・TBK-0009 を据置）

急落イベント成立（`r5 ≤ −15%` または `r5 ≤ −3σ√5 かつ r5 ≤ −5%`）の銘柄に、残差で
**連れ安 / 個別急落** を判定して付与する。判定ロジック・パラメータ（`sigma_mult=3.0` /
`hard_drop=−0.15` / `min_crash_drop=−0.05` / `tsureyasu_resid_threshold=−0.03`）は TBK-0009 のまま。

### 2. candidate（観測層・新規）

急落イベント未成立だが `r5 ≤ candidate_drop` の銘柄に、**tag を付けず生 resid のみ**を付与する。

- 新パラメータ `candidate_drop = −0.08`（**暫定・較正対象**）。−8% は L3（25日線−8%）と意味が揃う
  水準。フラット閾値とする。
- σ連動（−2σ 等）は高ボラ株では結局深くなり頻度が出ないため採用しない。
- candidate は検証範囲外のため、連れ安 / 個別急落の判定（tag）は出さない（決め打ちしない）。

### 3. 出力スキーマ（`data/buy_levels.json` への変更・後方互換）

`tsureyasu` に `tier` フィールドを追加する。

```json
"tsureyasu": {
  "tier": "confirmed" | "candidate",
  "event": <tier == "confirmed">,
  "self_r5": -0.09,
  "sector": "3650",
  "sector_r5": -0.05,
  "resid": -0.04,
  "tag": "個別急落" | null
}
```

- `event` は後方互換のため残す（既存の読み手は `event` を見て色バッジ表示を決める）。
  `tier=="confirmed"` のとき true、candidate は false。
- `tag` は confirmed のみ（連れ安 / 個別急落）。candidate は `null`（検証主張なし）。
- 候補にも満たない（`r5 > candidate_drop` かつ非イベント）銘柄、または業種データが無く分類
  できない銘柄では **キー自体を出さない**（後方互換）。

### 4. 表示

- confirmed: 既存の色バッジ（🟢連れ安 / 🔴個別急落）。`tsureyasuBadge` は `event && tag` を
  要求するため candidate には自然に出ない。
- candidate: 新規の中立チップ（👀観測 ＋ 業種差 resid、グレー）。色・連れ安 / 個別の語は使わない。
- LINE通知: confirmed のみ（据置）。candidate は通知しない（ノイズ抑制）。

### 5. 較正への接続（TBK-0006 §7）

candidate の生 resid（self_r5 / sector_r5 / resid）が JSON に蓄積される。買い記録との突合で
「−8%域でも連れ安（resid≈0）が個別急落より戻すか」をデータ検証し、保てば将来 candidate→confirmed
昇格、または `candidate_drop` / `tsureyasu_resid_threshold` の主しきいを確定する。これにより
TBK-0009 の検証ドメインを侵さずに、乖離を**測定可能**にする。

## 🚫 スコープ外（YAGNI）

- σ係数（`sigma_mult`）の変更。
- LINE への candidate 通知。
- 中間グレーを含む3値分類。
- 自動発注・証券会社 API 連携。

## ✅ Enforcement（検証）

- 連れ安度の純粋関数（`build_tsureyasu` 他）は `tools/test_tsureyasu.py` で検証する
  （tier 判定 confirmed/candidate/該当なし、candidate は tag=null・resid あり）。
- 表示側（`tsureyasuBadge` / `tsureyasuCandidate`）は `tests/buy_levels.test.js` で検証する
  （candidate は中立チップで色バッジを出さない、confirmed は従来どおり）。
