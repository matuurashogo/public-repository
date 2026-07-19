#!/usr/bin/env python3
"""データソース切替（TBK-0013）の Code-grader: local と r2 の入力パリティ突合。

gen_*.py は入力パネルの決定論的な純粋関数なので、**入力の一致 ⇒ 出力 JSON の一致**。
本スクリプトは両バックエンドから同一窓の株価を読み、行レベルで突合して PASS/FAIL を返す。

検査項目:
  P1 日付集合   : 直近 N 営業日の date 集合が一致
  P2 行カバレッジ: (code, date) キーの一致率 ≥ 99.9%（上場廃止・新規上場のタイミング差を許容）
  P3 値一致     : 共通キーの adj_close / trading_value / close の相対差 ≤ 1e-9（実質完全一致）
  P4 最新終値   : load_latest_prices() の date と価格 map が一致

使い方（jquants-data ローカル + R2 資格情報の両方が必要）:
    TRADEBOOK_R2_URL_BASE でローカルミラーに向けた確認も可（資格情報不要）。
    python tools/eval_datasource_parity.py [--days 30]

終了コード: 0=PASS / 1=FAIL / 2=実行不能（資格情報・データ欠如）
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import datasource  # noqa: E402

REL_TOL = 1e-9
COVERAGE_MIN = 0.999


def _load_both(days: int):
    import pandas as pd  # noqa: F401

    os.environ["TRADEBOOK_DATA_SOURCE"] = "local"
    local = datasource.load_price_panel(days, ["adj_close", "trading_value", "close"])
    local_latest = datasource.load_latest_prices()
    os.environ["TRADEBOOK_DATA_SOURCE"] = "r2"
    r2 = datasource.load_price_panel(days, ["adj_close", "trading_value", "close"])
    r2_latest = datasource.load_latest_prices()
    return local, r2, local_latest, r2_latest


def _norm(df):
    import pandas as pd

    out = df.copy()
    out["code"] = out["code"].astype(str)
    out["date"] = pd.to_datetime(out["date"]).dt.strftime("%Y-%m-%d")
    for c in ("adj_close", "trading_value", "close"):
        if c in out.columns:
            out[c] = pd.to_numeric(out[c], errors="coerce")
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30, help="突合する直近営業日数（既定30）")
    args = ap.parse_args()

    try:
        local, r2, local_latest, r2_latest = _load_both(args.days)
    except Exception as e:
        print(f"実行不能: {e}", file=sys.stderr)
        return 2

    import pandas as pd

    local, r2 = _norm(local), _norm(r2)
    ok = True

    # P1: 日付集合
    d_local, d_r2 = set(local["date"]), set(r2["date"])
    p1 = d_local == d_r2
    ok &= p1
    print(f"P1 日付集合一致: {'PASS' if p1 else 'FAIL'}"
          f"（local {len(d_local)}日 / r2 {len(d_r2)}日"
          f"{'' if p1 else f' / 差分 {sorted(d_local ^ d_r2)[:5]}...'}）")

    # P2: (code,date) カバレッジ
    k_local = set(zip(local["code"], local["date"]))
    k_r2 = set(zip(r2["code"], r2["date"]))
    common = k_local & k_r2
    denom = max(len(k_local), len(k_r2))
    cov = len(common) / denom if denom else 0.0
    p2 = cov >= COVERAGE_MIN
    ok &= p2
    print(f"P2 行カバレッジ: {'PASS' if p2 else 'FAIL'}"
          f"（一致 {len(common):,} / local {len(k_local):,} / r2 {len(k_r2):,} = {cov:.6f}）")

    # P3: 共通キーの値一致
    m = local.merge(r2, on=["code", "date"], suffixes=("_l", "_r"))
    bad_total = 0
    for c in ("adj_close", "trading_value", "close"):
        lv, rv = m[f"{c}_l"], m[f"{c}_r"]
        both = lv.notna() & rv.notna()
        denom_v = lv[both].abs().clip(lower=1.0)
        bad = ((lv[both] - rv[both]).abs() / denom_v > REL_TOL).sum()
        onesided = (lv.isna() != rv.isna()).sum()
        bad_total += int(bad) + int(onesided)
        print(f"   - {c}: 相対差>{REL_TOL} が {int(bad)} 行 / 片側欠損 {int(onesided)} 行")
    p3 = bad_total == 0
    ok &= p3
    print(f"P3 値一致: {'PASS' if p3 else 'FAIL'}（不一致合計 {bad_total} 行）")

    # P4: 最新終値
    def latest_map(df):
        df = _norm(df)
        return dict(zip(df["code"], df["adj_close"].fillna(df["close"])))

    lm, rm = latest_map(local_latest), latest_map(r2_latest)
    ld = set(_norm(local_latest)["date"]) | set()
    rd = set(_norm(r2_latest)["date"]) | set()
    common_codes = set(lm) & set(rm)
    diff = [c for c in common_codes
            if pd.notna(lm[c]) and pd.notna(rm[c]) and abs(lm[c] - rm[c]) / max(abs(lm[c]), 1.0) > REL_TOL]
    cov4 = len(common_codes) / max(len(lm), len(rm), 1)
    p4 = (ld == rd) and not diff and cov4 >= COVERAGE_MIN
    ok &= p4
    print(f"P4 最新終値: {'PASS' if p4 else 'FAIL'}"
          f"（基準日 local={sorted(ld)} r2={sorted(rd)} / 共通 {len(common_codes):,} 銘柄・"
          f"カバレッジ {cov4:.6f} / 値不一致 {len(diff)} 件）")

    print(f"\n総合判定: {'PASS ✅' if ok else 'FAIL ❌'}（TBK-0013 P1〜P4）")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
