#!/usr/bin/env python3
"""支持線・抵抗線のデータ (data/sr_levels.json) を生成する（TBK-0015。初版は TBK-0014）。

監視リスト（data/indicators_universe.json）の銘柄について、HypoLab の S/R エンジン
（srlevels・HYP-0005 共通プロトコル）と同一定義の**スイング水準**を計算し、
現在値の下＝支持線 / 上＝抵抗線 として近い順に最大 MAX_LEVELS 本を出力する。

水準定義（HypoLab config [sr] の検証済みパラメータと一致させる）:
  - スイング高値/安値: 前後 swing_n 日より突出（プロミネンス ≥ prom_atr × ATR14）した極値。
  - **誕生日 = 極値日 + swing_n 日**（確定遅延。look-ahead 排除＝PIT 安全）。
  - 寿命 life_days 日で失効。±merge_pct 以内の重複水準は古い方に統合。
  - 支持/抵抗の役割は固定しない: 現在値より下にある水準が支持線、上が抵抗線
    （抵抗→支持の役割転換を自然に含む）。

入力は datasource 層（TBK-0013）経由の調整後四本値（adj_high / adj_low / adj_close）。
**adj_high / adj_low は QDP R2 にしか無いため TRADEBOOK_DATA_SOURCE=r2 が必須**
（local では明示エラー終了。jquants-data は終値系のみ）。

使い方:
    TRADEBOOK_DATA_SOURCE=r2 python tools/gen_sr_levels.py
    TRADEBOOK_R2_URL_BASE=/path/to/silver-mirror python tools/gen_sr_levels.py  # ミラー検証用

出力 data/sr_levels.json（データ契約は TBK-0015）:
  {
    "updated": "2026-07-17",
    "source": "qdp-r2 fact_prices_daily (調整後四本値)",
    "params": { "swing_n": 4, "prom_atr": 0.5, "life_days": 120, "merge_pct": 0.01,
                "atr_window": 14, "max_levels": 3, "touch_band_atr": 0.5, "touch_cooldown": 10 },
    "stocks": [ { "code": "7203", "close": 3000,
                  "support": [2900.5, 2750], "resistance": [3100, 3250],   # 近い順・最大 max_levels 本
                  "support_touches": [3, 1], "resistance_touches": [2, 0] } ]  # 価格と同順の並行配列
  }
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PUBLIC_ROOT = HERE.parent
UNIVERSE_FILE = PUBLIC_ROOT / "data" / "indicators_universe.json"
OUT_FILE = PUBLIC_ROOT / "data" / "sr_levels.json"

# パラメータ（HypoLab config.toml [sr] の検証済み値と一致させる。変更は TBK-0015 の改訂とセット）
SWING_N = 4          # スイング判定の前後日数
PROM_ATR = 0.5       # プロミネンス条件（× ATR14）
LIFE_DAYS = 120      # 水準の有効期間（営業日）
MERGE_PCT = 0.01     # ±1% 以内の重複水準は古い方に統合
ATR_WINDOW = 14
MAX_LEVELS = 3       # 支持・抵抗それぞれの出力本数上限
TOUCH_BAND_ATR = 0.5  # タッチ判定バンド = ±0.5×ATR（HYP-0005 band_atr と一致）
TOUCH_COOLDOWN = 10   # 同一水準の再タッチ除外（HYP-0005 cooldown_days と一致）

# 必要履歴: 寿命 120 + ATR ウォームアップ + スイング確定遅延 + 余裕（休場ズレ）
INPUT_DAYS = LIFE_DAYS + ATR_WINDOW + 2 * SWING_N + 20

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


# ---- HypoLab srlevels.py（HYP-0005）からの移植。純粋関数・test_gen_sr_levels.py で検証 ----


def atr_series(h, l, c, window: int = ATR_WINDOW):  # noqa: E741
    """True Range の window 日単純平均（先頭 window 日は NaN）。srlevels.atr_series と同一。"""
    import numpy as np
    import pandas as pd

    h = np.asarray(h, dtype=float)
    l = np.asarray(l, dtype=float)  # noqa: E741
    c = np.asarray(c, dtype=float)
    prev_c = np.concatenate([[np.nan], c[:-1]])
    tr = np.maximum(h - l, np.maximum(np.abs(h - prev_c), np.abs(l - prev_c)))
    return pd.Series(tr).rolling(window, min_periods=window).mean().to_numpy()


def gen_swing_levels(h, l, c, atr, n: int = SWING_N, prom_atr: float = PROM_ATR,  # noqa: E741
                     life: int = LIFE_DAYS) -> list[dict]:
    """スイングポイント水準。誕生日 = 極値日 + n（確定遅延、look-ahead 排除）。

    srlevels.gen_swing_levels と同一判定。kind は "high"（スイング高値）/"low"（同安値）。
    """
    import numpy as np

    h = np.asarray(h, dtype=float)
    l = np.asarray(l, dtype=float)  # noqa: E741
    c = np.asarray(c, dtype=float)
    levels: list[dict] = []
    t_len = len(h)
    for t in range(n, t_len - n):
        if np.isnan(atr[t]):
            continue
        win_h = np.concatenate([h[t - n : t], h[t + 1 : t + n + 1]])
        win_l = np.concatenate([l[t - n : t], l[t + 1 : t + n + 1]])
        win_c = np.concatenate([c[t - n : t], c[t + 1 : t + n + 1]])
        if h[t] > win_h.max() and h[t] - win_c.max() >= prom_atr * atr[t]:
            levels.append({"level": float(h[t]), "birth": t + n, "expire": t + n + life,
                           "def_id": "swing", "kind": "high"})
        if l[t] < win_l.min() and win_c.min() - l[t] >= prom_atr * atr[t]:
            levels.append({"level": float(l[t]), "birth": t + n, "expire": t + n + life,
                           "def_id": "swing", "kind": "low"})
    return levels


def merge_close_levels(levels: list[dict], merge_pct: float = MERGE_PCT) -> list[dict]:
    """同一定義で ±merge_pct 以内に重なる水準を古い方に統合（新しい方を捨てる）。srlevels と同一。"""
    kept: list[dict] = []
    for lv in sorted(levels, key=lambda x: x["birth"]):
        dup = any(
            k["def_id"] == lv["def_id"]
            and abs(k["level"] - lv["level"]) <= merge_pct * lv["level"]
            and k["expire"] > lv["birth"]
            for k in kept
        )
        if not dup:
            kept.append(lv)
    return kept


def count_touches(level: float, birth: int, expire: int, h, l, atr,  # noqa: E741
                  band_atr: float = TOUCH_BAND_ATR, cooldown: int = TOUCH_COOLDOWN) -> int:
    """水準の誕生後〜最終日に、日中レンジがバンド（±band_atr×ATR）内へ入った回数（PIT 安全）。

    連続日は1回に数える（cooldown 日スキップ・HYP-0005 と同じ考え方）。回数が多いほど
    「市場が何度も意識した水準」＝信頼度の代理指標（タッチ後の反発までは検証しない）。
    """
    import numpy as np

    touches = 0
    t = birth
    t_end = min(expire, len(h) - 1)
    while t <= t_end:
        a = atr[t]
        if not np.isnan(a):
            band = band_atr * a
            if l[t] - band <= level <= h[t] + band:
                touches += 1
                t += cooldown + 1
                continue
        t += 1
    return touches


def pick_levels(levels: list[dict], t_last: int, close: float,
                max_levels: int = MAX_LEVELS) -> dict:
    """最終日 t_last 時点で有効（birth <= t_last <= expire）な水準を支持/抵抗に振り分ける。

    現在値より下＝支持線（近い順＝降順）、上＝抵抗線（近い順＝昇順）。各水準は
    {level, touches} を保持する（touches 未算出の水準は 0）。
    現在値と一致する水準は抵抗側に含めない（支持側にも含めない＝表示上の曖昧さ回避）。
    """
    active = [lv for lv in levels if lv["birth"] <= t_last <= lv["expire"]]
    sup = sorted((lv for lv in active if lv["level"] < close),
                 key=lambda x: x["level"], reverse=True)[:max_levels]
    res = sorted((lv for lv in active if lv["level"] > close),
                 key=lambda x: x["level"])[:max_levels]
    pack = lambda lvs: [{"level": lv["level"], "touches": int(lv.get("touches", 0))} for lv in lvs]  # noqa: E731
    return {"support": pack(sup), "resistance": pack(res)}


def compute_sr(panel, max_levels: int = MAX_LEVELS) -> dict:
    """長形式の四本値 DataFrame（code4/date/adj_high/adj_low/adj_close）から payload を計算する純粋関数。"""
    import pandas as pd

    if panel is None or len(panel) == 0:
        return {}

    panel = panel.copy()
    panel["date"] = pd.to_datetime(panel["date"])
    for col in ["adj_high", "adj_low", "adj_close"]:
        panel[col] = pd.to_numeric(panel[col], errors="coerce")
    panel = panel.dropna(subset=["adj_close"]).sort_values(["code4", "date"])

    stocks = []
    updated = ""
    for code4, sub in panel.groupby("code4", sort=True):
        # 高安欠損日は終値で埋める（保守的: TR が過小になり水準は減る方向＝誤検出しない）
        h = sub["adj_high"].fillna(sub["adj_close"]).to_numpy()
        l = sub["adj_low"].fillna(sub["adj_close"]).to_numpy()  # noqa: E741
        c = sub["adj_close"].to_numpy()
        if len(c) < ATR_WINDOW + 2 * SWING_N + 2:
            continue
        atr = atr_series(h, l, c, ATR_WINDOW)
        levels = merge_close_levels(gen_swing_levels(h, l, c, atr))
        for lv in levels:
            lv["touches"] = count_touches(lv["level"], lv["birth"], lv["expire"], h, l, atr)
        close = float(c[-1])
        picked = pick_levels(levels, len(c) - 1, close, max_levels)
        if not picked["support"] and not picked["resistance"]:
            continue
        updated = max(updated, sub["date"].iloc[-1].strftime("%Y-%m-%d"))
        stocks.append(
            {
                "code": str(code4),
                "close": round(close, 1),
                # support/resistance は価格のみの配列（後方互換）。touches は並行配列で追加（TBK-0015）
                "support": [round(x["level"], 1) for x in picked["support"]],
                "resistance": [round(x["level"], 1) for x in picked["resistance"]],
                "support_touches": [x["touches"] for x in picked["support"]],
                "resistance_touches": [x["touches"] for x in picked["resistance"]],
            }
        )

    if not stocks:
        return {}
    return {
        "updated": updated,
        "source": "qdp-r2 fact_prices_daily (調整後四本値)",
        "params": {
            "swing_n": SWING_N,
            "prom_atr": PROM_ATR,
            "life_days": LIFE_DAYS,
            "merge_pct": MERGE_PCT,
            "atr_window": ATR_WINDOW,
            "max_levels": max_levels,
            "touch_band_atr": TOUCH_BAND_ATR,
            "touch_cooldown": TOUCH_COOLDOWN,
        },
        "stocks": stocks,
    }


def _load_panel(universe: set[str]):
    """監視リスト銘柄の調整後四本値を長形式で返す（code4, date, adj_high, adj_low, adj_close）。"""
    import datasource
    import pandas as pd

    df = datasource.load_price_panel(
        INPUT_DAYS, ["adj_high", "adj_low", "adj_close"], codes4=universe
    )
    if df.empty:
        return pd.DataFrame(columns=["code4", "date", "adj_high", "adj_low", "adj_close"])
    df = df.copy()
    df["code4"] = df["code"].astype(str).str[:4]
    return df[["code4", "date", "adj_high", "adj_low", "adj_close"]]


def main() -> int:
    import datasource

    if not datasource.use_r2():
        print(
            "gen_sr_levels.py は調整後高安（adj_high/adj_low）が必要なため "
            "TRADEBOOK_DATA_SOURCE=r2 でのみ実行できます（TBK-0015。jquants-data は終値系のみ）。",
            file=sys.stderr,
        )
        return 2

    universe = load_universe()
    if not universe:
        print("監視リスト（data/indicators_universe.json の codes）が空です。対象銘柄を追加してください。")
        return 0

    panel = _load_panel(set(universe))
    payload = compute_sr(panel)
    if not payload:
        print("支持線・抵抗線を計算できる銘柄がありません（履歴不足か高安未配信）。", file=sys.stderr)
        return 1

    missing = [c for c in universe if c not in {s["code"] for s in payload["stocks"]}]
    for c in missing:
        print(f"  - {c}: 水準なし（履歴不足・有効水準ゼロ）", file=sys.stderr)

    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
    OUT_FILE.write_text(text, encoding="utf-8")
    print(f"生成完了: {OUT_FILE}（{len(payload['stocks'])}/{len(universe)}銘柄・基準日 {payload['updated']}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
