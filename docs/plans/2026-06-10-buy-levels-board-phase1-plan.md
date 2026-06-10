# 買いレベルボード Phase 1 実装計画

- 作成日: 2026-06-10
- ステータス: Implementation Plan（ユーザーの Go サイン待ち）
- 親ドキュメント: `2026-06-10-buy-levels-board-design.md`

---

## ゴール

毎日22時台に (1) `data/buy_levels.json` が自動更新され、(2) TradeBook に「買い時ボード」カードが表示され、(3) 到達/接近銘柄が LINE に届く。

## 実装ステップ

### Step 1: ADR TBK-0006（buy_levels.json データ契約）— public-repository

- `docs/adr/TBK-0006-buy-levels-data-contract.md` を新規作成（Accepted）
- スキーマは設計書 §5 の通り。丸めは TBK-0004 の流儀（価格 小数1桁 / 比率 小数4桁）
- 6レベルの定義・パラメータ（MA25, −5%, −8%, 20日高値−10%/−15%, 60日安値, 接近閾値3%）を契約に含める

### Step 2: `tools/gen_buy_levels.py` — public-repository

- `gen_indicators.py` と同じ流儀で実装:
  - jquants-data の場所は `JQUANTS_PARQUET_REPO` → `../jquants-data` の順で自動検出
  - 対象は `data/indicators_universe.json` の監視リスト銘柄
  - 終値ベース（adj_close）。MA25 / 20日高値 / 60日安値 / 陽転を計算し6レベルを出力
- 出力: `data/buy_levels.json`（1ファイル・監視リスト全銘柄）
- 単体テスト: `tools/` 内のロジックを純関数に切り出し、合成系列でレベル計算・到達/接近判定を検証（`tests/buy_levels.test.js` ではなく Python 側テスト。gen_indicators の既存テスト方式に合わせる※実装時に確認し、なければ `tools/test_gen_buy_levels.py` を追加して CI で実行）

### Step 3: ワークフロー組込 — public-repository

- `.github/workflows/update-prices.yml` の `gen_indicators.py` 実行直後に `python tools/gen_buy_levels.py` を追加（22:00 / 07:30 JST の既存2回実行に乗る）
- 生成物のコミット対象に `data/buy_levels.json` を追加

### Step 4: TradeBook「買い時ボード」カード — public-repository

- 新規 `js/buylevels.js`: `data/buy_levels.json` を fetch し、銘柄×レベル表を描画する純関数群
  - 到達（hit=true）= 緑 / 接近（dist ≤ 3%）= 黄 / それ以外 = 通常
  - 陽転フラグを銘柄行に表示。「到達+陽転」は強調表示
- `app.js` にカードを組み込み（既存カードの追加パターンに従う）
- テスト: `tests/buy_levels.test.js`（`node --test`、判定・整形ロジックを検証）

### Step 5: LINE 通知 — private-repository

- `routines/`（AlphaScorer の AIピック通知と同じ置き場・流儀）に通知スクリプトを追加
  - 入力: 公開リポの `data/buy_levels.json`（raw URL fetch または ローカルクローン参照。実装時に既存ルーチンの流儀へ合わせる）
  - 本文: 設計書 §6 のフォーマット（到達 → 接近 → 変化なし省略）
  - 送信: VolDipSignals `notify.py` と同じ LINE Messaging API
- Claude Routines への登録（毎日22時台・市場サマリーと別枠1通）

### Step 6: ドキュメント・ハーネス

- public: `HANDOFF.md` / `README.md` にボードの説明を追記、PRE_IMPL 系チェックリストがあれば更新
- private: ルーチンの README（ROUTINE.md 相当）に通知の運用を追記
- 検証: public は `npm test`、private は `.agent/harness/lint_check.py` / `smoke_test.py`

## 完了条件

1. ローカルで `python tools/gen_buy_levels.py` → `buy_levels.json` が生成され、テストが PASS
2. TradeBook をローカルで開いてボードが表示される（手動確認）
3. LINE にテスト送信1通（本番ルーチン登録は送信確認後）
4. 全ハーネス PASS、両リポジトリの指定ブランチへプッシュ

## リスク・注意

- **git 履歴の肥大**: buy_levels.json は1ファイル・監視リスト銘柄のみで小さい（indicators の方式に準拠、問題なし）
- **公開リポに置く情報**: レベル価格は公開データ（株価）からの計算値のみ。個人の保有・売買情報は含めない（ウォッチリスト銘柄コード自体は既に indicators_universe.json で公開済みの運用）
- **LINE 認証情報**: private 側のみ。公開側ワークフローには持ち込まない
- **6/10 のような「データ未更新」タイミング**: 通知スクリプトは buy_levels.json の `updated` を本文に明記し、古いデータでの誤判断を防ぐ
