#!/usr/bin/env bash
# TradeBook 場中価格の更新（VPS 用・TBK-0008）
#
# 監視リスト銘柄の場中価格（約20分遅延・表示専用）を Yahoo チャートAPIから取得し、
# orphan ブランチ `intraday` の data/intraday_prices.json へ force-push する。
# main の履歴は汚さない（js/intraday.js が raw URL でこのブランチを読む）。
#
# なぜ VPS か: Yahoo チャートAPI は GitHub Actions の共有IPだとレート制限されやすい
# （fetch_intraday_prices.py が yfinance ライブラリを避けた理由と同じ）。VPS は固定の
# 専用IPなのでスクレイピング相性が良い。Actions（intraday-prices.yml）は
# workflow_dispatch の救済経路として残す（段階移行）。
#
# 設計: 1回叩き切り（15分ループはしない）。cron から15分間隔で発火させる。
#       スクリプト自身が JST の場中セッション（前場 09:00-11:30 / 後場 12:30-15:30）を
#       判定し、場外は取得・push せず正常終了する（cron の TZ に依存しない絶対時刻ゲート）。
#       FORCE=1 で場外でも1回実行（手動確認用）。
#
# 使い方（VPS の crontab。場中を広めにカバーし、スクリプト側で場内だけ push）:
#   */15 0-6 * * 1-5  /opt/tradebook/public-repository/scripts/vps_intraday_update.sh >> /var/log/tradebook_intraday.log 2>&1
#   （00:00-06:59 UTC = 09:00-15:59 JST。前場/後場のみ push・昼休みと場外はスキップ）
#
# 環境変数:
#   TRADEBOOK_REPO_DIR : public-repository のクローン位置（既定: このスクリプトの親の親）
#   FORCE=1            : 場中セッション判定を無視して1回実行（手動確認用）
#
# 終了コード: 0=成功（場外スキップ含む） / 1=取得失敗 / 20=push 失敗 / 22=多重起動スキップ
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${TRADEBOOK_REPO_DIR:-$(dirname "$SCRIPT_DIR")}"
LOCK_FILE="/tmp/tradebook_intraday_update.lock"
LOG_PREFIX() { date '+%Y-%m-%d %H:%M:%S%z'; }

# 多重起動ガード（前回の取得が長引いても15分後の発火と重ならない）
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "$(LOG_PREFIX) 別プロセスが実行中のためスキップします。" >&2
  exit 22
fi

# 場中セッション判定（JST・絶対時刻）。前場 09:00-11:30 / 後場 12:30-15:30。
# UTC で計算して TZ 非依存にする（JST = UTC+9 → 分に換算して判定）。
in_session() {
  local utc_min jst_min
  utc_min=$(( $(date -u +%H) * 60 + $(date -u +%M) ))
  jst_min=$(( (utc_min + 9 * 60) % 1440 ))   # JST の 0:00 からの分
  # 前場 540(09:00)-690(11:30) / 後場 750(12:30)-930(15:30)
  if { [ "$jst_min" -ge 540 ] && [ "$jst_min" -le 690 ]; } \
     || { [ "$jst_min" -ge 750 ] && [ "$jst_min" -le 930 ]; }; then
    return 0
  fi
  return 1
}

if [ "${FORCE:-0}" != "1" ] && ! in_session; then
  echo "$(LOG_PREFIX) 場外（前場/後場のセッション外）のためスキップします。"
  exit 0
fi

cd "$REPO_DIR"

# 取得（fetch_intraday_prices.py は結果が無ければファイルを書かずに正常終了する）
python3 TradeBook/tools/fetch_intraday_prices.py \
  || { echo "$(LOG_PREFIX) 取得スクリプトが非ゼロ終了。今回は push しません。" >&2; exit 1; }

OUT="TradeBook/data/intraday_prices.json"
if [ ! -f "$OUT" ]; then
  echo "$(LOG_PREFIX) 取得結果なし（休場・ソース停止など）。intraday ブランチは更新しません。"
  exit 0
fi

# orphan ブランチ intraday へ force-push（レイアウトは data/ 直下固定＝js/intraday.js の URL と一致）。
# 認証は REPO_DIR の origin リモート（PAT 埋め込み URL or デプロイキー）をそのまま使う。
REMOTE_URL="$(git -C "$REPO_DIR" remote get-url origin)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data"
cp "$OUT" "$WORK/data/"

push_ok=0
for wait in 0 2 4 8; do
  [ "$wait" -gt 0 ] && { echo "$(LOG_PREFIX) push リトライまで ${wait}s 待機..."; sleep "$wait"; }
  if ( cd "$WORK" \
        && git init -q -b intraday \
        && git config user.name "tradebook-vps" \
        && git config user.email "tradebook-vps@localhost" \
        && git add . \
        && git commit -q -m "場中価格を更新（表示専用・TBK-0008・VPS）" \
        && git push --force -q "$REMOTE_URL" intraday ); then
    push_ok=1
    break
  fi
  # 次のリトライは作業ツリーを作り直す（.git を残さない）
  rm -rf "$WORK"/{.git,data}
  mkdir -p "$WORK/data"
  cp "$OUT" "$WORK/data/"
done

if [ "$push_ok" -eq 1 ]; then
  echo "$(LOG_PREFIX) 完了: intraday ブランチへ push しました。"
  exit 0
fi
echo "$(LOG_PREFIX) エラー: intraday ブランチへの push に失敗。次の回で再試行します。" >&2
exit 20
