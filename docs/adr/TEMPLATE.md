# [{SCOPE}-{NNNN}] タイトル
# SCOPE: GLOB（ワークスペース全体）または TBK（TradeBook 固有）
# NNNN: スコープ内で連番。TradeBook 固有は TradeBook/docs/adr/ に置く

## 📜 ステータス

| 項目 | 値 |
|------|---|
| **Status** | `Proposed` \| `Accepted` \| `Superseded` \| `Deprecated` |
| **Date** | YYYY-MM-DD |
| **Supersedes** | （このADRが置き換える旧ADRがある場合: `{SCOPE}-NNNN`） |
| **Superseded by** | （このADRが新しいADRに置き換えられた場合: `{SCOPE}-NNNN`） |

### ステータス定義（ライフサイクル）

```
Proposed → Accepted → Superseded
                    ↘ Deprecated
```

| ステータス | 意味 | AIエージェントへの指示 |
|-----------|------|----------------------|
| `Proposed` | レビュー中。まだ有効ではない | このADRに従う必要はない |
| `Accepted` | 採択済み。現在有効 | **このADRに必ず従うこと** |
| `Superseded` | 別のADRに置き換えられた | `Superseded by` のADRに従うこと。歴史的記録として保存 |
| `Deprecated` | 廃止。置き換えなし | このADRは無効 |

> **重要**: ADRは絶対に内容を書き換えない。変更が必要な場合は新しいADRを作成し、ステータスを `Superseded by: {SCOPE}-NNNN` に更新する。

---

## ❓ コンテキスト（背景と課題）

（なぜこの決定が必要だったか。どのような問題があったか。）

## 💡 決定事項（Decision）

（何を決めたか。データ契約の場合はフィールド・型・単位を明記する。）

## 📈 結果・影響（Consequences）

（この決定によって何が変わったか。トレードオフは？）

## 📊 Eval 定義

（ティアA = 本番判断・データ契約に影響する決定の場合は必須。ティアB/C は省略可。
　ルール: `.claude/rules/eval_first.md`）

- **対象 (Target)**      : <何を評価するか・1行>
- **成功条件 (Success)**  : <「良い」を観測可能な言葉で。曖昧語禁止>
- **Grader (採点器)**     : <Code | Model | Human> ＋ <具体的な器>
- **合格閾値 (Threshold)** : <数値 / ルーブリック点 / スキーマ適合>
- **反例 (Negatives)**    : <これは不合格であるべき、という例>
- **状態 (State)**        : Draft | Running | Shipped（測定値ログ）

## 🔧 実行可能チェック（Enforcement）

（このADRを機械的に強制する手段。テスト名と実行コマンド。）

```bash
cd TradeBook && node --test tests/*.test.js
# または対応する Python ツールテスト
```

**ADR更新ルール（不変原則）**:
- Decision を変更したい → 旧ADRを Superseded にし、新ADRを作成する。
- データ契約を変えたら、対応する `tests/` の assert も新契約に合わせて更新する（契約とテストはセット）。
- 軽微な修正（誤字・コンテキスト追記）は直接編集可。
