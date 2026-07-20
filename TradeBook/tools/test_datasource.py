#!/usr/bin/env python3
"""datasource.py の単体テスト（TBK-0013）。

fixture の Parquet を一時ディレクトリに作り、
  - local バックエンド（jquants-data 形式の prices_YYYYMMDD.parquet 群）
  - r2 バックエンド（fact_prices_daily / dim_listed 形式。TRADEBOOK_R2_URL_BASE で
    ローカルパスに差し替え＝資格情報・ネットワーク不要）
の両方から同一内容を読み、**正規化後の DataFrame が一致する**こと（パリティ）を検証する。
実 R2 に対する突合は tools/eval_datasource_parity.py（要資格情報）で行う。
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import datasource  # noqa: E402


def _write_fixtures(root: Path) -> None:
    """local（jquants-data 形式）と r2（QDP silver 形式）の fixture を同一内容で作る。"""
    import pandas as pd

    # 3営業日 × 3銘柄。7203 のみ 7/03 の adj_close が欠損（close フォールバック検証用）
    rows = []
    for d, mult in [(date(2026, 7, 1), 1.0), (date(2026, 7, 2), 1.01), (date(2026, 7, 3), 0.99)]:
        rows += [
            {"code": "72030", "date": d, "close": 3000 * mult, "adj_close": 3000 * mult,
             "adj_volume": 1000, "trading_value": 9_000_000.0, "is_limit": False, "adj_factor": 1.0},
            {"code": "83060", "date": d, "close": 2000 * mult, "adj_close": 2000 * mult,
             "adj_volume": 2000, "trading_value": 4_000_000.0, "is_limit": False, "adj_factor": 1.0},
            {"code": "130A0", "date": d, "close": 500 * mult, "adj_close": 500 * mult,
             "adj_volume": 3000, "trading_value": 1_500_000.0, "is_limit": False, "adj_factor": 1.0},
        ]
    df = pd.DataFrame(rows)
    df.loc[(df["code"] == "72030") & (df["date"] == date(2026, 7, 3)), "adj_close"] = float("nan")

    # local: prices_YYYYMMDD.parquet（日別分割）＋ prices_latest.parquet
    prices_dir = root / "jquants-data" / "prices"
    prices_dir.mkdir(parents=True)
    for d, sub in df.groupby("date"):
        sub.to_parquet(prices_dir / f"prices_{d.strftime('%Y%m%d')}.parquet", index=False)
    latest = df[df["date"] == date(2026, 7, 3)]
    latest.to_parquet(prices_dir / "prices_latest.parquet", index=False)
    # 除外されるべきファイル（latest/stats）も置いて誤読しないことを確認
    latest.to_parquet(prices_dir / "prices_stats.parquet", index=False)

    # local: full/sector33_<S33>_full.parquet（業種マップ用。code 列だけで十分）
    full_dir = root / "jquants-data" / "full"
    full_dir.mkdir(parents=True)
    pd.DataFrame({"code": ["72030"], "company": ["トヨタ自動車"]}).to_parquet(
        full_dir / "sector33_3700_full.parquet", index=False
    )
    pd.DataFrame({"code": ["83060", "130A0"], "company": ["三菱UFJ", "ベースフード"]}).to_parquet(
        full_dir / "sector33_7100_full.parquet", index=False
    )

    # r2 ミラー: fact_prices_daily（code5 / turnover_value 名）＋ dim_listed
    mirror = root / "silver"
    mirror.mkdir(parents=True)
    r2p = df.rename(columns={"code": "code5", "trading_value": "turnover_value"})
    r2p.to_parquet(mirror / "fact_prices_daily.parquet", index=False)
    pd.DataFrame(
        {
            "code5": ["72030", "83060", "130A0"],
            "code4": ["7203", "8306", "130A"],
            "company_name": ["トヨタ自動車", "三菱UFJ", "ベースフード"],
            "sector33": ["3700", "7100", "7100"],
        }
    ).to_parquet(mirror / "dim_listed.parquet", index=False)


class _EnvBase(unittest.TestCase):
    """fixture 一式と環境変数の切替を共通化する基底クラス。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        _write_fixtures(self.root)
        self._saved = {
            k: os.environ.get(k)
            for k in ("TRADEBOOK_DATA_SOURCE", "TRADEBOOK_R2_URL_BASE", "JQUANTS_PARQUET_REPO")
        }
        os.environ["JQUANTS_PARQUET_REPO"] = str(self.root / "jquants-data")
        os.environ["TRADEBOOK_R2_URL_BASE"] = str(self.root / "silver")

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self._tmp.cleanup()

    def _set_source(self, value: str):
        os.environ["TRADEBOOK_DATA_SOURCE"] = value


def _normalize(df):
    """比較用の正規化（列順・行順・dtype を揃える）。"""
    import pandas as pd

    out = df.copy()
    out["code"] = out["code"].astype(str)
    out["date"] = pd.to_datetime(out["date"]).astype("datetime64[ns]")
    num_cols = [c for c in out.columns if c not in ("code", "date", "is_limit")]
    for c in num_cols:
        out[c] = pd.to_numeric(out[c], errors="coerce").astype(float)
    return (
        out.sort_values(["date", "code"]).reset_index(drop=True)[sorted(out.columns)]
    )


class TestBackendParity(_EnvBase):
    """local と r2（ミラー基底）が同一の正規化 DataFrame を返すこと＝TBK-0013 の核心。"""

    def test_price_panel_parity(self):
        import pandas as pd

        self._set_source("local")
        local = datasource.load_price_panel(3, ["adj_close", "trading_value"])
        self._set_source("r2")
        r2 = datasource.load_price_panel(3, ["adj_close", "trading_value"])
        pd.testing.assert_frame_equal(_normalize(local), _normalize(r2))

    def test_price_panel_parity_with_universe_filter(self):
        import pandas as pd

        universe = {"7203", "130A"}
        self._set_source("local")
        local = datasource.load_price_panel(3, ["adj_close"], codes4=universe)
        self._set_source("r2")
        r2 = datasource.load_price_panel(3, ["adj_close"], codes4=universe)
        self.assertEqual(sorted(set(local["code"])), ["130A0", "72030"])
        pd.testing.assert_frame_equal(_normalize(local), _normalize(r2))

    def test_last_n_limits_dates(self):
        self._set_source("r2")
        r2 = datasource.load_price_panel(2, ["adj_close"])
        self.assertEqual(len(set(map(str, r2["date"]))), 2)
        self.assertNotIn("2026-07-01", {str(d)[:10] for d in r2["date"]})

    def test_latest_prices_parity(self):
        import pandas as pd

        self._set_source("local")
        local = datasource.load_latest_prices()
        self._set_source("r2")
        r2 = datasource.load_latest_prices()
        pd.testing.assert_frame_equal(_normalize(local), _normalize(r2))
        # 最新営業日のみが返ること
        self.assertEqual({str(d)[:10] for d in r2["date"]}, {"2026-07-03"})

    def test_sector_map_grouping_consistency(self):
        """業種キーの表記は違ってよいが、グルーピング（同じ業種に集まる集合）は一致すること。"""
        self._set_source("local")
        local = datasource.load_sector33_map()
        self._set_source("r2")
        r2 = datasource.load_sector33_map()
        self.assertEqual(set(local), set(r2))  # 対象コード集合が一致

        def groups(m):
            g = {}
            for c, s in m.items():
                g.setdefault(s, set()).add(c)
            return sorted(map(sorted, g.values()))

        self.assertEqual(groups(local), groups(r2))


class TestR2Behavior(_EnvBase):
    def test_company_names_r2_only(self):
        self._set_source("r2")
        names = datasource.load_company_names()
        self.assertEqual(names["7203"], "トヨタ自動車")
        self.assertEqual(names["130A"], "ベースフード")
        self._set_source("local")
        with self.assertRaises(RuntimeError):
            datasource.load_company_names()

    def test_local_rejects_r2_only_columns(self):
        self._set_source("local")
        with self.assertRaises(ValueError):
            datasource.load_price_panel(3, ["adj_high", "adj_low"])

    def test_codes4_predicate_rejects_injection(self):
        # 不正なコード（SQL 断片）は正規表現検証で落ちる＝述語に載らない
        self.assertEqual(datasource._codes4_predicate({"7203'; DROP--"}), "")
        self.assertIn("'7203'", datasource._codes4_predicate({"7203"}))

    def test_unknown_source_env_raises(self):
        self._set_source("bigquery")
        with self.assertRaises(ValueError):
            datasource.use_r2()


if __name__ == "__main__":
    unittest.main(verbosity=1)
