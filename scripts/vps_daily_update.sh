#!/usr/bin/env bash
# TradeBook 日次データ更新（VPS 用・TBK-0013/0014）
#
# quant-data-platform の日次アーカイブ（qdp daily --publish --backend r2）完了後に
# 実行し、R2 の silver 表から TradeBook のデータ JSON を再生成してコミット・push する。
# push は PAT/デプロイキー経由のため deploy-pages.yml（push トリガー）が自動起動し、
# GitHub Pages のライブ反映まで完結する（Actions の明示 dispatch は不要）。
#
# GitHub Actions（update-prices.yml）と同じ差分判定・sw.js 版数バンプを行う。
# Actions は workflow_dispatch の救済経路として残す（本スクリプトの障害時に手動実行）。
#
# 使い方（VPS の cron。qdp_daily.sh の後段に連結する例）:
#   45 20 * * 1-5  /opt/qdp/quant-data-platform/scripts/qdp_daily.sh && \
#                  /opt/tradebook/public-repository/scripts/vps_daily_update.sh
#
# 環境変数:
#   TRADEBOOK_REPO_DIR : public-repository のクローン位置（既定: このスクリプトの親の親）
#   TRADEBOOK_ENV_FILE : R2_* を含む .env（既定: /opt/qdp/secrets/.env。qdp と共用）
#   GDRIVE_SA_JSON / TRADEBOOK_DRIVE_FILE_ID : 監視リスト自動同期（任意。無ければスキップ）
#
# 終了コード: 0=成功（変更なし含む） / 1=生成失敗 / 20=push 失敗 / 22=多重起動スキップ
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${TRADEBOOK_REPO_DIR:-$(dirname "$SCRIPT_DIR")}"
ENV_FILE="${TRADEBOOK_ENV_FILE:-/opt/qdp/secrets/.env}"
LOCK_FILE="/tmp/tradebook_daily_update.lock"
LOG_PREFIX() { date '+%Y-%m-%d %H:%M:%S%z'; }

# 多重起動ガード（cron 遅延・手動実行の重複防止）
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "$(LOG_PREFIX) 別プロセスが実行中のためスキップします。" >&2
  exit 22
fi

cd "$REPO_DIR"

# R2 資格情報（qdp と同じ .env を read-only で共用。GLOB-0005: 値はログに出さない）
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
else
  echo "$(LOG_PREFIX) 警告: ENV_FILE が見つかりません（$ENV_FILE）。環境変数直接指定を前提に続行します。" >&2
fi
export TRADEBOOK_DATA_SOURCE=r2

echo "$(LOG_PREFIX) TradeBook 日次更新を開始（repo: $REPO_DIR / source: r2）"

# リモートの最新に追従（Actions 救済実行との競合を防ぐ。ローカル変更があれば中断）
git fetch origin main
if ! git merge-base --is-ancestor HEAD origin/main && ! git merge-base --is-ancestor origin/main HEAD; then
  echo "$(LOG_PREFIX) エラー: ローカルとリモートが分岐しています。手動で解消してください。" >&2
  exit 1
fi
git checkout main >/dev/null 2>&1
git pull --ff-only origin main

# 生成（失敗したらそこで exit 1。gen_sr_levels は R2 必須のためここで初めて日次化できる）
python3 TradeBook/tools/gen_prices.py
python3 TradeBook/tools/sync_universe_from_drive.py || true  # Secret 未設定はスクリプト側でスキップ
python3 TradeBook/tools/gen_indicators.py
python3 TradeBook/tools/gen_buy_levels.py
python3 TradeBook/tools/gen_volatility.py
python3 TradeBook/tools/gen_sr_levels.py

# 差分判定（update-prices.yml と同一: 変更＋新規の両方を porcelain で見る）
DATA_PATHS=(
  TradeBook/data/latest_prices.json
  TradeBook/data/indicators
  TradeBook/data/indicators_universe.json
  TradeBook/data/buy_levels.json
  TradeBook/data/volatility.json
  TradeBook/data/sr_levels.json
)
if [ -z "$(git status --porcelain -- "${DATA_PATHS[@]}")" ]; then
  echo "$(LOG_PREFIX) 価格・指標・監視リストに変更なし（休市日など）。コミットしません。"
  exit 0
fi

# sw.js のキャッシュ版数を +1（PWA に新データを確実に配信する）
current=$(grep -oE 'tradebook-shell-v[0-9]+' TradeBook/sw.js | grep -oE '[0-9]+$')
next=$((current + 1))
sed -i "s/tradebook-shell-v${current}/tradebook-shell-v${next}/" TradeBook/sw.js
echo "$(LOG_PREFIX) sw cache: v${current} -> v${next}"

date_str=$(python3 -c "import json;print(json.load(open('TradeBook/data/latest_prices.json'))['date'])")
git add "${DATA_PATHS[@]}" TradeBook/sw.js
git commit -m "最新終値・エントリー指標・監視リスト・支持線を更新（基準日 ${date_str}）"

# push（ネットワーク一時障害に備え指数バックオフで最大4回リトライ）
for wait in 0 2 4 8 16; do
  [ "$wait" -gt 0 ] && { echo "$(LOG_PREFIX) push リトライまで ${wait}s 待機..."; sleep "$wait"; }
  if git push origin main; then
    echo "$(LOG_PREFIX) 完了: push 成功（deploy-pages.yml が自動起動します）"
    exit 0
  fi
done
echo "$(LOG_PREFIX) エラー: push に失敗しました。次回実行時に再試行されます。" >&2
exit 20
