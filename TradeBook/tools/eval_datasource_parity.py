#!/usr/bin/env python3
"""データソース切替（TBK-0013）の Code-grader: local と r2 の入力パリティ突合。

gen_*.py は入力パネルの決定論的な純粋関数なので、**入力の一致 ⇒ 出力 JSON の一致**。
本スクリプトは両バックエンドから同一窓の株価を読み、行レベルで突合して PASS/FAIL を返す。

検査項目（2026-07-20 の実 R2 測定を受けて精緻化。詳細は TBK-0013 の Eval 定義）:
  P1 日付集合   : 直近 N 営業日の date 集合が一致
  P2 行カバレッジ: **local ⊆ r2**（local の (code,date) キーの被覆率 ≥ 99.9%）。
                   r2 のみの行（ETF/REIT・新形式コード等 jquants-data 抽出対象外）は
                   追加収録＝INFO 扱い（失敗にしない）
  P3 値一致     : 共通キーの trading_value / close は相対差 ≤ 1e-9 の完全一致。
                   adj_close の不一致は銘柄ごとに r2/local 比を検査し、**比が一定なら
                   分割の遡及調整差（R2 が権威・QDP-0040。local の日別ファイルは凍結で stale）**
                   として許容（INFO）。比が一定でない不一致のみ FAIL
  P4 最新終値   : 基準日一致 ∧ local コードの被覆率 ≥ 99.9% ∧ 共通コードの値一致

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

    # P2: local ⊆ r2 のカバレッジ（r2 のみの行は追加収録＝INFO）
    k_local = set(zip(local["code"], local["date"]))
    k_r2 = set(zip(r2["code"], r2["date"]))
    common = k_local & k_r2
    cov = len(common) / len(k_local) if k_local else 0.0
    extra = len(k_r2 - k_local)
    p2 = cov >= COVERAGE_MIN
    ok &= p2
    print(f"P2 行カバレッジ（local⊆r2）: {'PASS' if p2 else 'FAIL'}"
          f"（local {len(k_local):,} 中 {len(common):,} 被覆 = {cov:.6f} ／ "
          f"r2 のみ {extra:,} 行は追加収録=INFO）")

    # P3: 共通キーの値一致（adj_close は分割の遡及調整差を判別して許容）
    m = local.merge(r2, on=["code", "date"], suffixes=("_l", "_r"))
    bad_total = 0
    for c in ("trading_value", "close"):
        lv, rv = m[f"{c}_l"], m[f"{c}_r"]
        both = lv.notna() & rv.notna()
        denom_v = lv[both].abs().clip(lower=1.0)
        bad = ((lv[both] - rv[both]).abs() / denom_v > REL_TOL).sum()
        onesided = (lv.isna() != rv.isna()).sum()
        bad_total += int(bad) + int(onesided)
        print(f"   - {c}: 相対差>{REL_TOL} が {int(bad)} 行 / 片側欠損 {int(onesided)} 行")

    # adj_close: 不一致行を銘柄別に見て、r2/local 比が一定なら分割の遡及調整差（R2 が権威）
    lv, rv = m["adj_close_l"], m["adj_close_r"]
    both = lv.notna() & rv.notna()
    bad_total += int((lv.isna() != rv.isna()).sum())
    mm = m[both & ((lv - rv).abs() / lv.abs().clip(lower=1.0) > REL_TOL)].copy()
    adj_revised_codes = []
    adj_bad = 0
    if not mm.empty:
        mm["ratio"] = mm["adj_close_r"] / mm["adj_close_l"]
        for code, sub in mm.groupby("code"):
            ratios = sub["ratio"]
            if (ratios.max() - ratios.min()) <= 1e-6:
                adj_revised_codes.append((code, round(float(ratios.iloc[0]), 6), len(sub)))
            else:
                adj_bad += len(sub)
    bad_total += adj_bad
    if adj_revised_codes:
        heads = ", ".join(f"{c}(×{r})" for c, r, _ in adj_revised_codes[:6])
        n_rows = sum(n for _, _, n in adj_revised_codes)
        print(f"   - adj_close: 分割の遡及調整差 {len(adj_revised_codes)} 銘柄 {n_rows} 行を許容"
              f"（R2 が権威・INFO。例: {heads}）")
    print(f"   - adj_close: 遡及差で説明できない不一致 {adj_bad} 行")
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
    cov4 = len(common_codes) / max(len(lm), 1)  # local ⊆ r2 の被覆率（r2 のみの銘柄は追加収録=INFO）
    p4 = (ld == rd) and not diff and cov4 >= COVERAGE_MIN
    ok &= p4
    print(f"P4 最新終値: {'PASS' if p4 else 'FAIL'}"
          f"（基準日 local={sorted(ld)} r2={sorted(rd)} / local {len(lm):,} 銘柄中 "
          f"{len(common_codes):,} 被覆 = {cov4:.6f} / r2 のみ {len(set(rm) - set(lm)):,} 銘柄=INFO / "
          f"値不一致 {len(diff)} 件）")

    print(f"\n総合判定: {'PASS ✅' if ok else 'FAIL ❌'}（TBK-0013 P1〜P4）")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
