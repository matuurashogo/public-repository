#!/usr/bin/env python3
"""gen_buy_levels.py の純粋関数 compute_board() の単体テスト（合成データ・ファイルIOなし）。

実行: python tools/test_gen_buy_levels.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from gen_buy_levels import LOW_WINDOW, MA_SHORT, NEAR_THRESHOLD, compute_board  # noqa: E402


def _panel(rows):
    import pandas as pd

    return pd.DataFrame(rows, columns=["code4", "date", "adj_close"])


def _dates(n):
    import pandas as pd

    return [d.strftime("%Y-%m-%d") for d in pd.bdate_range("2026-01-01", periods=n)]


def test_levels_and_flags():
    """レベル価格・dist・hit・陽転の計算を検証する。"""
    n = LOW_WINDOW + 5
    dates = _dates(n)
    # 100 横ばい → 一度 80 へ急落（60日安値・窓内）→ 120 へ上昇 → 最終日 110 に下落（陰転）
    closes = [100.0] * (n - 12) + [80.0] + [120.0] * 10 + [110.0]
    rows = [("7203", d, c) for d, c in zip(dates, closes, strict=True)]
    payload = compute_board(_panel(rows))

    assert payload["near_threshold"] == NEAR_THRESHOLD
    assert payload["updated"] == dates[-1]
    (stock,) = payload["stocks"]
    assert stock["code"] == "7203"
    assert stock["close"] == 110.0
    assert stock["rebound"] is False, "陰転なのに rebound=True"

    levels = {lv["id"]: lv for lv in stock["levels"]}
    assert set(levels) == {"L1", "L2", "L3", "L4", "L5", "L6"}

    ma25 = sum(closes[-MA_SHORT:]) / MA_SHORT
    assert levels["L1"]["price"] == round(ma25, 1)
    assert levels["L2"]["price"] == round(ma25 * 0.95, 1)
    assert levels["L3"]["price"] == round(ma25 * 0.92, 1)
    assert levels["L4"]["price"] == round(120.0 * 0.90, 1)  # 20日高値=120
    assert levels["L5"]["price"] == round(120.0 * 0.85, 1)
    assert levels["L6"]["price"] == 80.0  # 60日安値

    # dist = (レベル価格 − 現在値) / 現在値
    assert levels["L4"]["dist"] == round(108.0 / 110.0 - 1.0, 4)
    # hit = 現在値 ≤ レベル価格（110 は L1(MA25>110のはず) には到達済みか確認）
    for lv in stock["levels"]:
        assert lv["hit"] == (stock["close"] <= lv["price"]), f"{lv['id']} の hit が不正"


def test_rebound_true():
    """最終日が前日比プラスなら rebound=True。"""
    n = LOW_WINDOW + 5
    closes = [100.0] * (n - 1) + [101.0]
    rows = [("6855", d, c) for d, c in zip(_dates(n), closes, strict=True)]
    (stock,) = compute_board(_panel(rows))["stocks"]
    assert stock["rebound"] is True


def test_short_history_partial_levels():
    """履歴不足の銘柄は計算可能なレベルのみ出力する（MA25未満なら L1-L3 なし）。"""
    n = MA_SHORT - 5
    closes = [100.0] * n
    rows = [("9999", d, c) for d, c in zip(_dates(n), closes, strict=True)]
    (stock,) = compute_board(_panel(rows))["stocks"]
    ids = {lv["id"] for lv in stock["levels"]}
    assert "L1" not in ids and "L6" not in ids, "履歴不足なのに L1/L6 が出力されている"
    assert "L4" in ids, "20日分はあるので L4/L5 は出力されるはず"


def test_empty_and_single_row():
    """空パネル・1行のみは安全に空を返す。"""
    assert compute_board(None) == {}
    assert compute_board(_panel([])) == {}
    assert compute_board(_panel([("7203", "2026-01-05", 100.0)])) == {}


def main() -> None:
    tests = [
        test_levels_and_flags,
        test_rebound_true,
        test_short_history_partial_levels,
        test_empty_and_single_row,
    ]
    for t in tests:
        t()
        print(f"✅ {t.__name__}")
    print(f"\n全 {len(tests)} テスト PASS")


if __name__ == "__main__":
    main()
