# [TBK-0007] 監視リストのアプリ内編集（master への watchlist 追加と同期契約）

## 📜 ステータス

| 項目 | 値 |
|------|---|
| **Status** | `Accepted` |
| **Date** | 2026-06-10 |
| **Supersedes** | — |
| **Superseded by** | — |

## ❓ コンテキスト（背景と課題）

買い時ボード（TBK-0006）の対象銘柄は `data/indicators_universe.json`（git 管理の静的ファイル）で
定義されるが、TradeBook は静的 PWA のためリポジトリのファイルを直接編集できず、
銘柄の追加・削除のたびに手動コミットが必要だった。

一方、Drive→GitHub の自動同期（`tools/sync_universe_from_drive.py`・PR #17）は実装済みで、
取引マスター（`TradeBook_master.json`）から売買銘柄を監視リストへ追記する経路が存在する。
この経路に「ユーザーが明示的に編集する監視リスト」を乗せれば、アプリ内編集が実現できる。

## 💡 決定事項（Decision）

1. **マスターにオプショナルな2フィールドを追加する**（スキーマ version は 3 のまま）:
   ```json
   {
     "watchlist": ["7203", "6758"],
     "watchlistUpdatedAt": 1781100000000
   }
   ```
   - `watchlist` = 監視銘柄の4桁コード配列（順序保持・重複なし。`[0-9][0-9A-Z]{3}` のみ有効）
   - `watchlistUpdatedAt` = 配列全体の最終編集時刻（epoch ms）。欠損は 0 扱い
2. **マージは配列全体の last-write-wins**（`mergeMasters`）:
   - `watchlistUpdatedAt` が新しい側の配列を丸ごと採用する（**削除を正しく伝播させるため**。
     タグの和集合方式では削除した銘柄が他端末から復活してしまう）
   - 同時刻（両方 0 を含む）の場合のみ和集合（旧データ同士の救済）
3. **初期シード**: アプリの監視リスト編集 UI を初めて開いたとき `watchlist` が空なら、
   現在の買い時ボード（buy_levels.json）の銘柄コードをシードする（既存の監視銘柄を失わない）
4. **同期スクリプトの意味論**（`sync_universe_from_drive.py`）:
   - `watchlist` が**非空**: `indicators_universe.json` の codes を
     「watchlist ∪ 売買銘柄」へ**置き換える**（watchlist の順序を優先、売買銘柄の不足分を末尾に追加。
     **削除が反映される**。売買銘柄は entrySnap 生成に必要なため除外しない）
   - `watchlist` が**空/欠損**: 従来どおり売買銘柄の追記のみ（後方互換）
5. **読み手の劣化動作**: 同期（GCP Secret）が未設定の間は、アプリ編集は Drive に保存されるだけで
   ボードへは反映されない。UI にその旨を明記する

## 📈 結果・影響（Consequences）

- 銘柄の追加・削除がアプリ内で完結し、夜間同期（22:00 / 07:30 JST）でボードと LINE 通知に反映される
- **旧バージョンのアプリ（watchlist を知らないクライアント）が master を保存すると watchlist が
  消失しうる**。単一ユーザー・PWA 自動更新前提で許容する（消失時はシード（決定3）で復元可能）
- 同期の有効化には GCP 設定（`docs/tradebook-drive-sync-setup-todo.md` の残タスク）が必要

## 🔧 実行可能チェック（Enforcement）

- 正規化・マージ（LWW・同時刻和集合）は `tests/store.test.js` で検証する（`npm test`）
- 同期の置き換え/追記の分岐は `tools/test_sync_universe_from_drive.py` で検証する
