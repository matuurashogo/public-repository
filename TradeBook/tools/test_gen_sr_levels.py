#!/usr/bin/env python3
"""gen_sr_levels.py の単体テスト（TBK-0015）。

スイング水準の判定・PIT 安全性（誕生日 = 極値日 + n）・統合・支持/抵抗の振り分けを検証する。
HypoLab srlevels（HYP-0005）と同一定義であることが契約。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import gen_sr_levels as g  # noqa: E402


def _flat_series(n: int, price: float = 100.0):
    """変動のないフラットな四本値（水準は生まれない）。"""
    h = [price * 1.001] * n
    l = [price * 0.999] * n  # noqa: E741
    c = [price] * n
    return h, l, c


def _series_with_spike(n: int, spike_at: int, spike: float, price: float = 100.0):
    """1日だけ高値が突出する系列（スイング高値の fixture）。"""
    h, l, c = _flat_series(n, price)
    h[spike_at] = spike
    return h, l, c


class TestSwingLevels(unittest.TestCase):
    def test_flat_series_has_no_levels(self):
        h, l, c = _flat_series(60)
        atr = g.atr_series(h, l, c)
        self.assertEqual(g.gen_swing_levels(h, l, c, atr), [])

    def test_swing_high_detected_with_pit_birth(self):
        """突出した高値がスイング水準になり、誕生日は極値日 + n（look-ahead 排除）。"""
        spike_at = 30
        h, l, c = _series_with_spike(60, spike_at, 110.0)
        atr = g.atr_series(h, l, c)
        levels = g.gen_swing_levels(h, l, c, atr)
        self.assertEqual(len(levels), 1)
        lv = levels[0]
        self.assertEqual(lv["kind"], "high")
        self.assertAlmostEqual(lv["level"], 110.0)
        self.assertEqual(lv["birth"], spike_at + g.SWING_N)  # PIT: 確定は n 日後
        self.assertEqual(lv["expire"], spike_at + g.SWING_N + g.LIFE_DAYS)

    def test_swing_low_detected(self):
        h, l, c = _flat_series(60)
        l[30] = 90.0
        atr = g.atr_series(h, l, c)
        levels = g.gen_swing_levels(h, l, c, atr)
        self.assertEqual([lv["kind"] for lv in levels], ["low"])
        self.assertAlmostEqual(levels[0]["level"], 90.0)

    def test_prominence_filter_rejects_small_spike(self):
        """突出がプロミネンス閾値（prom_atr×ATR）未満なら水準にしない。"""
        h, l, c = _flat_series(60)
        h[30] = 100.05  # ATR=0.2 → 閾値 0.1。プロミネンス 0.05 < 0.1 → 棄却されるべき
        atr = g.atr_series(h, l, c)
        self.assertEqual(g.gen_swing_levels(h, l, c, atr), [])


class TestMergeAndPick(unittest.TestCase):
    def test_merge_keeps_older_level(self):
        levels = [
            {"level": 100.0, "birth": 10, "expire": 130, "def_id": "swing", "kind": "high"},
            {"level": 100.5, "birth": 20, "expire": 140, "def_id": "swing", "kind": "high"},
        ]
        merged = g.merge_close_levels(levels, 0.01)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["birth"], 10)

    def test_merge_does_not_join_expired(self):
        """先行水準が失効した後に生まれた同値水準は統合されない。"""
        levels = [
            {"level": 100.0, "birth": 0, "expire": 10, "def_id": "swing", "kind": "high"},
            {"level": 100.2, "birth": 50, "expire": 170, "def_id": "swing", "kind": "high"},
        ]
        self.assertEqual(len(g.merge_close_levels(levels, 0.01)), 2)

    def test_pick_levels_splits_by_close_and_orders_by_proximity(self):
        levels = [
            {"level": p, "birth": 0, "expire": 999, "def_id": "swing", "kind": "high"}
            for p in [80.0, 95.0, 90.0, 105.0, 120.0, 110.0]
        ]
        picked = g.pick_levels(levels, t_last=10, close=100.0, max_levels=2)
        self.assertEqual([x["level"] for x in picked["support"]], [95.0, 90.0])       # 近い順（降順）・最大2本
        self.assertEqual([x["level"] for x in picked["resistance"]], [105.0, 110.0])  # 近い順（昇順）・最大2本

    def test_pick_levels_excludes_inactive(self):
        """未誕生・失効済みの水準は出力しない（PIT/寿命の遵守）。"""
        levels = [
            {"level": 95.0, "birth": 11, "expire": 999, "def_id": "swing", "kind": "low"},  # 未誕生
            {"level": 105.0, "birth": 0, "expire": 9, "def_id": "swing", "kind": "high"},   # 失効
        ]
        picked = g.pick_levels(levels, t_last=10, close=100.0)
        self.assertEqual(picked, {"support": [], "resistance": []})

    def test_pick_levels_carries_touches(self):
        levels = [
            {"level": 95.0, "birth": 0, "expire": 999, "def_id": "swing", "kind": "low", "touches": 3},
        ]
        picked = g.pick_levels(levels, t_last=10, close=100.0)
        self.assertEqual(picked["support"], [{"level": 95.0, "touches": 3}])


class TestCountTouches(unittest.TestCase):
    """タッチ回数（信頼度の代理・TBK-0015）: バンド接触の回数をクールダウン付きで数える。"""

    def _atr(self, h, l, c):  # noqa: E741
        return g.atr_series(h, l, c)

    def test_two_separated_touches(self):
        """クールダウンより離れた2回の接近は2回と数える。"""
        h, l, c = _flat_series(60)  # 価格100・ATR≈0.2
        level = 100.0  # フラット系列は毎日バンド内 → クールダウンで間引かれる
        atr = self._atr(h, l, c)
        # birth=20〜59 の40日間、毎日バンド内 → 11日ごとに1回 = ceil(40/11) = 4回
        self.assertEqual(g.count_touches(level, 20, 999, h, l, atr), 4)

    def test_far_level_never_touched(self):
        h, l, c = _flat_series(60)
        atr = self._atr(h, l, c)
        self.assertEqual(g.count_touches(150.0, 20, 999, h, l, atr), 0)

    def test_touch_only_after_birth(self):
        """誕生日前の接近は数えない（PIT 安全）。"""
        h, l, c = _flat_series(60)
        # 30日目だけ 120 に接近する高値
        h[30] = 120.0
        atr = self._atr(h, l, c)
        # birth=40（接近日30より後）→ 0回
        self.assertEqual(g.count_touches(120.0, 40, 999, h, l, atr), 0)
        # birth=25（接近日30を含む）→ 1回
        self.assertEqual(g.count_touches(120.0, 25, 999, h, l, atr), 1)


class TestComputeSr(unittest.TestCase):
    def _panel(self):
        import pandas as pd

        n = 80
        spike_at = 40
        h, l, c = _series_with_spike(n, spike_at, 110.0)
        l[20] = 90.0  # スイング安値も1本
        dates = pd.bdate_range("2026-01-05", periods=n)
        return pd.DataFrame(
            {"code4": ["7203"] * n, "date": dates, "adj_high": h, "adj_low": l, "adj_close": c}
        )

    def test_payload_contract(self):
        payload = g.compute_sr(self._panel())
        self.assertEqual(set(payload), {"updated", "source", "params", "stocks"})
        self.assertEqual(payload["params"]["swing_n"], g.SWING_N)
        s = payload["stocks"][0]
        self.assertEqual(s["code"], "7203")
        self.assertEqual(s["support"], [90.0])       # close=100 の下
        self.assertEqual(s["resistance"], [110.0])   # close=100 の上
        self.assertEqual(s["close"], 100.0)
        # TBK-0015: touches は価格配列と同順・同長の並行配列（int・0以上）
        self.assertEqual(len(s["support_touches"]), len(s["support"]))
        self.assertEqual(len(s["resistance_touches"]), len(s["resistance"]))
        self.assertTrue(all(isinstance(t, int) and t >= 0 for t in s["support_touches"]))
        self.assertEqual(payload["params"]["touch_band_atr"], g.TOUCH_BAND_ATR)
        self.assertEqual(payload["params"]["touch_cooldown"], g.TOUCH_COOLDOWN)

    def test_missing_high_low_falls_back_to_close(self):
        """高安欠損日は終値埋め（水準が誤って増えない・クラッシュしない）。"""
        import pandas as pd

        panel = self._panel()
        panel.loc[panel.index[:10], ["adj_high", "adj_low"]] = float("nan")
        payload = g.compute_sr(panel)
        self.assertTrue(payload["stocks"])  # 計算自体は成立

    def test_empty_panel(self):
        self.assertEqual(g.compute_sr(None), {})


if __name__ == "__main__":
    unittest.main(verbosity=1)
