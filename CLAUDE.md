# CLAUDE.md

> [!IMPORTANT]
> このファイルはセッション開始時に自動で読み込まれる最上位コンテキストです。
> 追加ルールは `.claude/rules/` 配下に分割して管理しています。

## このリポジトリについて

`public-repository` は、松井証券向け損益計算PWA **TradeBook** の公開デプロイ用ワークスペースです。
アプリ実体は `TradeBook/` サブフォルダに置き、リポジトリ直下はワークスペース全体の方針・ルール・
共有ドキュメントを管理します（非公開の `private-repository` の構成を踏襲）。

| 配置 | 役割 |
|---|---|
| リポジトリ直下（`CLAUDE.md` / `.claude/` / `docs/`） | ワークスペース全体の方針・ルール・ADRテンプレ |
| `TradeBook/` | アプリ実体（PWA）。各プロジェクトの文脈は `TradeBook/AGENTS.md` |
| `.github/workflows/` | 価格データの自動生成・Pages配信（**GitHubの仕様上ルート固定**） |

## 基本方針

- **全出力を日本語で行う**: 会話・コメント・ドキュメント・成果物はすべて日本語。コードの変数名・関数名のみ英語。
- **破壊的操作の禁止**: `rm`、ファイルの上書き・削除の実行前に、影響範囲をユーザーへ明示し承認を得ること。
- **ユーザーの意図を優先**: 指示を勝手に改変・最適化しない。改善案は実装後に別途提案すること。
- **計画と実行の分離**: `Implementation Plan` を提示した際は、ユーザーのGoサインが出るまで実装に着手しない。

## MCPサーバー

`.mcp.json` に以下のMCPサーバーが登録されています。

| サーバー | 用途 | 優先度 |
|---|---|---|
| `context7-mcp` | ライブラリ・フレームワークの最新ドキュメント検索 | **技術調査では最優先** |

> **ルール**: ライブラリのAPI仕様・バージョン差分・設定方法を調べる場合は、必ず `context7-mcp` を最初に使用すること。

## Harness Engineering（自動テスト）

コードを変更した場合は、Hooks（PostToolUse）が自動でテストを実行します。
TradeBook はテストが JavaScript（`node --test`）主体で、補助ツールが Python です。
手動で実行する場合は以下を参照してください（詳細は `.claude/rules/harness.md`）。

```bash
# 損益計算ロジック等の単体テスト（JS）
cd TradeBook && node --test tests/*.test.js

# データ生成ツールの単体テスト（Python・pandas等が必要なものあり）
python TradeBook/tools/test_gen_indicators.py
```

## eval 先行（成功条件を実装前に定義）

新しいスコア軸・データ契約・仮説・レポートを作るときは、**コードを書く前に「成功条件」と
「Grader（Code/Model/Human）」を定義**します。ルールは `.claude/rules/eval_first.md` を参照。
TradeBook では多くの判断が ADR（`TradeBook/docs/adr/`）のデータ契約と `tests/` の assert に集約されています。

## 実装前の規律（必読）

- **曖昧な作成依頼は要件を引き出してから着手する**: 機能追加・新規作成・挙動変更の依頼が曖昧なとき
  （目的・対象・成功基準が不明確なとき）は、実装前に目的・制約・成功基準を確認する。**甘い仕様のままコードを書かない。**
- **コード変更前に該当 ADR を読む**: 既存コードの編集・追加・削除を始める前に、関係する ADR の
  Context/Decision（データ契約）を読み、合否の測り方（テスト / eval）を決めてから着手する。

## プロジェクト個別コンテキスト（AGENTS.md）

`TradeBook/` には `AGENTS.md`（AI向けの設計原則・禁止パターン・データ連携・落とし穴）を置いています。
**TradeBook のコードを変更する前に、必ず `TradeBook/AGENTS.md` を読むこと。**

## アーキテクチャ（ADR）

ADRはワークスペース級が `docs/adr/`、TradeBook 固有が `TradeBook/docs/adr/`（`TBK-NNNN`）に記録されています。
ルール変更時は必ず新ADRを作成し、旧ADRを `Superseded` にしてください（直接上書き禁止）。
採番・ライフサイクルの詳細は `.claude/rules/adr.md` を参照してください。
