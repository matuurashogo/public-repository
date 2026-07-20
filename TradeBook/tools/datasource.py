#!/usr/bin/env python3
"""TradeBook データ生成ツール共通のデータソース層（TBK-0013）。

gen_*.py の入力データを二系統から読めるようにする:

  - local: 兄弟リポジトリ jquants-data の Parquet（従来・既定）
      prices/prices_YYYYMMDD.parquet ・ full/sector33_*_full.parquet
  - r2   : quant-data-platform が R2 に publish した silver 表を DuckDB httpfs で直読み
      r2://<R2_BUCKET>/qdp/silver/fact_prices_daily.parquet
      r2://<R2_BUCKET>/qdp/silver/dim_listed.parquet

切替は環境変数 TRADEBOOK_DATA_SOURCE（"local"（既定）| "r2"）。
どちらのバックエンドでも**戻り値の列名は従来の jquants-data 列名**
（code / date / adj_close / trading_value / close / ...）に正規化する。
下流の gen_*.py は入力源を意識しない（データ契約は TBK-0013 を参照）。

r2 バックエンドに必要な環境変数（quant-data-platform の publish と同じ命名）:
  - R2_BUCKET / R2_ACCOUNT_ID
  - R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY（無ければ読み取り専用の
    R2_RO_ACCESS_KEY_ID + R2_RO_SECRET_ACCESS_KEY へフォールバック）
  - 依存: duckdb（r2 選択時のみ import。local では不要）

テスト/デバッグ用フック:
  - TRADEBOOK_R2_URL_BASE: テーブル URL の基底を差し替える（例: ローカルにミラーした
    silver ディレクトリ）。r2:// 以外の基底では資格情報を要求しない。

⚠️ セキュリティ: R2 の CREATE SECRET SQL を例外・ログに絶対に出さない
（quant-data-platform r2_reader と同じ方針。失敗時は原文を握り潰して汎用メッセージのみ）。
"""

from __future__ import annotations

import glob as _glob
import os
import re
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PUBLIC_ROOT = _HERE.parent
_PARENT = _PUBLIC_ROOT.parent

_CODE4_RE = re.compile(r"[0-9][0-9A-Z]{3}")

# R2 上の silver 表キー（quant-data-platform publish の dest_key と一致させる）
_R2_SILVER_PREFIX = "qdp/silver"
_TABLE_PRICES = "fact_prices_daily"
_TABLE_LISTED = "dim_listed"

# fact_prices_daily → 従来列名（jquants-data prices）の対応。
# ここに無い列は同名（adj_close / close / adj_volume / adj_factor / is_limit /
# adj_open / adj_high / adj_low）。
_R2_COLMAP = {"trading_value": "turnover_value"}

# local（jquants-data prices parquet）で提供できる列。
# adj_open/adj_high/adj_low は R2（QDP-0040 権威導出）にしか無い。
_LOCAL_PRICE_COLUMNS = {
    "close",
    "adj_close",
    "adj_volume",
    "trading_value",
    "is_limit",
    "adj_factor",
}


# ─────────────────────────── バックエンド判定 ───────────────────────────
def use_r2() -> bool:
    """TRADEBOOK_DATA_SOURCE=r2 のとき True（既定は local＝従来動作）。"""
    v = os.environ.get("TRADEBOOK_DATA_SOURCE", "local").strip().lower()
    if v in ("", "local", "jquants-data"):
        return False
    if v == "r2":
        return True
    raise ValueError(f"未知の TRADEBOOK_DATA_SOURCE: {v!r}（local | r2）")


def source_label() -> str:
    """出力 JSON の source フィールド用のラベル。"""
    return "qdp-r2 fact_prices_daily" if use_r2() else "jquants-data prices"


# ─────────────────────────── local バックエンド ───────────────────────────
def _candidate_jquants_repos() -> list[str]:
    return [
        os.environ.get("JQUANTS_PARQUET_REPO", ""),
        str(_PARENT / "jquants-data"),
    ]


def find_prices_dir() -> str | None:
    """jquants-data の prices/ を探す（従来 gen_*.py の探索順と同一）。"""
    for base in _candidate_jquants_repos():
        if not base:
            continue
        p = Path(base) / "prices"
        if p.is_dir():
            return str(p.resolve())
    return None


def find_full_dir() -> str | None:
    """jquants-data の full/（sector33_*.parquet 群）を探す。"""
    for base in _candidate_jquants_repos():
        if not base:
            continue
        p = Path(base) / "full"
        if p.is_dir() and any(p.glob("sector33_*.parquet")):
            return str(p.resolve())
    return None


def _daily_price_files(prices_dir: str, last_n: int) -> list[str]:
    """prices_YYYYMMDD.parquet を日付順で直近 last_n 件返す（latest/stats/split は除外）。"""
    files = []
    for path in _glob.glob(os.path.join(prices_dir, "prices_*.parquet")):
        digits = os.path.basename(path).replace("prices_", "").replace(".parquet", "")
        if digits.isdigit():
            files.append(path)
    files.sort()
    return files[-last_n:] if last_n else files


def _load_panel_local(last_n: int, columns: list[str], codes4: set[str] | None):
    import pandas as pd

    unavailable = [c for c in columns if c not in _LOCAL_PRICE_COLUMNS]
    if unavailable:
        raise ValueError(
            f"local バックエンドでは列 {unavailable} を提供できません"
            "（adj_open/adj_high/adj_low 等は TRADEBOOK_DATA_SOURCE=r2 が必要。TBK-0013）。"
        )
    prices_dir = find_prices_dir()
    if not prices_dir:
        raise FileNotFoundError(
            "jquants-data の prices/ が見つかりません。環境変数 JQUANTS_PARQUET_REPO で指定してください。"
        )
    files = _daily_price_files(prices_dir, last_n)
    if not files:
        raise FileNotFoundError(f"price parquet が見つかりません: {prices_dir}")

    frames = []
    for path in files:
        df = pd.read_parquet(path, columns=["code", "date", *columns])
        if codes4 is not None:
            df = df[df["code"].astype(str).str[:4].isin(codes4)]
        if not df.empty:
            frames.append(df)
    if not frames:
        return pd.DataFrame(columns=["code", "date", *columns])
    return pd.concat(frames, ignore_index=True)


def _load_latest_local():
    import pandas as pd

    prices_dir = find_prices_dir()
    if not prices_dir:
        raise FileNotFoundError(
            "jquants-data の prices/ が見つかりません。環境変数 JQUANTS_PARQUET_REPO で指定してください。"
        )
    p = Path(prices_dir) / "prices_latest.parquet"
    if not p.exists():
        raise FileNotFoundError(f"入力が見つかりません: {p}")
    return pd.read_parquet(p, columns=["code", "date", "adj_close", "close"])


def _load_sector_map_local() -> dict[str, str]:
    """code4 → 33業種コード(S33)。full/sector33_<S33>_full.parquet のファイル名と code 列から作る。"""
    full_dir = find_full_dir()
    if not full_dir:
        return {}
    try:
        import pyarrow.parquet as pq  # type: ignore
    except ImportError:
        print("  注意: pyarrow が無いため業種マップをスキップします。", file=sys.stderr)
        return {}

    mapping: dict[str, str] = {}
    pat = re.compile(r"sector33_([0-9A-Za-z]+)_full\.parquet$")
    for path in sorted(_glob.glob(os.path.join(full_dir, "sector33_*.parquet"))):
        m = pat.search(os.path.basename(path))
        if not m:
            continue
        s33 = m.group(1)
        codes = pq.read_table(path, columns=["code"]).column("code").to_pylist()
        for code in codes:
            if code is None:
                continue
            c4 = str(code)[:4]
            if _CODE4_RE.fullmatch(c4):
                mapping.setdefault(c4, s33)
    return mapping


# ─────────────────────────── r2 バックエンド ───────────────────────────
def _table_url(table: str) -> str:
    """テーブルの読み先 URL。TRADEBOOK_R2_URL_BASE があればそれを基底にする（テスト/ミラー用）。

    ⚠️ URL は str 直組み（Path で包むと r2:// が r2:/ に潰れる）。
    """
    base = os.environ.get("TRADEBOOK_R2_URL_BASE", "").strip()
    if base:
        return f"{base.rstrip('/')}/{table}.parquet"
    bucket = os.environ.get("R2_BUCKET", "").strip()
    if not bucket:
        raise RuntimeError(
            "R2_BUCKET が未設定です（TRADEBOOK_DATA_SOURCE=r2 には R2_* 環境変数が必要。TBK-0013）。"
        )
    return f"r2://{bucket}/{_R2_SILVER_PREFIX}/{table}.parquet"


def _q(v: str) -> str:
    """SQL 文字列リテラルのシングルクォートを '' でエスケープする（補間前に必ず適用）。"""
    return v.replace("'", "''")


def _r2_connection():
    """DuckDB 接続を作り、必要なら R2 の temporary secret を付与して返す。

    ⚠️ CREATE SECRET の SQL を例外・ログに絶対に出さない（失敗時は from None で握り潰す）。
    """
    try:
        import duckdb  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "TRADEBOOK_DATA_SOURCE=r2 には duckdb が必要です（pip install duckdb）。"
        ) from e

    con = duckdb.connect()
    # r2:// を実際に読むときだけ資格情報を要求する（ローカルミラー基底では不要）
    if not _table_url(_TABLE_PRICES).startswith("r2://"):
        return con

    access_key = os.environ.get("R2_ACCESS_KEY_ID") or os.environ.get("R2_RO_ACCESS_KEY_ID")
    secret = os.environ.get("R2_SECRET_ACCESS_KEY") or os.environ.get("R2_RO_SECRET_ACCESS_KEY")
    account_id = os.environ.get("R2_ACCOUNT_ID")
    if not (access_key and secret and account_id):
        raise RuntimeError(
            "R2 資格情報が不足しています（R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY（または R2_RO_*）と "
            "R2_ACCOUNT_ID を設定してください）。"
        )
    secret_sql = (
        "CREATE OR REPLACE TEMPORARY SECRET tradebook_r2_ro "
        f"(TYPE r2, KEY_ID '{_q(access_key)}', SECRET '{_q(secret)}', "
        f"ACCOUNT_ID '{_q(account_id)}')"
    )
    try:
        con.execute("INSTALL httpfs")
        con.execute("LOAD httpfs")
        for stmt in ("SET http_timeout=600000", "SET http_retries=3", "SET http_keep_alive=true"):
            try:
                con.execute(stmt)
            except Exception:
                pass
        con.execute(secret_sql)
    except Exception:
        # ⚠️ secret_sql（鍵を含む）を例外に載せない。
        raise RuntimeError("R2 secret の作成に失敗しました（資格情報/ネットワークを確認）") from None
    return con


def _r2_select_columns(columns: list[str]) -> str:
    parts = []
    for c in columns:
        src = _R2_COLMAP.get(c, c)
        parts.append(f"{src} AS {c}" if src != c else c)
    return ", ".join(parts)


def _codes4_predicate(codes4: set[str] | None) -> str:
    """code4 絞り込みの WHERE 句を返す（無ければ空文字）。

    コードは正規表現で検証してから補間する（4桁英数のみ＝インジェクション不能）。
    """
    if not codes4:
        return ""
    valid = sorted(c for c in codes4 if _CODE4_RE.fullmatch(str(c)))
    if not valid:
        return ""
    quoted = ", ".join(f"'{c}'" for c in valid)
    return f" AND substr(code5, 1, 4) IN ({quoted})"


def _load_panel_r2(last_n: int, columns: list[str], codes4: set[str] | None):
    con = _r2_connection()
    url = _q(_table_url(_TABLE_PRICES))
    sel = _r2_select_columns(columns)
    sql = (
        f"SELECT code5 AS code, date, {sel} "
        f"FROM read_parquet('{url}') "
        f"WHERE date IN (SELECT DISTINCT date FROM read_parquet('{url}') "
        f"ORDER BY date DESC LIMIT {int(last_n)})"
        f"{_codes4_predicate(codes4)} "
        f"ORDER BY date, code5"
    )
    df = con.execute(sql).fetchdf()
    df["code"] = df["code"].astype(str)
    return df


def _load_latest_r2():
    con = _r2_connection()
    url = _q(_table_url(_TABLE_PRICES))
    sql = (
        f"SELECT code5 AS code, date, adj_close, close "
        f"FROM read_parquet('{url}') "
        f"WHERE date = (SELECT max(date) FROM read_parquet('{url}'))"
    )
    df = con.execute(sql).fetchdf()
    df["code"] = df["code"].astype(str)
    return df


def _load_sector_map_r2() -> dict[str, str]:
    con = _r2_connection()
    url = _q(_table_url(_TABLE_LISTED))
    sql = (
        f"SELECT code5, sector33 FROM read_parquet('{url}') "
        f"WHERE sector33 IS NOT NULL ORDER BY code5"
    )
    mapping: dict[str, str] = {}
    for code5, s33 in con.execute(sql).fetchall():
        c4 = str(code5)[:4]
        if _CODE4_RE.fullmatch(c4) and s33:
            mapping.setdefault(c4, str(s33))
    return mapping


def load_company_names() -> dict[str, str]:
    """code4 → 社名（r2 専用: dim_listed.company_name）。gen_stocks.py の補完用。"""
    if not use_r2():
        raise RuntimeError(
            "load_company_names() は r2 バックエンド専用です（local は gen_stocks.py 従来経路を使用）。"
        )
    con = _r2_connection()
    url = _q(_table_url(_TABLE_LISTED))
    sql = (
        f"SELECT code5, company_name FROM read_parquet('{url}') "
        f"WHERE company_name IS NOT NULL ORDER BY code5"
    )
    mapping: dict[str, str] = {}
    for code5, name in con.execute(sql).fetchall():
        c4 = str(code5)[:4]
        name = str(name).strip()
        if _CODE4_RE.fullmatch(c4) and name:
            mapping.setdefault(c4, name)
    return mapping


# ─────────────────────────── 公開 API（両バックエンド共通） ───────────────────────────
def load_price_panel(last_n: int, columns: list[str], codes4: set[str] | None = None):
    """直近 last_n 営業日の日次株価を長形式で返す。

    戻り値の列: code（5桁 str）, date, *columns（従来の jquants-data 列名）。
    local: prices_YYYYMMDD.parquet 直近 last_n 件を結合（従来 gen_*.py と同一挙動）。
    r2   : fact_prices_daily から直近 last_n 営業日を抽出（列名は正規化済み）。
    """
    if use_r2():
        return _load_panel_r2(last_n, columns, codes4)
    return _load_panel_local(last_n, columns, codes4)


def load_latest_prices():
    """最新営業日の全銘柄終値を返す（code, date, adj_close, close）。"""
    if use_r2():
        return _load_latest_r2()
    return _load_latest_local()


def load_sector33_map() -> dict[str, str]:
    """code4 → 33業種コード。連れ安度（TBK-0009）の業種グルーピング用。

    local: full/sector33_<S33>_full.parquet のファイル名から。
    r2   : dim_listed.sector33 から。どちらも「同一業種の銘柄が同じキーに集まる」ことが契約
    （キーの表記そのものは一致しなくてよい。TBK-0013）。
    """
    if use_r2():
        return _load_sector_map_r2()
    return _load_sector_map_local()
