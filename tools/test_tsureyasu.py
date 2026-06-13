#!/usr/bin/env python3
"""連れ安度（TBK-0009 / HypoLab H84）純粋関数の単体テスト。pandas 非依存・ファイルIOなし。

実行: python tools/test_tsureyasu.py
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from gen_buy_levels import (  # noqa: E402
    CRASH_WINDOW,
    HARD_DROP,
    build_tsureyasu,
    classify_tsureyasu,
    compute_sector_means,
    crash_state,
    five_day_return,
    realized_sigma,
)


def test_five_day_return():
    closes = [100, 100, 100, 100, 100, 85]  # 5日前=100 → 今日=85
    assert abs(five_day_return(closes, CRASH_WINDOW) - (-0.15)) < 1e-12
    assert five_day_return([100, 90], CRASH_WINDOW) is None  # 履歴不足
    assert five_day_return([0, 0, 0, 0, 0, 50], CRASH_WINDOW) is None  # 基準0


def test_realized_sigma():
    flat = [100.0] * 70
    assert realized_sigma(flat) == 0.0  # 横ばいは σ=0
    assert realized_sigma([100.0] * 10) is None  # 履歴不足


def test_crash_state_hard_drop():
    # 横ばい(σ≈0) → 最後の5日で-15%以下 → hard_drop で event
    closes = [100.0] * 65 + [98, 95, 92, 88, 84]  # 5日前=100 近辺 → 84
    st = crash_state(closes)
    assert st["event"] is True
    assert st["r5"] is not None and st["r5"] <= HARD_DROP


def test_crash_state_sigma_rule():
    # ±2%振動でσ≈0.02を作り（-3σ√5≈-0.135）、末尾5日で-14%下落。
    # hard_drop(-15%)には未達だが σ ルールで event を拾えることを確認。
    base = [100.0]
    for i in range(65):
        base.append(base[-1] * (1.02 if i % 2 == 0 else 0.98))
    ratio = 0.86 ** (1 / 5)  # 5日かけて 0.86 倍（= r5 -14%）
    closes = base + [base[-1] * ratio ** k for k in range(1, 6)]
    st = crash_state(closes)
    assert st["sigma"] is not None and st["sigma"] > 0
    assert st["r5"] > HARD_DROP  # hard_drop には未達（-14% > -15%）
    assert st["event"] is True  # それでも σ ルールで急落判定


def test_crash_state_no_event():
    closes = [100.0 + i * 0.1 for i in range(70)]  # 緩やかに上昇
    st = crash_state(closes)
    assert st["event"] is False


def test_compute_sector_means():
    sector_map = {"1111": "3650", "2222": "3650", "3333": "9999", "4444": "3650"}
    closes_by_code = {
        "1111": [1000.0] * 5 + [900.0],  # r5 = -10%
        "2222": [1000.0] * 5 + [800.0],  # r5 = -20%
        "3333": [1000.0] * 5 + [500.0],  # 9999 → 除外
        "4444": [50.0] * 5 + [40.0],     # 終値40<100 → 除外（低位株）
    }
    means = compute_sector_means(closes_by_code, sector_map)
    assert set(means) == {"3650"}
    assert abs(means["3650"] - (-0.15)) < 1e-12  # (-0.10 + -0.20)/2


def test_build_tsureyasu_tsure_vs_kobetsu():
    sector_means = {"3650": -0.15}  # 業種平均 -15%
    # 連れ安: 業種なみ(-16%)。残差 = -0.16 -(-0.15) = -0.01 > -0.03 → 連れ安
    tsure = build_tsureyasu([100.0] * 65 + [99, 97, 95, 90, 84], "3650", sector_means)
    assert tsure is not None and tsure["event"] is True
    assert tsure["tag"] == "連れ安"
    assert abs(tsure["resid"] - round(tsure["self_r5"] - (-0.15), 4)) < 1e-9

    # 個別急落: 業種(-15%)より大きく下げ(-30%)。残差 = -0.15 ≤ -0.03 → 個別急落
    kobetsu = build_tsureyasu([100.0] * 65 + [95, 90, 85, 78, 70], "3650", sector_means)
    assert kobetsu is not None and kobetsu["tag"] == "個別急落"


def test_build_tsureyasu_skips():
    sector_means = {"3650": -0.15}
    # 急落イベントでない（横ばい）→ None
    assert build_tsureyasu([100.0] * 70, "3650", sector_means) is None
    # 業種不明 → None
    assert build_tsureyasu([100.0] * 65 + [90, 85, 80, 75, 70], None, sector_means) is None
    # 業種平均が無い → None
    assert build_tsureyasu([100.0] * 65 + [90, 85, 80, 75, 70], "9999", sector_means) is None
    assert build_tsureyasu([100.0] * 65 + [90, 85, 80, 75, 70], "1050", sector_means) is None


def test_classify_threshold():
    assert classify_tsureyasu(-0.03) == "個別急落"  # 境界は個別急落側
    assert classify_tsureyasu(-0.0299) == "連れ安"
    assert classify_tsureyasu(0.0) == "連れ安"


def main() -> None:
    tests = [
        test_five_day_return,
        test_realized_sigma,
        test_crash_state_hard_drop,
        test_crash_state_sigma_rule,
        test_crash_state_no_event,
        test_compute_sector_means,
        test_build_tsureyasu_tsure_vs_kobetsu,
        test_build_tsureyasu_skips,
        test_classify_threshold,
    ]
    for t in tests:
        t()
        print(f"✅ {t.__name__}")
    print(f"\n全 {len(tests)} テスト PASS")


if __name__ == "__main__":
    main()
