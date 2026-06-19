# ハーネス実行ルール (Harness Engineering)

## Agentic Flywheel の考え方

コードを変更・追加・削除したら、必ず以下の検証を行ってください。
エラーが出た場合はユーザーの承認を待たず、自律的に代替案で修正を試みること（自己修正ループ）。
自力で解決できない場合は状況をユーザーに報告してください。

TradeBook は **テストが JavaScript 主体**（`node --test`）で、データ生成ツールが Python です。
PostToolUse Hook（`.claude/hooks/run-harness.sh`）が Write/Edit 後に自動でこれらを実行します。

## JS 単体テスト（主）

```bash
cd TradeBook && node --test tests/*.test.js
```

`TradeBook/package.json` は `type: module`。`npm test` でも同じ。
損益計算（`pnl.js`）・KPI・買いレベル（`buylevels`）・在庫整合性などの純粋関数を検証する。

## Python ツールテスト（補）

```bash
# pandas 等が必要なものあり。存在するものだけ実行される。
python TradeBook/tools/test_gen_indicators.py
python TradeBook/tools/test_gen_buy_levels.py
python TradeBook/tools/test_gen_volatility.py
python TradeBook/tools/test_fetch_intraday_prices.py
python TradeBook/tools/test_sync_universe_from_drive.py
python TradeBook/tools/test_tsureyasu.py
```

## エラー時の対応ルール

1. エラーメッセージを読み、根本原因を特定する。
2. 代替実装で自己修正を試みる（最大3回）。
3. 解決した場合: 変更内容をサマリーとしてユーザーに報告する。
4. 解決しない場合: 状況をユーザーに報告する。
