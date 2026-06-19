#!/bin/bash
# run-harness.sh
# PostToolUse Hook から自動で呼び出されるハーネス実行スクリプト。
# Write/Edit 後に TradeBook の単体テストを実行し、Agentic Flywheel を回す。
#
# TradeBook はテストが JavaScript（node --test）主体で、補助ツールが Python。

APP_DIR="$CLAUDE_PROJECT_DIR/TradeBook"

if [ ! -d "$APP_DIR" ]; then
  echo "[Harness] TradeBook ディレクトリが見つかりません。スキップします。"
  exit 0
fi

# --- JS 単体テスト（主） ---
if command -v node &> /dev/null; then
  if ls "$APP_DIR"/tests/*.test.js &> /dev/null; then
    echo "[Harness] Running JS tests (node --test)..."
    ( cd "$APP_DIR" && node --test tests/*.test.js ) 2>&1
  fi
else
  echo "[Harness] node not found, skipping JS tests."
fi

# --- Python ツールテスト（補・存在するものだけ） ---
if command -v python &> /dev/null; then
  for t in "$APP_DIR"/tools/test_*.py; do
    [ -e "$t" ] || continue
    echo "[Harness] Running $(basename "$t")..."
    python "$t" 2>&1 || echo "[Harness] $(basename "$t") が失敗（依存欠如の可能性）。"
  done
else
  echo "[Harness] Python not found, skipping Python tool tests."
fi

echo "[Harness] Done."
