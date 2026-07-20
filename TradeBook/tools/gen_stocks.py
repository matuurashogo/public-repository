#!/usr/bin/env python3
"""銘柄コード→銘柄名の対応表 (data/stocks.json) を生成する。

入力は次の優先順で自動検出する（明示したい場合は第1引数でパス指定可）:
  1. JQuantsExtractor/data/equity_master.jsonl … J-Quants の銘柄マスター
     （全上場銘柄。Code / CompanyName を持つ JSONL）。あれば全銘柄化される。
  2. JQuantsExtractor/data/subsector_master.jsonl … セクター分類済みの一部銘柄
     （notes の "社名: 説明" から社名を抽出）。1 が無いときのフォールバック。

equity_master.jsonl は private リポで次を実行して生成する:
    python JQuantsExtractor/tools/export_equity_master.py

使い方:
    python tools/gen_stocks.py                 # 自動検出
    python tools/gen_stocks.py path/to/in.jsonl  # 入力を明示
"""

from __future__ import annotations

import glob
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC_ROOT = os.path.abspath(os.path.join(HERE, ".."))
PARENT = os.path.dirname(PUBLIC_ROOT)  # 通常 public-repository の親
OUT = os.path.join(PUBLIC_ROOT, "data", "stocks.json")

# JQuantsExtractor/data の場所はリポ構成によって異なるため候補を順に探索する。
# 環境変数 JQUANTS_DATA_DIR で明示指定も可能。
_CANDIDATE_DATA_DIRS = [
    os.environ.get("JQUANTS_DATA_DIR", ""),
    os.path.join(PARENT, "JQuantsExtractor", "data"),  # 兄弟（旧モノレポ）
    os.path.join(PARENT, "private-repository", "JQuantsExtractor", "data"),  # 分割構成
    os.path.join(PUBLIC_ROOT, "..", "private-repository", "JQuantsExtractor", "data"),
]


def _find_in_candidates(filename: str) -> str | None:
    """候補データディレクトリから filename を探し、最初に見つかったパスを返す。"""
    for base in _CANDIDATE_DATA_DIRS:
        if not base:
            continue
        p = os.path.join(base, filename)
        if os.path.exists(p):
            return os.path.abspath(p)
    return None


# jquants-data リポジトリ（J-Quants データの Parquet 蓄積）の場所候補。
# full/sector33_*.parquet の `company` 列に全上場銘柄の社名が入っており、
# 主データ（subsector_master）に無い銘柄名の補完に使う。
# 環境変数 JQUANTS_PARQUET_REPO で明示指定も可能。
_CANDIDATE_JQUANTS_REPOS = [
    os.environ.get("JQUANTS_PARQUET_REPO", ""),
    os.path.join(PARENT, "jquants-data"),  # 兄弟ディレクトリ
    os.path.join(PUBLIC_ROOT, "..", "jquants-data"),
]


def _find_jquants_full_dir() -> str | None:
    """jquants-data の full/ ディレクトリ（sector33_*.parquet 群）を探して返す。"""
    for base in _CANDIDATE_JQUANTS_REPOS:
        if not base:
            continue
        p = os.path.join(base, "full")
        if os.path.isdir(p) and glob.glob(os.path.join(p, "sector33_*.parquet")):
            return os.path.abspath(p)
    return None

# 社名と説明の区切り（全角/半角コロン）
_SEP = re.compile(r"[：:]")


def to_code4(code: str) -> str:
    """J-Quants の5桁ローカルコード（例 "72030"）→ 4桁証券コード（"7203"）。"""
    return str(code)[:4]


def extract_name(notes: str) -> str:
    """subsector_master の notes 先頭（区切り文字より前）を社名として取り出す。"""
    if not notes:
        return ""
    head = _SEP.split(notes, 1)[0].strip()
    if not head or len(head) > 24:  # 明らかに社名でないものは除外
        return ""
    return head


def from_equity_master(path: str) -> dict[str, str]:
    """銘柄マスター（Code / CompanyName）から全銘柄の対応表を作る。"""
    mapping: dict[str, str] = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            code4 = to_code4(row.get("Code") or row.get("code") or "")
            # 4桁の証券コード（数字のみ、または新形式の英数字 例 130A）を許可
            if not re.fullmatch(r"[0-9][0-9A-Z]{3}", code4):
                continue
            name = (row.get("CompanyName") or row.get("company_name") or "").strip()
            if name:
                mapping.setdefault(code4, name)
    return mapping


def from_subsector_master(path: str) -> dict[str, str]:
    """セクター分類済みデータ（notes の "社名: 説明"）から対応表を作る。"""
    mapping: dict[str, str] = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            code4 = to_code4(row.get("code", ""))
            # 4桁の証券コード（数字のみ、または新形式の英数字 例 130A）を許可
            if not re.fullmatch(r"[0-9][0-9A-Z]{3}", code4):
                continue
            name = extract_name(row.get("notes", ""))
            if name:
                mapping.setdefault(code4, name)
    return mapping


def from_full_financials(full_dir: str) -> dict[str, str]:
    """jquants-data の full/sector33_*.parquet（財務データ）から code→社名 を作る。

    各ファイルの `code`（J-Quants 5桁ローカルコード）と `company`（社名）列を読む。
    全上場銘柄を概ね網羅するため、主データに無い銘柄名の補完に使える。
    pyarrow が無い場合は空 dict を返す（任意依存）。
    """
    try:
        import pyarrow.parquet as pq  # type: ignore
    except ImportError:
        print(
            "  注意: pyarrow が無いため jquants-data からの補完をスキップします"
            "（pip install pyarrow で有効化）。",
            file=sys.stderr,
        )
        return {}

    mapping: dict[str, str] = {}
    for path in sorted(glob.glob(os.path.join(full_dir, "sector33_*.parquet"))):
        table = pq.read_table(path, columns=["code", "company"])
        codes = table.column("code").to_pylist()
        names = table.column("company").to_pylist()
        for code, name in zip(codes, names):
            if code is None or not name:
                continue
            code4 = to_code4(str(code))
            # 4桁の証券コード（数字のみ、または新形式の英数字 例 130A）を許可
            if not re.fullmatch(r"[0-9][0-9A-Z]{3}", code4):
                continue
            name = str(name).strip()
            if name:
                mapping.setdefault(code4, name)
    return mapping


def supplement_with_jquants(mapping: dict[str, str]) -> int:
    """jquants-data の財務データから、未収録コードの社名のみを補完する。

    既存（主データ由来）の名前は上書きしない（追加のみ）。追加件数を返す。
    """
    full_dir = _find_jquants_full_dir()
    if not full_dir:
        return 0
    added = 0
    for code4, name in from_full_financials(full_dir).items():
        if code4 not in mapping:
            mapping[code4] = name
            added += 1
    if added:
        print(f"  jquants-data から {added} 銘柄の名前を補完しました（{full_dir}）。")
    return added


def resolve_source(arg: str | None) -> tuple[str, str]:
    """入力ファイルと種別を解決する。戻り値: (path, kind)。kind は "equity" | "subsector"。"""
    if arg:
        kind = "equity" if "equity" in os.path.basename(arg) else "subsector"
        return arg, kind
    equity = _find_in_candidates("equity_master.jsonl")
    if equity:
        return equity, "equity"
    subsector = _find_in_candidates("subsector_master.jsonl")
    if subsector:
        return subsector, "subsector"
    raise SystemExit(
        "入力が見つかりません。JQuantsExtractor/data に次のいずれかを用意してください:\n"
        "  - equity_master.jsonl（全銘柄。export_equity_master.py で生成）\n"
        "  - subsector_master.jsonl（一部銘柄）\n"
        "  ※場所が異なる場合は環境変数 JQUANTS_DATA_DIR で指定するか、第1引数でパスを渡してください。"
    )


def supplement_with_r2(mapping: dict[str, str]) -> int:
    """QDP R2 の dim_listed（company_name）から未収録コードの社名のみを補完する（TBK-0013）。

    既存の名前は上書きしない（追加のみ）。追加件数を返す。
    """
    import datasource

    added = 0
    for code4, name in datasource.load_company_names().items():
        if code4 not in mapping:
            mapping[code4] = name
            added += 1
    if added:
        print(f"  qdp-r2 dim_listed から {added} 銘柄の名前を補完しました。")
    return added


def main() -> None:
    import datasource

    arg = sys.argv[1] if len(sys.argv) > 1 else None
    src = None
    kind = ""
    try:
        src, kind = resolve_source(arg)
    except SystemExit:
        # R2（TRADEBOOK_DATA_SOURCE=r2）なら私有マスター無しでも dim_listed 単独で生成できる
        if not datasource.use_r2():
            raise

    mapping: dict[str, str] = {}
    if src:
        if not os.path.exists(src):
            raise SystemExit(f"入力が見つかりません: {src}")
        mapping = from_equity_master(src) if kind == "equity" else from_subsector_master(src)
        # jquants-data の財務データ（full/）で未収録銘柄の名前を補完（任意・あれば実施）
        supplement_with_jquants(mapping)

    # QDP R2 の dim_listed で補完（r2 選択時のみ。私有マスター無しなら単独ソースになる）
    if datasource.use_r2():
        supplement_with_r2(mapping)
    if not mapping:
        raise SystemExit("銘柄名を1件も取得できませんでした（入力とデータソース設定を確認してください）。")

    ordered = dict(sorted(mapping.items()))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(ordered, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        f.write("\n")

    if src:
        label = "全銘柄マスター" if kind == "equity" else "セクター分類データ（一部銘柄）"
        print(f"生成完了: {OUT}（{len(ordered)}銘柄）／ 入力: {os.path.basename(src)} = {label}")
    else:
        print(f"生成完了: {OUT}（{len(ordered)}銘柄）／ 入力: qdp-r2 dim_listed")


if __name__ == "__main__":
    main()
