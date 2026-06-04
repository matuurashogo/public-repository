#!/usr/bin/env python3
"""sync_universe_from_drive の純粋関数（extract_codes / merge_universe）の単体テスト。

実行: python3 tools/test_sync_universe_from_drive.py
依存: 標準ライブラリのみ（Drive アクセスは行わない）
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sync_universe_from_drive as su  # noqa: E402


class TestExtractCodes(unittest.TestCase):
    def test_dedup_and_sort(self):
        master = {
            "trades": [
                {"code": "6590", "side": "買"},
                {"code": "6590", "side": "売"},  # 重複は1つに
                {"code": "6855", "side": "買"},
                {"code": "6101", "side": "買"},
            ]
        }
        self.assertEqual(su.extract_codes(master), ["6101", "6590", "6855"])

    def test_skips_invalid_codes(self):
        master = {
            "trades": [
                {"code": "7203"},
                {"code": "bad"},  # 先頭が数字でない → 除外
                {"code": None},   # None → 除外
                {"code": ""},     # 空 → 除外
                {"notcode": "x"}, # code 欠落 → 除外
                "not-a-dict",     # dict でない → 除外
            ]
        }
        self.assertEqual(su.extract_codes(master), ["7203"])

    def test_truncates_to_4_digits(self):
        # J-Quants の5桁ローカルコードが混じっても先頭4桁を採用
        master = {"trades": [{"code": "72030"}]}
        self.assertEqual(su.extract_codes(master), ["7203"])

    def test_empty(self):
        self.assertEqual(su.extract_codes({}), [])
        self.assertEqual(su.extract_codes({"trades": []}), [])


class TestMergeUniverse(unittest.TestCase):
    def test_appends_only_new_and_preserves_order(self):
        existing = {"_comment": "メモ", "codes": ["7203", "6758"]}
        updated, added = su.merge_universe(existing, ["6101", "6758", "6590"])
        self.assertEqual(added, ["6101", "6590"])  # 6758 は既存なので追加しない
        self.assertEqual(updated["codes"], ["7203", "6758", "6101", "6590"])
        self.assertEqual(updated["_comment"], "メモ")  # 他キーは保持

    def test_no_change_when_all_present(self):
        existing = {"codes": ["7203", "6758"]}
        updated, added = su.merge_universe(existing, ["7203", "6758"])
        self.assertEqual(added, [])
        self.assertEqual(updated["codes"], ["7203", "6758"])

    def test_empty_existing(self):
        updated, added = su.merge_universe({}, ["7203"])
        self.assertEqual(added, ["7203"])
        self.assertEqual(updated["codes"], ["7203"])


if __name__ == "__main__":
    unittest.main()
