# TradeBook エントリー根拠 Phase 1 実装計画

- 日付: 2026-06-04
- 対象: 公開リポジトリ（TradeBook 本体・クライアント完結）
- 設計: `docs/plans/2026-06-04-tradebook-entry-rationale-design.md`
- 方針: パイプライン非依存。タグ入力 ＋ 入口/出口タグ別成績まで。客観スナップショット（Phase 2）は含めない。

## ゴール（Phase 1 の完成条件）

1. 買いに `entryTag`/`entryNote`、売りに `exitTag`/`exitNote` を入力・編集・保存できる。
2. タグ候補（`entryTags`/`exitTags`）を seed し、アプリ上で追加できる。
3. 「エントリー型別成績」カードで **入口タグ別／出口タグ別** に
   売却回数・勝率・平均利益/損失・期待値・合計損益を表示できる。
4. 入口タグ別は FIFO で売り→買いロットへ遡って帰属（1:1 は厳密、分割は株数按分）。
5. 既存テストが緑のまま、新規テストも緑。

## 変更ファイル一覧

| ファイル | 変更概要 |
|---|---|
| `js/store.js` | version 2→3、タグ seed、`normalizeTrade` 拡張、マージ時のタグ和集合 |
| `js/pnl.js` | `entryTagAttribution`（FIFO）、`tagBreakdown`（入口/出口）を追加 |
| `index.html` | フォームにタグ chips＋メモ欄、型別成績カードを追加 |
| `js/app.js` | フォーム入出力・タグ chips 描画・型別成績描画・タグ追加 |
| `css/style.css` | chips・badge・型別成績テーブルのスタイル |
| `tests/tag_breakdown.test.js` | 新規。FIFO 帰属・入口/出口集計 |
| `tests/store.test.js` | seed と和集合マージのケース追加 |
| `README.md` | 機能追記 |

## ステップ詳細

### Step 1: データモデル（`js/store.js`）

- `MASTER_VERSION = 2` → `3`。
- `emptyMaster()` に `entryTags`/`exitTags` の seed を追加:
  - entry: `["25日線タッチ","深押し（節目）","高ボラ急落リバウンド","ブレイク後の押し目","出来高急増の反発","決算・材料","なんとなく（裁量）"]`
  - exit: `["利確（目標到達）","利確（急騰で伸びた）","損切り（ルール通り）","損切り（耐えきれず）","時間切れ・見切り","地合い悪化で回避"]`
- `normalizeTrade()`: `entryTag:null, entryNote:null, exitTag:null, exitNote:null` を欠損時のみ補う（既存値は尊重）。
- `normalizeMaster()`: `entryTags`/`exitTags` が配列でなければ seed を補う。
- `mergeMasters()`: record マージ後に `entryTags`/`exitTags` を**和集合**で統合
  （順序は既存＋新規追加分を末尾に。端末ごとに足したタグを失わない）。
- `Store` に `addEntryTag(tag)`/`addExitTag(tag)` を追加（重複は無視・`_writeCache`）。

### Step 2: 集計ロジック（`js/pnl.js`・純粋関数）

- `entryTagAttribution(trades)`: `holdingDaysBySell` と同型の FIFO ロット待ち行列を作るが、
  各買いロットに `entryTag` を保持。売りごとに消費した各ロットについて
  `{ sellTradeId, entryTag, qty, pnlShare }` を返す。`pnlShare` は当該売りの実現損益
  （`calcRealized` の `records[].pnl`）を株数比で按分。1:1 売買では 1 売り＝1 エントリーで全額。
- `tagBreakdown(trades, axis)`:
  - `axis="exit"`: `calcRealized().records` を `売りの exitTag` で直接グループ化（FIFO 不要）。
  - `axis="entry"`: `entryTagAttribution` の結果をタグでグループ化。
  - 各グループの指標: `count`（売却回数・按分時は実数）、`winRate`、`avgWin`、`avgLoss`、
    `expectancy`、`totalPnl`。勝敗は pnlShare の符号で判定。タグ `null` は「未設定」グループへ。
  - 既存 `calcKpis` の定義（勝率＝勝÷全、期待値＝合計÷件数）と一致させる。

### Step 3: 入力 UI（`index.html`）

- フォームに2ブロック追加（`side` トグルで出し分け）:
  - 買い用: 「エントリー根拠」chips（`#entry-tags`）＋ メモ（`#f-entry-note`）
  - 売り用: 「手仕舞い根拠」chips（`#exit-tags`）＋ メモ（`#f-exit-note`）
  - 各 chips 末尾に「＋新規」入力。
- 「保有銘柄」カードの後あたりに新カード「**エントリー型別成績**」（`#tag-breakdown`）。
  軸トグル（入口タグ別／出口タグ別）＋テーブル。

### Step 4: アプリ統合（`js/app.js`）

- 状態: `currentEntryTag`/`currentExitTag` を追加。
- `renderTagChips()`: `store.getMaster().entryTags/exitTags` から chips 描画・選択状態反映。
- `openForm(trade)`: 編集時に `entryTag/entryNote/exitTag/exitNote` を復元。
- `setSide()`: 買い/売りで tag ブロックを出し分け。
- `onSubmit()`: trade に side に応じて `entryTag/entryNote` か `exitTag/exitNote` を載せる
  （反対側のフィールドは付けない）。
- `renderTagBreakdown()`: `tagBreakdown` の結果をテーブル描画（`renderAll` から呼ぶ）。軸トグル結線。
- `renderList()`: 各行にタグ badge を表示（買い＝entryTag・売り＝exitTag）。
- 「＋新規」: `store.addEntryTag/addExitTag` → 再描画 → `saveToDrive()`。
- 入力テキストは既存 `esc()` でエスケープ（メモ欄の XSS 対策）。

### Step 5: スタイル（`css/style.css`）

- `.tag-chips`/`.tag-chip`（選択状態）、`.tag-badge`、`#tag-breakdown` テーブル、軸トグル。
  既存 `.seg`/`.kpi-*`/`.acct-toggle` のトークンを流用。

### Step 6: テスト

- `tests/tag_breakdown.test.js`（新規）:
  - 入口 1:1: 買い(tagA)→売り → tagA に全額・正しい勝率。
  - 入口 分割: 2回買い(tagA/tagB)→1回売り → 株数按分で両タグに配分。
  - 出口: 売りの exitTag 直接集計。
  - `null` タグの「未設定」グループ化。
- `tests/store.test.js`（追記）:
  - version3 seed の付与、旧データ（tag 無し）の正規化、マージ時のタグ和集合。
- 実行: `node --test tests/`、ハーネス `lint_check.py`/`smoke_test.py`。

### Step 7: ドキュメント

- `README.md` の「主な機能」に入口/出口タグと型別成績を追記。「スコープ外」から該当項目を移動。

## 留意点・非対象

- スナップショット（客観3軸）・Python パイプライン・ADR は **Phase 2** で対応（本計画では対象外）。
- タグは単一選択・フラット（複数選択や階層は将来）。
- 平均法 vs FIFO の差は分割売買時のみ。カードに注記を出す。
- `MASTER_VERSION` 引き上げに伴う後方互換は `normalize*` で吸収し、旧データを破壊しない。

## 実装順序（推奨）

1. Step 1（store）→ 2（pnl）→ Step 6 の対応テストを先に書いて緑化（ロジックを固める）。
2. Step 3〜5（UI）。
3. Step 7（README）。
4. 全テスト＋ハーネス通過を確認してコミット・プッシュ。
