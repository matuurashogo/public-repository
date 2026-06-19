#!/usr/bin/env python3
"""fetch_intraday_prices.py の純粋関数（extract_price / build_payload）の単体テスト。

実行: python3 tools/test_fetch_intraday_prices.py
依存: 標準ライブラリのみ（ネットワークアクセスは行わない）
"""

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_intraday_prices as fi  # noqa: E402

JST = timezone(timedelta(hours=9))


class TestExtractPrice(unittest.TestCase):
    def test_valid_payload(self):
        payload = {"chart": {"result": [{"meta": {"regularMarketPrice": 3392.0}}]}}
        self.assertEqual(fi.extract_price(payload), 3392.0)

    def test_missing_or_broken(self):
        self.assertIsNone(fi.extract_price({}))
        self.assertIsNone(fi.extract_price({"chart": {"result": []}}))
        self.assertIsNone(fi.extract_price({"chart": {"result": [{"meta": {}}]}}))
        self.assertIsNone(fi.extract_price({"chart": {"result": [{"meta": {"regularMarketPrice": None}}]}}))
        self.assertIsNone(fi.extract_price({"chart": {"result": [{"meta": {"regularMarketPrice": 0}}]}}))
        self.assertIsNone(fi.extract_price({"chart": None}))


class TestBuildPayload(unittest.TestCase):
    def test_rounding_and_skip_failures(self):
        as_of = datetime(2026, 6, 11, 13, 30, 0, tzinfo=JST)
        payload = fi.build_payload(
            {"5016": 3392.04, "6855": None, "6101": 6710.0}, "yahoo_chart", as_of
        )
        self.assertEqual(payload["asOf"], "2026-06-11T13:30:00+09:00")
        self.assertEqual(payload["source"], "yahoo_chart")
        # 失敗銘柄（None）はキー自体を出さない（TBK-0008）
        self.assertEqual(payload["prices"], {"5016": 3392.0, "6101": 6710.0})

    def test_all_failed(self):
        as_of = datetime(2026, 6, 11, 13, 30, 0, tzinfo=JST)
        payload = fi.build_payload({"5016": None}, "yahoo_chart", as_of)
        self.assertEqual(payload["prices"], {})


if __name__ == "__main__":
    unittest.main()
