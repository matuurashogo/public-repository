#!/usr/bin/env python3
"""エントリー・スナップショット用の指標履歴 (data/indicators/<code>.json) を生成する。

別リポジトリ jquants-data の日次株価 `prices/prices_YYYYMMDD.parquet`（全銘柄・全履歴）を
結合し、監視リスト（data/indicators_universe.json）の銘柄について、終値・売買代金から
テクニカル指標を計算して銘柄別 JSON を出力する。TradeBook の「エントリー型別成績（客観軸）」
で、買い日付時点の客観状態（凹みの深さ・出来高急増度・トレンド位置）を引くために使う。

指標は VolDipSignals の add_indicators と同一定義（終値ベース。四本値は持たない）:
  - dev  : 25日線乖離率 = adj_close / ma25 - 1          （凹みの深さ）
  - abv  : 75日線の上か = adj_close > ma75               （トレンド位置）
  - vol  : 売買代金 / 20日平均売買代金                    （出来高急増度）

全約3,800銘柄を毎日コミットすると git 履歴が肥大化するため、対象は監視リスト方式で限定する
（ADR: エントリー・スナップショットのデータ契約を参照）。

jquants-data の場所は次の優先順で自動検出する（環境変数 JQUANTS_PARQUET_REPO で明示可）:
  1. 環境変数 JQUANTS_PARQUET_REPO
  2. 兄弟ディレクトリ ../jquants-data

出力 data/indicators/<code4>.json:
  {
    "code": "7203",
    "updated": "2026-06-03",
    "source": "jquants-data prices (VolDipSignals指標と同一定義)",
    "rows": [ {"d": "2024-06-04", "dev": -0.0123, "abv": true, "vol": 1.42}, ... ]   # 日付昇順
  }

使い方:
    python tools/gen_indicators.py
    JQUANTS_PARQUET_REPO=/path/to/jquants-data python tools/gen_indicators.py
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
OUT_DIR = PUBLIC_ROOT / "data" / "indicators"

# 指標パラメータ（VolDipSignals と一致させること）
MA_SHORT = 25
MA_LONG = 75
TV_WINDOW = 20
# 出力する直近営業日数（約2年）と、75日線のウォームアップ込みで読む入力営業日数
OUTPUT_DAYS = 500
WARMUP = MA_LONG + TV_WINDOW + 5
INPUT_DAYS = OUTPUT_DAYS + WARMUP

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


def to_code4(code: str) -> str:
    """J-Quants の5桁ローカルコード（例 "72030"）→ 4桁証券コード（"7203"）。"""
    return str(code)[:4]


def load_universe() -> list[str]:
    """監視リスト（4桁コード）を読む。重複・不正コードは除く。"""
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
    """監視リスト銘柄の日次株価を結合した長形式 DataFrame を返す（code4, date, adj_close, trading_value）。"""
    import pandas as pd

    files = _daily_price_files(prices_dir, INPUT_DAYS)
    if not files:
        raise FileNotFoundError(f"price parquet が見つかりません: {prices_dir}")

    frames = []
    for path in files:
        df = pd.read_parquet(path, columns=["code", "date", "adj_close", "trading_value"])
        df["code4"] = df["code"].astype(str).str[:4]
        df = df[df["code4"].isin(universe)]
        if not df.empty:
            frames.append(df)
    if not frames:
        import pandas as pd  # noqa: F811

        return pd.DataFrame(columns=["code4", "date", "adj_close", "trading_value"])
    return pd.concat(frames, ignore_index=True)


def compute_payloads(panel) -> dict:
    """長形式の株価 DataFrame から code4 -> payload(dict) を計算する純粋関数（テスト対象）。"""
    import pandas as pd

    if panel is None or len(panel) == 0:
        return {}

    panel = panel.copy()
    panel["date"] = pd.to_datetime(panel["date"])
    for col in ["adj_close", "trading_value"]:
        panel[col] = pd.to_numeric(panel[col], errors="coerce")
    panel = panel.sort_values(["code4", "date"]).reset_index(drop=True)

    g = panel.groupby("code4", sort=False)["adj_close"]
    panel["ma25"] = g.transform(lambda s: s.rolling(MA_SHORT).mean())
    panel["ma75"] = g.transform(lambda s: s.rolling(MA_LONG).mean())
    panel["tv20"] = panel.groupby("code4", sort=False)["trading_value"].transform(
        lambda s: s.rolling(TV_WINDOW).mean()
    )
    panel["dev"] = panel["adj_close"] / panel["ma25"] - 1.0
    panel["abv"] = panel["adj_close"] > panel["ma75"]
    panel["vol"] = panel["trading_value"] / panel["tv20"]

    out: dict[str, dict] = {}
    for code4, sub in panel.groupby("code4", sort=True):
        sub = sub.dropna(subset=["dev", "ma75", "tv20", "vol"])
        if sub.empty:
            continue
        sub = sub.tail(OUTPUT_DAYS)
        rows = []
        for _, r in sub.iterrows():
            vol = float(r["vol"])
            rows.append(
                {
                    "d": r["date"].strftime("%Y-%m-%d"),
                    "dev": round(float(r["dev"]), 4),
                    "abv": bool(r["abv"]),
                    "vol": round(vol, 2),
                }
            )
        out[code4] = {
            "code": code4,
            "updated": rows[-1]["d"],
            "source": "jquants-data prices (VolDipSignals指標と同一定義)",
            "rows": rows,
        }
    return out


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
    payloads = compute_payloads(panel)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    written = 0
    for code4 in universe:
        payload = payloads.get(code4)
        if not payload:
            print(f"  - {code4}: データなし（jquants-data に履歴が無いか日数不足）", file=sys.stderr)
            continue
        text = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
        (OUT_DIR / f"{code4}.json").write_text(text, encoding="utf-8")
        written += 1

    print(f"生成完了: {OUT_DIR}（{written}/{len(universe)}銘柄）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
