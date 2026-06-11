# [TBK-0008] 場中価格のデータ契約（intraday_prices.json・表示専用）

## 📜 ステータス

| 項目 | 値 |
|------|---|
| **Status** | `Accepted` |
| **Date** | 2026-06-11 |
| **Supersedes** | — |
| **Superseded by** | — |

## ❓ コンテキスト（背景と課題）

保有銘柄の含み損益と買い時ボードの現在値は J-Quants の日足終値（夜22時確定）のみで、
場中の値動きが見えなかった。無料の場中価格ソースを調査した結果（2026-06-11、詳細は
`docs/plans/2026-06-11-intraday-prices-design.md`）、yfinance は GitHub Actions の共有IPで
不可、stooq は 2026年6月に実質終了しており、現時点で動くのは Yahoo チャートAPI 直叩き
（約20分遅延・非公式）のみだった。**この領域のソースは数ヶ月単位で死ぬ**前提で設計する。

## 💡 決定事項（Decision）

1. **表示専用**: 場中価格は保有銘柄の含み損益と現在値の表示にのみ使う。
   買いレベルの到達判定（TBK-0006 の `hit`）・LINE 通知・ExitLab の検証は
   **終値ベースを堅持**し、場中価格を判定に使わない。
2. **データ契約 `data/intraday_prices.json`**:
   ```json
   {
     "asOf": "2026-06-11T13:30:00+09:00",
     "source": "yahoo_chart",
     "prices": { "5016": 3392.0, "6855": 6950.0 }
   }
   ```
   - `asOf` = 取得完了時刻（JST・ISO 8601）。読み手は鮮度判定にこれだけを使う
   - `source` = 取得ソース識別子（差し替え時に変わる）
   - `prices` = 4桁コード → 最新価格（小数1桁・約20分遅延）。取得失敗銘柄はキーを出さない
3. **置き場所は orphan ブランチ `intraday`**（force-push・履歴は常に1コミット）。
   30分ごとの更新を main にコミットすると履歴が年数千件汚れるため。読み手は
   `https://raw.githubusercontent.com/<owner>/<repo>/intraday/data/intraday_prices.json`
   を fetch する（CORS 可・CDN キャッシュ約5分）。
4. **更新スケジュール**: 平日 9:00〜15:30 JST の30分ごと（`intraday-prices.yml`）。
   対象は監視リスト（`data/indicators_universe.json`）の銘柄のみ。分足等の履歴は蓄積しない。
5. **読み手の劣化動作（必須）**: ファイルが取得できない・`asOf` が古い（90分超）場合は
   従来どおり日足終値の表示へ静かにフォールバックする。エラー表示にしない。
   表示時は必ず時点（例「13:30時点」）を併記する。
6. **ソース抽象化**: 取得スクリプトはソースをクラス単位で差し替え可能にする。
   ソース変更（例: GOOGLEFINANCE 追加）は `source` 値の追加のみで契約は不変。

## 📈 結果・影響（Consequences）

- 場中の含み損益・現在値が約20分遅延・30分間隔で見えるようになる
- Yahoo 側が止まっても表示が終値に戻るだけで、判定・通知・検証には影響しない
- 全銘柄化・履歴蓄積・場中判定をしたくなった場合は本 ADR の改訂（新 ADR）が必要

## 🔧 実行可能チェック（Enforcement）

- 取得・整形の純粋関数は `tools/test_fetch_intraday_prices.py` で検証する
- 鮮度判定・フォールバックは `tests/intraday.test.js` で検証する（`npm test`）
