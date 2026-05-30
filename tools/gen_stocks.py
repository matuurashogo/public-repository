#!/usr/bin/env python3
"""銘柄コード→銘柄名の対応表 (data/stocks.json) を生成する。

現状は JQuantsExtractor/data/subsector_master.jsonl の notes フィールド
（"社名: 説明" 形式）から社名を抽出する。約2294銘柄をカバー。

将来 J-Quants の listed_info（Code / CompanyName）が取得できる場合は、
そちらを正としてこのスクリプトを差し替え・拡張すること。

使い方:
    python TradeBook/tools/gen_stocks.py
"""

from __future__ import annotations

import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SRC = os.path.join(REPO_ROOT, "JQuantsExtractor", "data", "subsector_master.jsonl")
OUT = os.path.join(HERE, "..", "data", "stocks.json")

# 社名と説明の区切り（全角/半角コロン）
_SEP = re.compile(r"[：:]")


def extract_name(notes: str) -> str:
    """notes の先頭（区切り文字より前）を社名として取り出す。"""
    if not notes:
        return ""
    head = _SEP.split(notes, 1)[0].strip()
    # 明らかに社名でない（長すぎる/空）ものは除外
    if not head or len(head) > 24:
        return ""
    return head


def main() -> None:
    if not os.path.exists(SRC):
        raise SystemExit(f"入力が見つかりません: {SRC}")

    mapping: dict[str, str] = {}
    with open(SRC, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            code5 = str(row.get("code", ""))
            code4 = code5[:4]  # J-Quants の5桁ローカルコード → 4桁証券コード
            if not re.fullmatch(r"\d{4}", code4):
                continue
            name = extract_name(row.get("notes", ""))
            if name:
                mapping.setdefault(code4, name)

    ordered = dict(sorted(mapping.items()))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(ordered, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        f.write("\n")

    print(f"生成完了: {OUT}（{len(ordered)}銘柄）")


if __name__ == "__main__":
    main()
