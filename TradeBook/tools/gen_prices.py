#!/usr/bin/env python3
"""最新終値の対応表 (data/latest_prices.json) を生成する。

別リポジトリ jquants-data の `prices/prices_latest.parquet`（最新営業日の全銘柄
終値）から、4桁証券コード→調整後終値(adj_close) の対応表を作る。
TradeBook の保有銘柄カードで含み損益（評価損益）を算出するために使う。

入力は datasource 層（TBK-0013）経由。TRADEBOOK_DATA_SOURCE=r2 で QDP R2 から読める。
jquants-data の場所は次の優先順で自動検出する（環境変数 JQUANTS_PARQUET_REPO で明示可）:
  1. 環境変数 JQUANTS_PARQUET_REPO
  2. 兄弟ディレクトリ ../jquants-data

出力:
  data/latest_prices.json
    {
      "date": "2026-05-29",
      "source": "jquants-data prices_latest",
      "prices": { "7203": 3042, "8306": 2999, ... }
    }

使い方:
    python tools/gen_prices.py
    JQUANTS_PARQUET_REPO=/path/to/jquants-data python tools/gen_prices.py
    python tools/gen_prices.py /path/to/prices_latest.parquet  # 入力を明示
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PUBLIC_ROOT = HERE.parent
PARENT = PUBLIC_ROOT.parent
OUT = PUBLIC_ROOT / "data" / "latest_prices.json"

# jquants-data リポジトリの場所候補。
_CANDIDATE_JQUANTS_REPOS = [
    os.environ.get("JQUANTS_PARQUET_REPO", ""),
    str(PARENT / "jquants-data"),
]


def _find_latest_parquet() -> str | None:
    """jquants-data の prices/prices_latest.parquet を探して返す。"""
    for base in _CANDIDATE_JQUANTS_REPOS:
        if not base:
            continue
        p = Path(base) / "prices" / "prices_latest.parquet"
        if p.exists():
            return str(p.resolve())
    return None


def to_code4(code: str) -> str:
    """J-Quants の5桁ローカルコード（例 "72030"）→ 4桁証券コード（"7203"）。"""
    return str(code)[:4]


def _round_price(v) -> float | int | None:
    """価格を見やすく丸める。整数なら int、端数があれば小数1桁。None は素通し。"""
    if v is None:
        return None
    f = float(v)
    if f != f:  # NaN
        return None
    r = round(f, 1)
    return int(r) if r == int(r) else r


def build(parquet_path: str) -> dict:
    """parquet から { date, source, prices } を作る。pyarrow が必須。"""
    import pyarrow.parquet as pq  # 必須依存（Actions/手動どちらもインストール前提）

    table = pq.read_table(parquet_path, columns=["code", "date", "adj_close", "close"])
    codes = table.column("code").to_pylist()
    dates = table.column("date").to_pylist()
    adj = table.column("adj_close").to_pylist()
    close = table.column("close").to_pylist()
    return _payload_from_rows(codes, dates, adj, close, "jquants-data prices_latest")


def build_from_frame(df, source: str) -> dict:
    """DataFrame（code/date/adj_close/close）から payload を作る（datasource r2 経路用）。"""

    def _nan_to_none(values):
        # pyarrow の to_pylist は NULL→None を返すため、pandas の NaN も None へ揃える
        # （adj_close 欠損時に close へフォールバックする挙動を両経路で一致させる）
        return [None if v != v else v for v in values]

    return _payload_from_rows(
        df["code"].tolist(),
        df["date"].tolist(),
        _nan_to_none(df["adj_close"].tolist()),
        _nan_to_none(df["close"].tolist()),
        source,
    )


def _payload_from_rows(codes, dates, adj, close, source: str) -> dict:
    prices: dict[str, float | int] = {}
    for code, a, c in zip(codes, adj, close):
        code4 = to_code4(str(code))
        if not re.fullmatch(r"[0-9][0-9A-Z]{3}", code4):
            continue
        # 調整後終値を優先。欠損時は通常終値でフォールバック。
        price = _round_price(a if a is not None else c)
        if price is None:
            continue
        # 同一4桁コードが重複する場合は先勝ち（基本的に重複しない想定）
        prices.setdefault(code4, price)

    # 基準日（全行で同一の想定。先頭行の date を YYYY-MM-DD 文字列化）
    date_str = ""
    if dates:
        d0 = dates[0]
        date_str = str(d0)[:10] if d0 is not None else ""

    return {
        "date": date_str,
        "source": source,
        "prices": dict(sorted(prices.items())),
    }


def main() -> int:
    import datasource

    arg = sys.argv[1] if len(sys.argv) > 1 else None
    if datasource.use_r2() and not arg:
        # R2（quant-data-platform silver）から最新終値を読む（TBK-0013）
        try:
            df = datasource.load_latest_prices()
        except Exception as e:
            print(f"R2 からの読み込みに失敗しました: {e}", file=sys.stderr)
            return 1
        payload = build_from_frame(df, "qdp-r2 fact_prices_daily")
        OUT.parent.mkdir(parents=True, exist_ok=True)
        text = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
        OUT.write_text(text, encoding="utf-8")
        print(
            f"生成完了: {OUT}（{len(payload['prices'])}銘柄 / 基準日 {payload['date'] or '不明'} / R2）"
        )
        return 0

    src = arg or _find_latest_parquet()
    if not src or not os.path.exists(src):
        print(
            "入力が見つかりません。jquants-data の prices/prices_latest.parquet を用意してください。\n"
            "  ※場所が異なる場合は環境変数 JQUANTS_PARQUET_REPO で指定するか、第1引数でパスを渡してください。",
            file=sys.stderr,
        )
        return 1

    payload = build(src)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
    OUT.write_text(text, encoding="utf-8")
    print(
        f"生成完了: {OUT}（{len(payload['prices'])}銘柄 / 基準日 {payload['date'] or '不明'}）"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
