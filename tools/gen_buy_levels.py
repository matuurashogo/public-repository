#!/usr/bin/env python3
"""買いレベルボードのデータ (data/buy_levels.json) を生成する。

別リポジトリ jquants-data の日次株価 `prices/prices_YYYYMMDD.parquet` を結合し、
監視リスト（data/indicators_universe.json）の銘柄について「あといくら下がったら買いか」の
レベル価格6本を計算して1ファイルの JSON に出力する。データ契約は TBK-0006 を参照。

レベル定義（調整後終値ベース・終値のみで完結）:
  - L1: MA25（25日移動平均）          定番の押し目
  - L2: MA25 × 0.95                   やや深い押し
  - L3: MA25 × 0.92                   深い凹み（VolDipSignals reversal と同水準）
  - L4: 直近20日最高終値 × 0.90        高値からの押し率（浅め）
  - L5: 直近20日最高終値 × 0.85        高値からの押し率（深め）
  - L6: 直近60日最安終値               サポートライン（下値の節目）の代理

付随情報: rebound = 陽転フラグ（最新終値 > 前日終値）。

jquants-data の場所は gen_indicators.py と同じ優先順で自動検出する:
  1. 環境変数 JQUANTS_PARQUET_REPO
  2. 兄弟ディレクトリ ../jquants-data

使い方:
    python tools/gen_buy_levels.py
    JQUANTS_PARQUET_REPO=/path/to/jquants-data python tools/gen_buy_levels.py
"""

from __future__ import annotations

import glob
import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PUBLIC_ROOT = HERE.parent
PARENT = PUBLIC_ROOT.parent
UNIVERSE_FILE = PUBLIC_ROOT / "data" / "indicators_universe.json"
OUT_FILE = PUBLIC_ROOT / "data" / "buy_levels.json"

# レベルパラメータ（変更はスキーマ変更扱い。TBK-0006 の改訂とセットで行うこと）
MA_SHORT = 25
HIGH_WINDOW = 20
LOW_WINDOW = 60
NEAR_THRESHOLD = 0.03  # 「接近」判定の閾値（表示・通知側はこの値を JSON から参照する）
# 必要履歴: 60日安値 + 余裕。休場ズレを見込んで多めに読む
INPUT_DAYS = LOW_WINDOW + 15

_CANDIDATE_JQUANTS_REPOS = [
    os.environ.get("JQUANTS_PARQUET_REPO", ""),
    str(PARENT / "jquants-data"),
]


def _find_prices_dir() -> str | None:
    for base in _CANDIDATE_JQUANTS_REPOS:
        if not base:
            continue
        p = Path(base) / "prices"
        if p.is_dir():
            return str(p.resolve())
    return None


def load_universe() -> list[str]:
    """監視リスト（4桁コード）を読む。重複・不正コードは除く（gen_indicators.py と同一）。"""
    data = json.loads(UNIVERSE_FILE.read_text(encoding="utf-8"))
    codes = data.get("codes", []) if isinstance(data, dict) else []
    out: list[str] = []
    seen: set[str] = set()
    for c in codes:
        c4 = str(c)[:4]
        if re.fullmatch(r"[0-9][0-9A-Z]{3}", c4) and c4 not in seen:
            seen.add(c4)
            out.append(c4)
    return out


def _daily_price_files(prices_dir: str, last_n: int) -> list[str]:
    """prices_YYYYMMDD.parquet を日付順で直近 last_n 件返す（latest/stats/split は除外）。"""
    files = []
    for path in glob.glob(os.path.join(prices_dir, "prices_*.parquet")):
        digits = os.path.basename(path).replace("prices_", "").replace(".parquet", "")
        if digits.isdigit():
            files.append(path)
    files.sort()
    return files[-last_n:] if last_n else files


def _load_panel(prices_dir: str, universe: set[str]):
    """監視リスト銘柄の日次株価を結合した長形式 DataFrame を返す（code4, date, adj_close）。"""
    import pandas as pd

    files = _daily_price_files(prices_dir, INPUT_DAYS)
    if not files:
        raise FileNotFoundError(f"price parquet が見つかりません: {prices_dir}")

    frames = []
    for path in files:
        df = pd.read_parquet(path, columns=["code", "date", "adj_close"])
        df["code4"] = df["code"].astype(str).str[:4]
        df = df[df["code4"].isin(universe)]
        if not df.empty:
            frames.append(df)
    if not frames:
        return pd.DataFrame(columns=["code4", "date", "adj_close"])
    return pd.concat(frames, ignore_index=True)


def _level(level_id: str, label: str, price: float, close: float) -> dict:
    """レベル1本の出力行を作る。dist = (レベル価格 − 現在値) / 現在値（TBK-0006）。"""
    return {
        "id": level_id,
        "label": label,
        "price": round(float(price), 1),
        "dist": round(float(price) / close - 1.0, 4),
        "hit": bool(close <= price),
    }


def compute_board(panel) -> dict:
    """長形式の株価 DataFrame から buy_levels.json の payload を計算する純粋関数（テスト対象）。"""
    import pandas as pd

    if panel is None or len(panel) == 0:
        return {}

    panel = panel.copy()
    panel["date"] = pd.to_datetime(panel["date"])
    panel["adj_close"] = pd.to_numeric(panel["adj_close"], errors="coerce")
    panel = panel.dropna(subset=["adj_close"])
    panel = panel.sort_values(["code4", "date"]).reset_index(drop=True)

    stocks = []
    updated = ""
    for code4, sub in panel.groupby("code4", sort=True):
        closes = sub["adj_close"].tolist()
        if len(closes) < 2:
            continue  # 陽転判定すらできない（上場直後など）
        close = float(closes[-1])
        if close <= 0:
            continue
        updated = max(updated, sub["date"].iloc[-1].strftime("%Y-%m-%d"))

        levels = []
        if len(closes) >= MA_SHORT:
            ma25 = sum(closes[-MA_SHORT:]) / MA_SHORT
            levels.append(_level("L1", "25日線", ma25, close))
            levels.append(_level("L2", "25日線-5%", ma25 * 0.95, close))
            levels.append(_level("L3", "25日線-8%", ma25 * 0.92, close))
        if len(closes) >= HIGH_WINDOW:
            high20 = max(closes[-HIGH_WINDOW:])
            levels.append(_level("L4", "20日高値-10%", high20 * 0.90, close))
            levels.append(_level("L5", "20日高値-15%", high20 * 0.85, close))
        if len(closes) >= LOW_WINDOW:
            low60 = min(closes[-LOW_WINDOW:])
            levels.append(_level("L6", "60日安値", low60, close))

        stocks.append(
            {
                "code": str(code4),
                "close": round(close, 1),
                "rebound": bool(close > float(closes[-2])),
                "levels": levels,
            }
        )

    if not stocks:
        return {}
    return {
        "updated": updated,
        "source": "jquants-data prices (調整後終値ベース)",
        "near_threshold": NEAR_THRESHOLD,
        "stocks": stocks,
    }


def main() -> int:
    prices_dir = _find_prices_dir()
    if not prices_dir:
        print(
            "jquants-data の prices/ が見つかりません。環境変数 JQUANTS_PARQUET_REPO で指定してください。",
            file=sys.stderr,
        )
        return 1

    universe = load_universe()
    if not universe:
        print("監視リスト（data/indicators_universe.json の codes）が空です。対象銘柄を追加してください。")
        return 0

    panel = _load_panel(prices_dir, set(universe))
    payload = compute_board(panel)
    if not payload:
        print("計算可能な銘柄がありません（履歴不足の可能性）。", file=sys.stderr)
        return 1

    missing = [c for c in universe if c not in {s["code"] for s in payload["stocks"]}]
    for c in missing:
        print(f"  - {c}: データなし（jquants-data に履歴が無いか日数不足）", file=sys.stderr)

    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
    OUT_FILE.write_text(text, encoding="utf-8")
    print(f"生成完了: {OUT_FILE}（{len(payload['stocks'])}/{len(universe)}銘柄・基準日 {payload['updated']}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
