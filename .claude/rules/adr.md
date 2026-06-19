# ADR 管理ルール (Architecture Decision Records)

## 基本方針

アーキテクチャ・データ契約に関わる技術的判断はすべてADRとして記録します。
既存のADRを直接書き換えることは禁止です。

## ADR ライフサイクル

```
Proposed → Accepted → Superseded（書き換え不可、新ADRで置換）
                    ↘ Deprecated
```

| ステータス | 意味 | AIエージェントへの指示 |
|---|---|---|
| `Proposed` | レビュー中。まだ有効ではない | このADRに従う必要はない |
| `Accepted` | 採択済み。現在有効 | **このADRに必ず従うこと** |
| `Superseded` | 別のADRに置き換えられた | `Superseded by` のADRに従うこと。歴史的記録として保存 |
| `Deprecated` | 廃止。置き換えなし | このADRは無効 |

## 変更手順（必ず守ること）

1. **既存ADRを書き換えない** — 旧ADRの `Status` を `Superseded` に更新し、`Superseded by: <新ADR番号>` を記入するだけ。
2. **新ADRを作成する** — 新しい決定内容を新番号で記録する。
3. **データ契約を変えたらテストを更新する** — 該当する `TradeBook/tests/*.test.js` や
   `TradeBook/tools/test_*.py` の assert を新契約に合わせて更新する（契約とテストはセット）。

> 軽微な修正（誤字・コンテキスト追記）は既存ADRを直接編集してよい。

## 採番ルール（ファイル名）

新規ADRのファイル名は**正準形式に統一**すること。

```
<SCOPE>-<NNNN>-説明.md
```

- `SCOPE`: ワークスペース全体は `GLOB`、TradeBook 固有は `TBK`。
- `NNNN`: スコープ内の4桁連番（例: `GLOB-0001`, `TBK-0013`）。
- 配置先: TradeBook 固有は `TradeBook/docs/adr/`、ワークスペース全体は `docs/adr/`。
- Status は**テーブル形式**で記載すること。テンプレ `docs/adr/TEMPLATE.md` に従う。

## ADRテンプレート

テンプレートは `docs/adr/TEMPLATE.md` を参照してください。
既存の TradeBook ADR は `TradeBook/docs/adr/TBK-0001` 〜 にあります。
