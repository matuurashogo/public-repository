#!/usr/bin/env python3
"""Google Drive の取引マスターを読み、監視リスト (data/indicators_universe.json) を自動更新する。

TradeBook アプリは取引を Google Drive 上の単一マスター (TradeBook_master.json) に保存する。
本スクリプトは、そのマスターで実際に売買している銘柄コードを抽出し、エントリー・スナップショット用の
監視リストへ「追記マージ」する。これを毎日のワークフローで gen_indicators.py の前に実行することで、
「銘柄を買う → 翌営業日には客観スナップショットが自動で出る」までを全自動化する。

認証はサービスアカウント (SA) を使う。Drive の取引ファイルはアプリ専用スコープ (drive.file) で
作られているため CI から直接は読めないが、ユーザーがそのファイルを SA のメールアドレスに共有すれば
SA の drive.readonly で読める（ファイル自体はユーザー所有の通常の Drive ファイルのため）。

環境変数:
  GDRIVE_SA_JSON            サービスアカウントのキー JSON（本文そのもの。base64 でも可）
  TRADEBOOK_DRIVE_FILE_ID   取引マスター TradeBook_master.json のファイルID

いずれかが未設定の場合は「スキップ」して終了コード 0 を返す（後方互換: Secret 未設定でも
ワークフロー全体は従来どおり動く）。

使い方:
    GDRIVE_SA_JSON="$(cat sa.json)" TRADEBOOK_DRIVE_FILE_ID=16KHsf... \
        python tools/sync_universe_from_drive.py
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PUBLIC_ROOT = HERE.parent
UNIVERSE_FILE = PUBLIC_ROOT / "data" / "indicators_universe.json"

# 4桁証券コード（先頭は数字、残り3桁は数字または英大文字）。gen_indicators.load_universe と同一定義。
_CODE_RE = re.compile(r"[0-9][0-9A-Z]{3}")


def _load_sa_credentials(raw: str):
    """SA キー JSON 文字列（生 or base64）から Drive readonly の Credentials を作る。"""
    from google.oauth2 import service_account

    text = raw.strip()
    try:
        info = json.loads(text)
    except json.JSONDecodeError:
        # base64 で渡された場合のフォールバック
        info = json.loads(base64.b64decode(text).decode("utf-8"))
    return service_account.Credentials.from_service_account_info(
        info, scopes=["https://www.googleapis.com/auth/drive.readonly"]
    )


def fetch_master(file_id: str, creds) -> dict:
    """Drive から取引マスター JSON をダウンロードして dict で返す。"""
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaIoBaseDownload

    service = build("drive", "v3", credentials=creds, cache_discovery=False)
    request = service.files().get_media(fileId=file_id)
    buf = io.BytesIO()
    downloader = MediaIoBaseDownload(buf, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    return json.loads(buf.getvalue().decode("utf-8"))


def extract_codes(master: dict) -> list[str]:
    """取引マスターの trades[].code から、有効な4桁コードを重複なく昇順で返す。"""
    trades = master.get("trades", []) if isinstance(master, dict) else []
    seen: set[str] = set()
    for t in trades:
        if not isinstance(t, dict):
            continue
        c4 = str(t.get("code", ""))[:4]
        if _CODE_RE.fullmatch(c4):
            seen.add(c4)
    return sorted(seen)


def extract_watchlist(master: dict) -> list[str]:
    """マスターの watchlist（アプリ内編集の監視銘柄・TBK-0007）を順序保持で返す。"""
    raw = master.get("watchlist", []) if isinstance(master, dict) else []
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for c in raw:
        c4 = str(c)[:4]
        if _CODE_RE.fullmatch(c4) and c4 not in seen:
            seen.add(c4)
            out.append(c4)
    return out


def merge_universe(existing: dict, new_codes: list[str]) -> tuple[dict, list[str]]:
    """既存の universe dict に new_codes を追記マージする（既存順を保持し、新規を末尾に追加）。

    戻り値: (更新後 dict, 実際に追加されたコード一覧)。_comment 等の他キーは保持する。
    """
    out = dict(existing) if isinstance(existing, dict) else {}
    current = [str(c)[:4] for c in out.get("codes", []) if _CODE_RE.fullmatch(str(c)[:4])]
    have = set(current)
    added = [c for c in new_codes if c not in have]
    out["codes"] = current + added
    return out, added


def replace_universe(
    existing: dict, watchlist: list[str], traded: list[str]
) -> tuple[dict, list[str], list[str]]:
    """universe の codes を「watchlist ∪ 売買銘柄」へ置き換える（TBK-0007 決定4）。

    watchlist の順序を優先し、watchlist に無い売買銘柄を末尾に追加する。
    アプリで監視リスト管理を始めたユーザーの「削除」を反映するための置き換え動作。
    売買銘柄は entrySnap 生成（TBK-0003）に必要なため除外しない。
    戻り値: (更新後 dict, 追加されたコード, 削除されたコード)。
    """
    out = dict(existing) if isinstance(existing, dict) else {}
    current = [str(c)[:4] for c in out.get("codes", []) if _CODE_RE.fullmatch(str(c)[:4])]
    target = list(watchlist) + [c for c in traded if c not in set(watchlist)]
    added = [c for c in target if c not in set(current)]
    removed = [c for c in current if c not in set(target)]
    out["codes"] = target
    return out, added, removed


def main() -> int:
    sa_json = os.environ.get("GDRIVE_SA_JSON", "").strip()
    file_id = os.environ.get("TRADEBOOK_DRIVE_FILE_ID", "").strip()
    if not sa_json or not file_id:
        print(
            "GDRIVE_SA_JSON / TRADEBOOK_DRIVE_FILE_ID が未設定のため、監視リストの自動同期をスキップします。"
        )
        return 0

    try:
        creds = _load_sa_credentials(sa_json)
        master = fetch_master(file_id, creds)
    except Exception as e:  # noqa: BLE001 - CIではスキップ扱いにして既存処理を止めない
        print(f"::warning::Drive からの取引マスター取得に失敗しました（同期スキップ）: {e}", file=sys.stderr)
        return 0

    traded = extract_codes(master)
    watchlist = extract_watchlist(master)
    existing = json.loads(UNIVERSE_FILE.read_text(encoding="utf-8"))

    if watchlist:
        # アプリ内編集の監視リストがある場合は置き換え（削除も反映。TBK-0007）
        updated, added, removed = replace_universe(existing, watchlist, traded)
        if not added and not removed:
            print(f"監視リストは最新です（watchlist {len(watchlist)} 件・取引銘柄 {len(traded)} 件）。")
            return 0
        UNIVERSE_FILE.write_text(
            json.dumps(updated, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        parts = []
        if added:
            parts.append(f"追加 {len(added)} 件: {', '.join(added)}")
        if removed:
            parts.append(f"削除 {len(removed)} 件: {', '.join(removed)}")
        print(f"監視リストを watchlist 基準で更新しました（{' / '.join(parts)}）。")
        return 0

    # watchlist 未使用（空/欠損）の場合は従来どおり売買銘柄の追記のみ（後方互換）
    if not traded:
        print("取引マスターに有効な銘柄コードがありませんでした。監視リストは変更しません。")
        return 0

    updated, added = merge_universe(existing, traded)
    if not added:
        print(f"監視リストは最新です（取引銘柄 {len(traded)} 件はすべて登録済み）。")
        return 0

    UNIVERSE_FILE.write_text(
        json.dumps(updated, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"監視リストに {len(added)} 銘柄を追加しました: {', '.join(added)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
