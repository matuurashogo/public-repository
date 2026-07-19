#!/usr/bin/env python3
"""保有銘柄の利確目標（ボラ連動）用に、銘柄ごとの σ20 を生成する（TBK-0010）。

別リポジトリ jquants-data の日次株価 `prices/prices_YYYYMMDD.parquet` を結合し、
監視リスト（data/indicators_universe.json）の銘柄について σ20（直近20日の日次リターン標準偏差）を
計算して 1ファイルの JSON（data/volatility.json）に出力する。データ契約は TBK-0010 を参照。

利確目標価格そのものはポジション固有（取得単価が必要）なため、ここでは σ20 までを配信し、
目標 = 取得単価 ×(1 + min(cap, max(floor, k×σ20))) はアプリ側（js/selltarget.js）で合成する。
算出パラメータ（window / k / floor / cap）も JSON に載せ、表示側がハードコードしないようにする。

入力は datasource 層（TBK-0013）経由。TRADEBOOK_DATA_SOURCE=r2 で QDP R2 から読める。
jquants-data の場所は gen_buy_levels.py / gen_indicators.py と同じ優先順で自動検出する:
  1. 環境変数 JQUANTS_PARQUET_REPO
  2. 兄弟ディレクトリ ../jquants-data

使い方:
    python tools/gen_volatility.py
    JQUANTS_PARQUET_REPO=/path/to/jquants-data python tools/gen_volatility.py
"""

from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PUBLIC_ROOT = HERE.parent
UNIVERSE_FILE = PUBLIC_ROOT / "data" / "indicators_universe.json"
OUT_FILE = PUBLIC_ROOT / "data" / "volatility.json"

# 利確幅パラメータ（変更はスキーマ変更扱い。TBK-0010 の改訂とセットで行うこと）
SIGMA_WINDOW = 20   # σ算出の窓（日次リターン・営業日）
TP_K = 2.0          # 利確幅 = min(cap, max(floor, k×σ20))。TBK-0011 で 2.5→2.0 に改定（高ボラ銘柄の目標が遠すぎたため）
TP_FLOOR = 0.05     # 利確幅の下限（現行+5%を死守）
TP_CAP = 0.15       # 利確幅の上限（高ボラ銘柄の暴走防止）

# 必要履歴: σ20 は 21本の終値が要る。休場ズレの余裕を持たせる。
INPUT_DAYS = SIGMA_WINDOW + 15

_CODE_RE = re.compile(r"[0-9][0-9A-Z]{3}")


def load_universe() -> list[str]:
    """監視リスト（4桁コード）を読む。重複・不正コードは除く（gen_buy_levels.py と同一）。"""
    data = json.loads(UNIVERSE_FILE.read_text(encoding="utf-8"))
    codes = data.get("codes", []) if isinstance(data, dict) else []
    out: list[str] = []
    seen: set[str] = set()
    for c in codes:
        c4 = str(c)[:4]
        if _CODE_RE.fullmatch(c4) and c4 not in seen:
            seen.add(c4)
            out.append(c4)
    return out


def _load_panel(universe: set[str]):
    """監視リスト銘柄の日次株価を結合した長形式 DataFrame を返す（code4, date, adj_close）。

    入力源は datasource 層で切替（local=jquants-data / r2=QDP silver。TBK-0013）。
    """
    import datasource
    import pandas as pd

    df = datasource.load_price_panel(INPUT_DAYS, ["adj_close"], codes4=universe)
    if df.empty:
        return pd.DataFrame(columns=["code4", "date", "adj_close"])
    df = df.copy()
    df["code4"] = df["code"].astype(str).str[:4]
    return df[["code4", "date", "adj_close"]]


def compute_sigma20(closes: list[float], window: int = SIGMA_WINDOW) -> float | None:
    """直近 window 日の日次単純リターン標準偏差（標本・ddof=1）。pandas 非依存・テスト対象。

    window+1 本の終値が要る（リターンが window 本得られる）。履歴不足・非正の価格は None。
    """
    if closes is None or len(closes) < window + 1:
        return None
    series = closes[-(window + 1):]
    rets = []
    for i in range(1, len(series)):
        p0 = series[i - 1]
        if p0 <= 0:
            return None
        rets.append(series[i] / p0 - 1.0)
    if len(rets) < 2:
        return None
    mean = sum(rets) / len(rets)
    var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
    return math.sqrt(var)


def compute_volatility(
    panel,
    window: int = SIGMA_WINDOW,
    k: float = TP_K,
    floor: float = TP_FLOOR,
    cap: float = TP_CAP,
    source: str = "jquants-data prices",
) -> dict:
    """長形式の株価 DataFrame から volatility.json の payload を計算する純粋関数（テスト対象）。"""
    import pandas as pd

    if panel is None or len(panel) == 0:
        return {}

    panel = panel.copy()
    panel["date"] = pd.to_datetime(panel["date"])
    panel["adj_close"] = pd.to_numeric(panel["adj_close"], errors="coerce")
    panel = panel.dropna(subset=["adj_close"])
    panel = panel.sort_values(["code4", "date"]).reset_index(drop=True)

    sigma: dict[str, float] = {}
    updated = ""
    for code4, sub in panel.groupby("code4", sort=True):
        closes = sub["adj_close"].tolist()
        s = compute_sigma20(closes, window)
        if s is None:
            continue
        updated = max(updated, sub["date"].iloc[-1].strftime("%Y-%m-%d"))
        sigma[str(code4)] = round(float(s), 4)

    if not sigma:
        return {}
    return {
        "updated": updated,
        "source": f"{source} (調整後終値ベース)",
        "window": window,
        "k": k,
        "floor": floor,
        "cap": cap,
        "sigma": sigma,
    }


def main() -> int:
    import datasource

    if not datasource.use_r2() and not datasource.find_prices_dir():
        print(
            "jquants-data の prices/ が見つかりません。環境変数 JQUANTS_PARQUET_REPO で指定してください。",
            file=sys.stderr,
        )
        return 1

    universe = load_universe()
    if not universe:
        print("監視リスト（data/indicators_universe.json の codes）が空です。対象銘柄を追加してください。")
        return 0

    panel = _load_panel(set(universe))
    payload = compute_volatility(panel, source=datasource.source_label())
    if not payload:
        print("σ20を計算できる銘柄がありません（履歴不足の可能性）。", file=sys.stderr)
        return 1

    missing = [c for c in universe if c not in payload["sigma"]]
    for c in missing:
        print(f"  - {c}: σ20算出不可（jquants-data に履歴が無いか21日未満）", file=sys.stderr)

    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
    OUT_FILE.write_text(text, encoding="utf-8")
    print(f"生成完了: {OUT_FILE}（{len(payload['sigma'])}/{len(universe)}銘柄・基準日 {payload['updated']}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
