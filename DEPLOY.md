# TradeBook デプロイ手順（専用の公開リポジトリ + GitHub Pages）

本体リポジトリ（`private-repository`）は**非公開のまま**にし、TradeBook アプリだけを
**専用の公開リポジトリ**に切り出して GitHub Pages で無料公開する手順です。

> アプリコードに秘密情報はありません。`js/config.js` の Google OAuth クライアントID は
> 「ウェブアプリ用のクライアントID」で、仕様上クライアント側に露出する非機密値です
> （セキュリティは「承認済み JavaScript 生成元」で担保）。公開リポに含めて問題ありません。

## 1. 公開リポジトリを作成して中身を push（手元のPCで実行）

`TradeBook/` の**中身**を、新しい公開リポのルートに置きます。

### 方法A: gh CLI を使う（簡単）

```bash
# 本体リポジトリの TradeBook フォルダへ移動
cd path/to/private-repository/TradeBook

# この中身だけを独立したリポジトリとして初期化
git init -b main
git add .
git commit -m "TradeBook 初版"

# 公開リポジトリを作成して push（リポジトリ名は任意。例: tradebook）
gh repo create tradebook --public --source=. --remote=origin --push
```

### 方法B: 手動で作る

1. GitHub で新規 **public** リポジトリ `tradebook` を作成（README等は無しでOK）。
2. 上記の `git init / add / commit` まで実行後:
   ```bash
   git remote add origin https://github.com/matuurashogo/tradebook.git
   git push -u origin main
   ```

## 2. GitHub Pages を有効化（公開リポの Settings）

- 公開リポ → **Settings → Pages**
- **Build and deployment → Source: Deploy from a branch**
- **Branch: `main` / `/(root)`** を選択して **Save**
- 1分ほどで `https://matuurashogo.github.io/tradebook/` に公開されます。

## 3. Google OAuth の許可オリジンを追加（クラウド同期を使う場合）

- [Google Cloud Console](https://console.cloud.google.com/) → 認証情報 → 該当 OAuth クライアントID
- 「**承認済みの JavaScript 生成元**」に追加:
  - `https://matuurashogo.github.io`
- 発行したクライアントIDを `js/config.js` の `GOOGLE_CLIENT_ID` に設定し、公開リポにも反映（commit & push）。

## 4. iPhone で利用

- Safari で `https://matuurashogo.github.io/tradebook/` を開く
- 共有メニュー → **ホーム画面に追加** でアプリのように使えます。

## 更新の反映

本体リポジトリの `TradeBook/` を更新したら、その中身を公開リポへ反映してください
（変更ファイルをコピーして `git add/commit/push`）。
