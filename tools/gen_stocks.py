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
            if not re.fullmatch(r"\d{4}", code4):
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
            if not re.fullmatch(r"\d{4}", code4):
                continue
            name = extract_name(row.get("notes", ""))
            if name:
                mapping.setdefault(code4, name)
    return mapping


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


def main() -> None:
    arg = sys.argv[1] if len(sys.argv) > 1 else None
    src, kind = resolve_source(arg)
    if not os.path.exists(src):
        raise SystemExit(f"入力が見つかりません: {src}")

    mapping = from_equity_master(src) if kind == "equity" else from_subsector_master(src)

    ordered = dict(sorted(mapping.items()))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(ordered, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        f.write("\n")

    label = "全銘柄マスター" if kind == "equity" else "セクター分類データ（一部銘柄）"
    print(f"生成完了: {OUT}（{len(ordered)}銘柄）／ 入力: {os.path.basename(src)} = {label}")


if __name__ == "__main__":
    main()
