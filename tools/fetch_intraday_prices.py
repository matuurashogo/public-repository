#!/usr/bin/env python3
"""場中価格を取得して data/intraday_prices.json を生成する（TBK-0008・表示専用）。

対象は監視リスト（data/indicators_universe.json）の銘柄のみ。
ソースは Yahoo チャートAPI（約20分遅延・非公式）。yfinance ライブラリは GitHub Actions の
共有IPでレート制限されるため使わず、チャートAPIを UA 付きで直接叩く（2026-06-11 調査）。

このジャンルの無料ソースは数ヶ月単位で死ぬ（stooq が実例）ため、ソースはクラス単位で
差し替え可能にしてある。全滅した場合はファイルを書かずに正常終了し（CI を赤くしない）、
読み手は古い asOf を検知して終値表示へフォールバックする。

使い方:
    python3 tools/fetch_intraday_prices.py
"""

from __future__ import annotations

import json
import re
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
PUBLIC_ROOT = HERE.parent
UNIVERSE_FILE = PUBLIC_ROOT / "data" / "indicators_universe.json"
OUT_FILE = PUBLIC_ROOT / "data" / "intraday_prices.json"

JST = timezone(timedelta(hours=9))
REQUEST_INTERVAL_SEC = 1.0  # 連続リクエストの間隔（行儀よく・BAN回避）
_CODE_RE = re.compile(r"[0-9][0-9A-Z]{3}")

# ブラウザ相当の UA を付けないと bot 扱いで弾かれることがある
_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)"


def load_universe() -> list[str]:
    """監視リスト（4桁コード）を読む。重複・不正コードは除く（gen_buy_levels.py と同一）。"""
    data = json.loads(UNIVERSE_FILE.read_text(encoding="utf-8"))
    codes = data.get("codes", []) if isinstance(data, dict) else []
    out: list[str] = []
    seen: set[str] = set()
    for c in codes:
        c4 = str(c)[:4]
        if _CODE_RE.fullmatch(c4) and c4 not in seen:
            seen.add(c4)
            out.append(c4)
    return out


def extract_price(payload: dict) -> float | None:
    """Yahoo チャートAPI のレスポンスから最新価格を取り出す純粋関数（テスト対象）。"""
    try:
        meta = payload["chart"]["result"][0]["meta"]
        price = meta.get("regularMarketPrice")
        return float(price) if price is not None and float(price) > 0 else None
    except (KeyError, IndexError, TypeError, ValueError):
        return None


class YahooChartSource:
    """Yahoo チャートAPI 直叩き（約20分遅延）。差し替え時はこのクラスと同じ形で追加する。"""

    name = "yahoo_chart"

    def fetch(self, code4: str) -> float | None:
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{code4}.T?range=1d&interval=15m"
        req = urllib.request.Request(url, headers={"User-Agent": _UA})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001 - 1銘柄の失敗で全体を止めない
            print(f"  - {code4}: 取得失敗 ({e})", file=sys.stderr)
            return None
        return extract_price(payload)


def build_payload(prices: dict[str, float | None], source: str, as_of: datetime) -> dict:
    """出力 JSON（TBK-0008）を組み立てる純粋関数（テスト対象）。失敗銘柄はキーを出さない。"""
    return {
        "asOf": as_of.isoformat(timespec="seconds"),
        "source": source,
        "prices": {code: round(float(p), 1) for code, p in prices.items() if p is not None},
    }


def main() -> int:
    codes = load_universe()
    if not codes:
        print("監視リストが空です。何もしません。")
        return 0

    source = YahooChartSource()
    prices: dict[str, float | None] = {}
    for i, code in enumerate(codes):
        if i > 0:
            time.sleep(REQUEST_INTERVAL_SEC)
        prices[code] = source.fetch(code)

    payload = build_payload(prices, source.name, datetime.now(JST))
    got = len(payload["prices"])

    if got == 0:
        # 全滅 = ソースが死んでいる可能性。ファイルを書かず正常終了し、読み手の鮮度判定に任せる
        print(
            f"::warning::場中価格が1件も取得できませんでした（ソース: {source.name}）。"
            "intraday_prices.json は更新しません。"
        )
        return 0

    OUT_FILE.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8"
    )
    print(f"生成完了: {OUT_FILE}（{got}/{len(codes)}銘柄・{payload['asOf']}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
