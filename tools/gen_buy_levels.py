#!/usr/bin/env python3
"""買いレベルボードのデータ (data/buy_levels.json) を生成する。

別リポジトリ jquants-data の日次株価 `prices/prices_YYYYMMDD.parquet` を結合し、
監視リスト（data/indicators_universe.json）の銘柄について「あといくら下がったら買いか」の
レベル価格6本を計算して1ファイルの JSON に出力する。データ契約は TBK-0006 を参照。

レベル定義（調整後終値ベース・終値のみで完結）:
  - L1: MA25（25日移動平均）          定番の押し目
  - L2: MA25 × 0.95                   やや深い押し
  - L3: MA25 × 0.92                   深い凹み（VolDipSignals reversal と同水準）
  - L4: 直近20日最高終値 × 0.90        高値からの押し率（浅め）
  - L5: 直近20日最高終値 × 0.85        高値からの押し率（深め）
  - L6: 直近60日最安終値               サポートライン（下値の節目）の代理

付随情報:
  - rebound = 陽転フラグ（最新終値 > 前日終値）。
  - tsureyasu = 連れ安度（TBK-0009 / 2段化は TBK-0012）。自銘柄の5日下落率と同業種ユニバース
    平均の差（残差）を出す。confirmed（急落イベント・HypoLab H84 準拠）は「連れ安 / 個別急落」を
    判定し、candidate（急落未満の観測層）は tag を付けず生 resid のみ（較正用）。

jquants-data の場所は gen_indicators.py と同じ優先順で自動検出する:
  1. 環境変数 JQUANTS_PARQUET_REPO
  2. 兄弟ディレクトリ ../jquants-data

使い方:
    python tools/gen_buy_levels.py
    JQUANTS_PARQUET_REPO=/path/to/jquants-data python tools/gen_buy_levels.py
"""

from __future__ import annotations

import glob
import json
import math
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PUBLIC_ROOT = HERE.parent
PARENT = PUBLIC_ROOT.parent
UNIVERSE_FILE = PUBLIC_ROOT / "data" / "indicators_universe.json"
OUT_FILE = PUBLIC_ROOT / "data" / "buy_levels.json"

# レベルパラメータ（変更はスキーマ変更扱い。TBK-0006 の改訂とセットで行うこと）
MA_SHORT = 25
HIGH_WINDOW = 20
LOW_WINDOW = 60
NEAR_THRESHOLD = 0.03  # 「接近」判定の閾値（表示・通知側はこの値を JSON から参照する）

# 連れ安度（TBK-0009 / HypoLab H84・リバウンド台帳 HYP-0011 準拠）。終値のみで完結。
CRASH_WINDOW = 5        # 急落判定・5日下落率の窓（営業日）
VOL_WINDOW = 60         # 実現ボラ σ の窓（日次リターン、営業日）
VOL_SHIFT = 5           # σ 算出時に末尾から除く日数（急落窓の混入防止）
SIGMA_MULT = 3.0        # 急落閾値: r5 ≤ −3σ√5
HARD_DROP = -0.15       # 急落閾値: または r5 ≤ −15%
MIN_CRASH_DROP = -0.05  # σルールの下限ガード（低ボラ株の微小変動を急落としない。HypoLabの高ボラ母集団の代替）
TSUREYASU_RESID_THRESHOLD = -0.03  # 残差 ≤ これ → 個別急落、それ以外 → 連れ安（暫定・較正で確定）
CANDIDATE_DROP = -0.08  # candidate（観測中）層の下落しきい（TBK-0012）。急落未満だが r5 ≤ これ で観測対象
EXCLUDE_SECTOR = "9999"  # 業種平均から除く（その他）
MIN_SECTOR_PRICE = 100.0  # 業種平均ユニバースの最低終値（H84 ユニバースの簡略版）

# 必要履歴: 60日安値 / σ60＋シフト5＋急落窓5 のうち長い方 + 余裕（休場ズレ）。
INPUT_DAYS = max(LOW_WINDOW, VOL_WINDOW + VOL_SHIFT + CRASH_WINDOW) + 15

_CANDIDATE_JQUANTS_REPOS = [
    os.environ.get("JQUANTS_PARQUET_REPO", ""),
    str(PARENT / "jquants-data"),
]


def _find_prices_dir() -> str | None:
    for base in _CANDIDATE_JQUANTS_REPOS:
        if not base:
            continue
        p = Path(base) / "prices"
        if p.is_dir():
            return str(p.resolve())
    return None


def _find_full_dir() -> str | None:
    """jquants-data の full/（sector33_*.parquet 群）を探す。連れ安度の業種マップ用。"""
    for base in _CANDIDATE_JQUANTS_REPOS:
        if not base:
            continue
        p = Path(base) / "full"
        if p.is_dir() and any(p.glob("sector33_*.parquet")):
            return str(p.resolve())
    return None


def load_sector_map(full_dir: str | None) -> dict[str, str]:
    """code4 → 33業種コード(S33) を full/sector33_<S33>_full.parquet から作る（TBK-0009）。

    ファイル名の S33 を業種コード、各ファイルの `code` 列を構成銘柄とする（gen_stocks.py と同方式）。
    pyarrow が無い・full/ が無い場合は空 dict を返す（連れ安度は無効化＝劣化動作）。
    """
    if not full_dir:
        return {}
    try:
        import pyarrow.parquet as pq  # type: ignore
    except ImportError:
        print("  注意: pyarrow が無いため連れ安度（業種マップ）をスキップします。", file=sys.stderr)
        return {}

    mapping: dict[str, str] = {}
    pat = re.compile(r"sector33_([0-9A-Za-z]+)_full\.parquet$")
    for path in sorted(glob.glob(os.path.join(full_dir, "sector33_*.parquet"))):
        m = pat.search(os.path.basename(path))
        if not m:
            continue
        s33 = m.group(1)
        codes = pq.read_table(path, columns=["code"]).column("code").to_pylist()
        for code in codes:
            if code is None:
                continue
            c4 = str(code)[:4]
            if re.fullmatch(r"[0-9][0-9A-Z]{3}", c4):
                mapping.setdefault(c4, s33)
    return mapping


def load_universe() -> list[str]:
    """監視リスト（4桁コード）を読む。重複・不正コードは除く（gen_indicators.py と同一）。"""
    data = json.loads(UNIVERSE_FILE.read_text(encoding="utf-8"))
    codes = data.get("codes", []) if isinstance(data, dict) else []
    out: list[str] = []
    seen: set[str] = set()
    for c in codes:
        c4 = str(c)[:4]
        if re.fullmatch(r"[0-9][0-9A-Z]{3}", c4) and c4 not in seen:
            seen.add(c4)
            out.append(c4)
    return out


def _daily_price_files(prices_dir: str, last_n: int) -> list[str]:
    """prices_YYYYMMDD.parquet を日付順で直近 last_n 件返す（latest/stats/split は除外）。"""
    files = []
    for path in glob.glob(os.path.join(prices_dir, "prices_*.parquet")):
        digits = os.path.basename(path).replace("prices_", "").replace(".parquet", "")
        if digits.isdigit():
            files.append(path)
    files.sort()
    return files[-last_n:] if last_n else files


def _load_panel(prices_dir: str, universe: set[str]):
    """監視リスト銘柄の日次株価を結合した長形式 DataFrame を返す（code4, date, adj_close）。"""
    import pandas as pd

    files = _daily_price_files(prices_dir, INPUT_DAYS)
    if not files:
        raise FileNotFoundError(f"price parquet が見つかりません: {prices_dir}")

    frames = []
    for path in files:
        df = pd.read_parquet(path, columns=["code", "date", "adj_close"])
        df["code4"] = df["code"].astype(str).str[:4]
        df = df[df["code4"].isin(universe)]
        if not df.empty:
            frames.append(df)
    if not frames:
        return pd.DataFrame(columns=["code4", "date", "adj_close"])
    return pd.concat(frames, ignore_index=True)


def _load_full_closes(prices_dir: str, last_n: int) -> dict[str, list[float]]:
    """全上場銘柄の直近 last_n 日の調整後終値を code4 → [古→新] で返す（業種平均の母集団用）。"""
    import pandas as pd

    files = _daily_price_files(prices_dir, last_n)
    if not files:
        return {}
    frames = []
    for path in files:
        df = pd.read_parquet(path, columns=["code", "date", "adj_close"])
        df["code4"] = df["code"].astype(str).str[:4]
        frames.append(df[["code4", "date", "adj_close"]])
    panel = pd.concat(frames, ignore_index=True)
    panel["date"] = pd.to_datetime(panel["date"])
    panel["adj_close"] = pd.to_numeric(panel["adj_close"], errors="coerce")
    panel = panel.dropna(subset=["adj_close"]).sort_values(["code4", "date"])
    return {code4: sub["adj_close"].tolist() for code4, sub in panel.groupby("code4", sort=False)}


# ---- 連れ安度（TBK-0009 / HypoLab H84）の純粋関数群。pandas 非依存・test_tsureyasu.py で検証 ----


def five_day_return(closes: list[float], window: int = CRASH_WINDOW) -> float | None:
    """最新終値の window 日下落率 = 終値[-1]/終値[-1-window] − 1。履歴不足は None。"""
    if closes is None or len(closes) < window + 1:
        return None
    base = closes[-1 - window]
    if base <= 0:
        return None
    return closes[-1] / base - 1.0


def realized_sigma(
    closes: list[float], window: int = VOL_WINDOW, shift: int = VOL_SHIFT
) -> float | None:
    """末尾 shift 日を除いた直近 window 日の日次単純リターン標準偏差（標本・ddof=1）。"""
    series = closes[:-shift] if shift else list(closes)
    if len(series) < window + 1:
        return None
    series = series[-(window + 1):]
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


def crash_state(closes: list[float]) -> dict:
    """急落イベント判定。{r5, sigma, event} を返す（HYP-0011 準拠・終値のみ）。"""
    r5 = five_day_return(closes, CRASH_WINDOW)
    sigma = realized_sigma(closes, VOL_WINDOW, VOL_SHIFT)
    if r5 is None:
        return {"r5": None, "sigma": sigma, "event": False}
    event = r5 <= HARD_DROP
    if not event and sigma is not None and sigma > 0:
        # σルールは下限ガード（最低5%下落）も満たす場合のみ。横ばい(σ=0)や微小変動を弾く。
        event = r5 <= -SIGMA_MULT * sigma * math.sqrt(CRASH_WINDOW) and r5 <= MIN_CRASH_DROP
    return {"r5": r5, "sigma": sigma, "event": bool(event)}


def compute_sector_means(
    closes_by_code: dict[str, list[float]], sector_map: dict[str, str]
) -> dict[str, float]:
    """全上場の code4→終値列から、33業種ごとの平均5日下落率を返す（H84 の同業種ユニバース平均）。"""
    buckets: dict[str, list[float]] = {}
    for code4, closes in closes_by_code.items():
        sec = sector_map.get(code4)
        if not sec or sec == EXCLUDE_SECTOR:
            continue
        if not closes or closes[-1] < MIN_SECTOR_PRICE:
            continue
        r5 = five_day_return(closes, CRASH_WINDOW)
        if r5 is None:
            continue
        buckets.setdefault(sec, []).append(r5)
    return {sec: sum(v) / len(v) for sec, v in buckets.items() if v}


def classify_tsureyasu(resid: float, threshold: float = TSUREYASU_RESID_THRESHOLD) -> str:
    """残差 ≤ しきい → 個別急落、それ以外 → 連れ安（2値・TBK-0009）。"""
    return "個別急落" if resid <= threshold else "連れ安"


def build_tsureyasu(
    closes: list[float], sector: str | None, sector_means: dict[str, float]
) -> dict | None:
    """1銘柄の連れ安度を組み立てる（2段・TBK-0012）。

    - confirmed: 急落イベント成立（HYP-0011/H84 の検証ドメイン）→ 連れ安/個別急落の tag を付与。
    - candidate: 急落未満だが r5 ≤ CANDIDATE_DROP → tag は付けず生 resid のみ（較正用の観測層）。
    どちらにも該当しない、または業種平均が得られない場合は None。
    """
    st = crash_state(closes)
    r5 = st["r5"]
    if r5 is None:
        return None
    confirmed = bool(st["event"])
    candidate = (not confirmed) and (r5 <= CANDIDATE_DROP)
    if not (confirmed or candidate):
        return None
    if not sector or sector == EXCLUDE_SECTOR:
        return None
    smean = sector_means.get(sector)
    if smean is None:
        return None
    resid = r5 - smean
    return {
        "tier": "confirmed" if confirmed else "candidate",
        "event": confirmed,  # 後方互換: 既存の読み手は event を見る（candidate は False）
        "self_r5": round(float(r5), 4),
        "sector": str(sector),
        "sector_r5": round(float(smean), 4),
        "resid": round(float(resid), 4),
        "tag": classify_tsureyasu(resid) if confirmed else None,  # candidate は検証主張なし
    }


def _level(level_id: str, label: str, price: float, close: float) -> dict:
    """レベル1本の出力行を作る。dist = (レベル価格 − 現在値) / 現在値（TBK-0006）。"""
    return {
        "id": level_id,
        "label": label,
        "price": round(float(price), 1),
        "dist": round(float(price) / close - 1.0, 4),
        "hit": bool(close <= price),
    }


def compute_board(
    panel, sector_map: dict[str, str] | None = None, sector_means: dict[str, float] | None = None
) -> dict:
    """長形式の株価 DataFrame から buy_levels.json の payload を計算する純粋関数（テスト対象）。

    sector_map / sector_means を渡すと、急落イベント銘柄に連れ安度（tsureyasu・TBK-0009）を付与する。
    省略時（None）は従来どおり連れ安度を出力しない（後方互換）。
    """
    import pandas as pd

    if panel is None or len(panel) == 0:
        return {}

    panel = panel.copy()
    panel["date"] = pd.to_datetime(panel["date"])
    panel["adj_close"] = pd.to_numeric(panel["adj_close"], errors="coerce")
    panel = panel.dropna(subset=["adj_close"])
    panel = panel.sort_values(["code4", "date"]).reset_index(drop=True)

    stocks = []
    updated = ""
    for code4, sub in panel.groupby("code4", sort=True):
        closes = sub["adj_close"].tolist()
        if len(closes) < 2:
            continue  # 陽転判定すらできない（上場直後など）
        close = float(closes[-1])
        if close <= 0:
            continue
        updated = max(updated, sub["date"].iloc[-1].strftime("%Y-%m-%d"))

        levels = []
        if len(closes) >= MA_SHORT:
            ma25 = sum(closes[-MA_SHORT:]) / MA_SHORT
            levels.append(_level("L1", "25日線", ma25, close))
            levels.append(_level("L2", "25日線-5%", ma25 * 0.95, close))
            levels.append(_level("L3", "25日線-8%", ma25 * 0.92, close))
        if len(closes) >= HIGH_WINDOW:
            high20 = max(closes[-HIGH_WINDOW:])
            levels.append(_level("L4", "20日高値-10%", high20 * 0.90, close))
            levels.append(_level("L5", "20日高値-15%", high20 * 0.85, close))
        if len(closes) >= LOW_WINDOW:
            low60 = min(closes[-LOW_WINDOW:])
            levels.append(_level("L6", "60日安値", low60, close))

        stock = {
            "code": str(code4),
            "close": round(close, 1),
            "rebound": bool(close > float(closes[-2])),
            "levels": levels,
        }
        if sector_map is not None and sector_means:
            tsureyasu = build_tsureyasu(closes, sector_map.get(str(code4)), sector_means)
            if tsureyasu is not None:
                stock["tsureyasu"] = tsureyasu
        stocks.append(stock)

    if not stocks:
        return {}
    return {
        "updated": updated,
        "source": "jquants-data prices (調整後終値ベース)",
        "near_threshold": NEAR_THRESHOLD,
        "stocks": stocks,
    }


def main() -> int:
    prices_dir = _find_prices_dir()
    if not prices_dir:
        print(
            "jquants-data の prices/ が見つかりません。環境変数 JQUANTS_PARQUET_REPO で指定してください。",
            file=sys.stderr,
        )
        return 1

    universe = load_universe()
    if not universe:
        print("監視リスト（data/indicators_universe.json の codes）が空です。対象銘柄を追加してください。")
        return 0

    panel = _load_panel(prices_dir, set(universe))

    # 連れ安度（TBK-0009）: 全上場の直近終値から業種平均5日下落率を作る。
    # full/（業種マップ）や全上場パネルが無ければ連れ安度はスキップ（劣化動作）。
    sector_map = load_sector_map(_find_full_dir())
    sector_means: dict[str, float] = {}
    if sector_map:
        full_closes = _load_full_closes(prices_dir, CRASH_WINDOW + 1)
        sector_means = compute_sector_means(full_closes, sector_map)
    else:
        print("  注意: 業種マップが無いため連れ安度を付与しません。", file=sys.stderr)

    payload = compute_board(panel, sector_map=sector_map, sector_means=sector_means)
    if not payload:
        print("計算可能な銘柄がありません（履歴不足の可能性）。", file=sys.stderr)
        return 1

    n_conf = sum(1 for s in payload["stocks"] if s.get("tsureyasu", {}).get("tier") == "confirmed")
    n_cand = sum(1 for s in payload["stocks"] if s.get("tsureyasu", {}).get("tier") == "candidate")
    if sector_means:
        print(f"  連れ安度: confirmed（急落イベント）{n_conf}銘柄 / candidate（観測層）{n_cand}銘柄。")

    missing = [c for c in universe if c not in {s["code"] for s in payload["stocks"]}]
    for c in missing:
        print(f"  - {c}: データなし（jquants-data に履歴が無いか日数不足）", file=sys.stderr)

    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
    OUT_FILE.write_text(text, encoding="utf-8")
    print(f"生成完了: {OUT_FILE}（{len(payload['stocks'])}/{len(universe)}銘柄・基準日 {payload['updated']}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
