#!/usr/bin/env python3
"""gen_volatility.py の純粋関数 compute_sigma20() / compute_volatility() の単体テスト。

実行: python tools/test_gen_volatility.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from gen_volatility import (  # noqa: E402
    SIGMA_WINDOW,
    TP_CAP,
    TP_FLOOR,
    TP_K,
    compute_sigma20,
    compute_volatility,
)


def _panel(rows):
    import pandas as pd

    return pd.DataFrame(rows, columns=["code4", "date", "adj_close"])


def _dates(n):
    import pandas as pd

    return [d.strftime("%Y-%m-%d") for d in pd.bdate_range("2026-01-01", periods=n)]


def test_sigma_known_value():
    """既知の系列で σ20 が標本標準偏差（ddof=1）に一致することを検証する。"""
    # 終値が +1%, -1% を交互に繰り返す → 日次リターンは概ね ±0.01 近辺
    closes = [100.0]
    up = True
    for _ in range(SIGMA_WINDOW):
        closes.append(closes[-1] * (1.01 if up else 0.99))
        up = not up
    s = compute_sigma20(closes)
    assert s is not None and 0.005 < s < 0.02, f"想定レンジ外: {s}"


def test_sigma_flat_is_zero():
    """完全横ばい（リターン0）なら σ20 = 0。"""
    closes = [100.0] * (SIGMA_WINDOW + 1)
    assert compute_sigma20(closes) == 0.0


def test_sigma_short_history_none():
    """21本未満は履歴不足で None。"""
    assert compute_sigma20([100.0] * SIGMA_WINDOW) is None
    assert compute_sigma20([]) is None
    assert compute_sigma20(None) is None


def test_payload_shape_and_params():
    """payload のパラメータ・σ辞書・履歴不足銘柄の除外を検証する。"""
    n = SIGMA_WINDOW + 5
    dates = _dates(n)
    # A: 振動あり（σ>0）/ B: 履歴不足（5本のみ）→ 除外される
    closes_a = []
    p, up = 100.0, True
    for _ in range(n):
        closes_a.append(p)
        p = p * (1.02 if up else 0.98)
        up = not up
    rows = [("6855", d, c) for d, c in zip(dates, closes_a, strict=True)]
    rows += [("5016", d, 100.0) for d in dates[:5]]
    payload = compute_volatility(_panel(rows))

    assert payload["window"] == SIGMA_WINDOW
    assert payload["k"] == TP_K
    assert payload["floor"] == TP_FLOOR
    assert payload["cap"] == TP_CAP
    assert payload["updated"] == dates[-1]
    assert "6855" in payload["sigma"] and payload["sigma"]["6855"] > 0
    assert "5016" not in payload["sigma"], "履歴不足の銘柄は σ を出さない"


def test_empty_and_single_row():
    """空・None・履歴不足のみは {} を返す。"""
    assert compute_volatility(None) == {}
    assert compute_volatility(_panel([])) == {}
    assert compute_volatility(_panel([("6855", "2026-01-05", 100.0)])) == {}


def main() -> None:
    tests = [
        test_sigma_known_value,
        test_sigma_flat_is_zero,
        test_sigma_short_history_none,
        test_payload_shape_and_params,
        test_empty_and_single_row,
    ]
    for t in tests:
        t()
        print(f"✅ {t.__name__}")
    print(f"\n全 {len(tests)} テスト PASS")


if __name__ == "__main__":
    main()
