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
  GDRIVE_SA_JSON            サービスアカウントのキー JSON（本文そのもの。base64 でも可）。必須。
  TRADEBOOK_DRIVE_FILE_ID   取引マスターのファイルID（任意）。指定があれば優先して使うが、
                            無効・取得失敗の場合はファイル名で自動検索してフォールバックする。
                            未指定でもファイル名検索で取得するため、マスター再作成
                            （split-brain 統合など）でIDが変わっても同期が壊れない。

GDRIVE_SA_JSON が未設定の場合は「スキップ」して終了コード 0 を返す（後方互換: Secret 未設定でも
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

# 取引マスターのファイル名（アプリ側 js/config.js の MASTER_FILENAME と一致させること）。
MASTER_FILENAME = "TradeBook_master.json"

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


def find_master_file_id(creds) -> str | None:
    """SA に共有された取引マスターをファイル名で検索し、最新のファイルIDを返す（無ければ None）。

    同名が複数あってもアプリ側 (drive.js) が次回同期で統合・1本化するため、ここでは最新を採用する。
    """
    from googleapiclient.discovery import build

    service = build("drive", "v3", credentials=creds, cache_discovery=False)
    resp = (
        service.files()
        .list(
            q=f"name='{MASTER_FILENAME}' and trashed=false",
            orderBy="modifiedTime desc",
            fields="files(id,name,modifiedTime)",
            spaces="drive",
            pageSize=10,
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        )
        .execute()
    )
    files = resp.get("files", [])
    if not files:
        return None
    if len(files) > 1:
        print(
            f"::warning::同名の取引マスターが {len(files)} 件見つかりました。最新を使用します。",
            file=sys.stderr,
        )
    return files[0]["id"]


def resolve_master(creds, file_id: str) -> dict:
    """取引マスターを取得する。ファイルIDが有効ならそれを使い、無効・未指定なら
    ファイル名検索で自動回復する（マスター再作成でIDが変わっても同期を継続できる）。"""
    if file_id:
        try:
            return fetch_master(file_id, creds)
        except Exception as e:  # noqa: BLE001 - ID失効時はファイル名検索へフォールバック
            print(
                "::warning::指定の TRADEBOOK_DRIVE_FILE_ID から取得できませんでした。"
                f"ファイル名で再検索します: {e}",
                file=sys.stderr,
            )
    found = find_master_file_id(creds)
    if not found:
        raise RuntimeError(
            f"取引マスター ({MASTER_FILENAME}) が見つかりません。"
            "SA への共有設定（閲覧者）を確認してください。"
        )
    return fetch_master(found, creds)


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


def main() -> int:
    sa_json = os.environ.get("GDRIVE_SA_JSON", "").strip()
    file_id = os.environ.get("TRADEBOOK_DRIVE_FILE_ID", "").strip()
    if not sa_json:
        print(
            "GDRIVE_SA_JSON が未設定のため、監視リストの自動同期をスキップします。"
        )
        return 0

    try:
        creds = _load_sa_credentials(sa_json)
        master = resolve_master(creds, file_id)
    except Exception as e:  # noqa: BLE001 - CIではスキップ扱いにして既存処理を止めない
        print(f"::warning::Drive からの取引マスター取得に失敗しました（同期スキップ）: {e}", file=sys.stderr)
        return 0

    codes = extract_codes(master)
    if not codes:
        print("取引マスターに有効な銘柄コードがありませんでした。監視リストは変更しません。")
        return 0

    existing = json.loads(UNIVERSE_FILE.read_text(encoding="utf-8"))
    updated, added = merge_universe(existing, codes)

    if not added:
        print(f"監視リストは最新です（取引銘柄 {len(codes)} 件はすべて登録済み）。")
        return 0

    UNIVERSE_FILE.write_text(
        json.dumps(updated, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"監視リストに {len(added)} 銘柄を追加しました: {', '.join(added)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
