#!/usr/bin/env python3
"""gen_indicators.compute_payloads の単体テスト（標準ライブラリ unittest）。

実行: python3 tools/test_gen_indicators.py
依存: pandas（指標計算に必要）
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gen_indicators as gi  # noqa: E402


class TestComputePayloads(unittest.TestCase):
    def _panel(self):
        import pandas as pd

        n = 80
        dates = pd.date_range("2026-01-01", periods=n, freq="B")
        close = [100.0] * (n - 1) + [120.0]  # 最終日だけ急騰
        tv = [1000] * (n - 1) + [3000]  # 最終日だけ出来高急増
        return pd.DataFrame(
            {"code4": ["9999"] * n, "date": dates, "adj_close": close, "trading_value": tv}
        )

    def test_indicator_math_last_row(self):
        payloads = gi.compute_payloads(self._panel())
        self.assertIn("9999", payloads)
        rows = payloads["9999"]["rows"]
        # ma75 が有効になるのは 75本目以降 → 80-74 = 6 行
        self.assertEqual(len(rows), 6)

        last = rows[-1]
        # ma25 = (24*100 + 120)/25 = 100.8 → dev = 120/100.8 - 1 = 0.190476…
        self.assertAlmostEqual(last["dev"], 0.1905, places=4)
        # ma75 = (74*100 + 120)/75 = 100.2667 → 120 > ma75 → True
        self.assertTrue(last["abv"])
        # tv20 = (19*1000 + 3000)/20 = 1100 → vol = 3000/1100 = 2.7273
        self.assertAlmostEqual(last["vol"], 2.73, places=2)

        # payload メタ
        self.assertEqual(payloads["9999"]["code"], "9999")
        self.assertEqual(payloads["9999"]["updated"], last["d"])
        # 日付は昇順
        ds = [r["d"] for r in rows]
        self.assertEqual(ds, sorted(ds))

    def test_empty_panel(self):
        import pandas as pd

        empty = pd.DataFrame(columns=["code4", "date", "adj_close", "trading_value"])
        self.assertEqual(gi.compute_payloads(empty), {})


if __name__ == "__main__":
    unittest.main()
