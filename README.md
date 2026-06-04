# TradeBook — 松井証券向け 損益計算Webアプリ

取引を手入力で記録し、**実現損益**を平均法で計算して **年間 / 月間 / 銘柄別** に集計・可視化する、iPhone想定のクライアント完結型Webアプリ。データの正は **Google Drive 上の単一マスターファイル** で、端末に縛られず複数端末から同じデータを参照できる。

- 設計: `docs/plans/2026-05-30-tradebook-pnl-design.md`
- 採用判断: `docs/adr/GLOB-0002-tradebook-frontend-cloud-stack.md`

## 主な機能

- 取引の手入力（約定日 / 銘柄コード / 売買 / 数量 / 約定単価 / **口座区分（特定・NISA）**）。銘柄コードから銘柄名を自動表示。
- 平均法による実現損益、**概算税額（20.315%）・税引後損益**の自動表示。**手数料は松井証券のボックスレート（1日の約定代金合計）で自動計算**し、買=取得原価・売=売却額に反映（レート表は `js/config.js` の `MATSUI_BOX_RATE`）。**NISA は非課税**として税額計算から除外。
- 年間 / 月間 / 銘柄別の集計表と、**累積損益の折れ線グラフ**（Chart.js 同梱・オフライン可）。税額は申告分離課税の実態に合わせ **年単位でのみ表示**（月別・銘柄別は税引前のみ）。
- **トレード成績（KPI）** カード（今年ベース）: 勝率・平均利益/損失・損益レシオ・期待値・最大ドローダウン・売却回数・平均保有期間（勝ち/負け別で塩漬け検出）と、**損益分布ヒストグラム**。
- **保有銘柄カードの含み損益（評価損益）**: [`jquants-data`](https://github.com/matuurashogo/jquants-data) の最新終値を使い、保有銘柄の**現在値・評価額・含み損益（未実現）**とポートフォリオ合計を表示（基準日明記・終値ベース）。価格は GitHub Actions が毎営業日 07:30 JST に自動更新（`data/latest_prices.json`）。詳細は `docs/plans/2026-05-31-tradebook-holdings-pnl-design.md`。
- **エントリー/手仕舞い根拠（タグ＋メモ）**: 買いに「押し目の型」、売りに「手仕舞いの理由」をタグ（追加可）とメモで記録。**エントリー型別成績**カードで、入口タグ別／出口タグ別に勝率・平均利益/損失・期待値・合計損益を比較し、「どの押し目の取り方が勝っているか」を検証できる。入口タグ別は売却損益をFIFOで買いロットへ遡って集計（1対1は厳密、分割は株数按分）。設計は `docs/plans/2026-06-04-tradebook-entry-rationale-design.md`。
- **エントリー・スナップショット（客観データで答え合わせ）**: 買った日付×銘柄から、その時点の客観指標（**25日線乖離=凹みの深さ／75日線に対する位置=トレンド／売買代金20日平均比=出来高急増度**）を後から自動で引き当てて表示。型別成績の集計軸を「凹みの深さ別／出来高急増別／トレンド位置別」に切り替えると、自己申告タグではなく**実データの型**で勝率を検証できる（「なんとなく買ったが、データ上は深い押し目＋出来高急増だった」）。指標は [`jquants-data`](https://github.com/matuurashogo/jquants-data) の終値・売買代金から GitHub Actions が日次生成（`data/indicators/<code>.json`、VolDipSignals と同一定義）。**対象は監視リスト（`data/indicators_universe.json`）方式**で、エントリーした銘柄をリストに追加すると履歴が生成される。
- 過去取引の編集・削除（変更で自動再計算・自動保存）。
- PWA対応（iPhoneのホーム画面に追加してアプリのように利用）。

> Google未設定の状態でも、データは端末内（localStorage）に保存され**ローカルだけで動作**します。クラウド同期を使う場合のみ、下記セットアップが必要です。

## データの取り込みについて（重要）

松井証券は個人向けの公開取引APIを提供しておらず、**iOSのSafariではお客様サイトの「CSV出力」ボタンが表示されません**。このアプリは取引を**手入力で記録**する方式のため、CSV取得の制約を受けません。

## 初期セットアップ（クラウド同期を使う場合・一度きり）

Google Drive と同期するには、自分用の OAuth クライアントID を発行します（無料）。

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを新規作成。
2. 「APIとサービス」→「ライブラリ」で **Google Drive API** を有効化。
3. 「OAuth同意画面（Google Auth Platform）」→ ユーザータイプ「外部」→ アプリ名・連絡先を入力。スコープに `.../auth/drive.file` を追加。
4. 「認証情報」→「認証情報を作成」→「OAuth クライアントID」→ アプリケーションの種類「**ウェブアプリケーション**」。
5. 「**承認済みの JavaScript 生成元**」に、アプリを開くURLのオリジンを追加：
   - GitHub Pages: `https://<ユーザー名>.github.io`
   - ローカル確認用: `http://localhost:8765`
6. 発行された **クライアントID** を `js/config.js` の `GOOGLE_CLIENT_ID` に貼り付け。
7. **OAuth同意画面を「本番環境」に切り替える**（推奨）。Google Auth Platform →「対象（Audience）」→ **「アプリを公開」/「本番環境に移行」** をクリック。
   - `drive.file` 単独スコープは sensitive/restricted ではないため、**審査不要のまま公開でき、サインイン時の警告画面が出なくなります**（「確認が必要」と表示されなければ完了）。
   - テストモードのままだと **7日でログインが切れる**ため、本番公開を推奨します。テストユーザー登録で運用する場合は、自分のGoogleアカウントを「テストユーザー」に追加してください（7日制約あり）。

設定後、アプリ上部の「Googleでサインインして同期」からサインインすると、Drive上に `TradeBook_master.json` を作成・同期します（スコープ `drive.file` のため、このアプリが作ったファイル以外にはアクセスしません）。

## デプロイ（任意）

静的ファイルのみのため、GitHub Pages などにそのまま配置できます。iPhoneのSafariで開き、共有メニューから「ホーム画面に追加」でPWAとして利用できます。

## 開発

```bash
# 損益計算ロジックの単体テスト
node --test TradeBook/tests/

# 銘柄リスト(data/stocks.json)の再生成（JQuantsExtractor のデータを元に生成）
python TradeBook/tools/gen_stocks.py

# エントリー指標スナップショットの生成（監視リスト銘柄・jquants-data 必須）
python TradeBook/tools/gen_indicators.py
# 指標計算ロジックの単体テスト（pandas 必須）
python TradeBook/tools/test_gen_indicators.py
```

### エントリー・スナップショットの監視リスト

`data/indicators_universe.json` の `codes` に並べた4桁コードについて、`tools/gen_indicators.py` が
`jquants-data` の日次株価から指標履歴 `data/indicators/<code>.json`（直近約2年・終値ベース）を生成します。
全約3,800銘柄を毎日コミットすると git 履歴が肥大化するため、**対象は監視リストで限定**しています
（エントリーした銘柄をリストに追加する運用）。アプリは取引した銘柄のファイルだけを遅延取得し、買い日付の
スナップショットを引き当てます。監視リスト外・期間外の銘柄は「データなし」となり、客観軸の集計からは除外されます。

### 銘柄名リストについて

`data/stocks.json` はコード→名称対応（約3,800銘柄）。主データは `JQuantsExtractor/data/subsector_master.jsonl`（約2,200銘柄）で、これに加えて兄弟ディレクトリに [`jquants-data`](https://github.com/matuurashogo/jquants-data) リポジトリがあれば、その `full/sector33_*.parquet` の `company` 列（ほぼ全上場銘柄の社名）から**主データに無い銘柄名のみ**を補完します（`pyarrow` 必須・任意依存。場所は環境変数 `JQUANTS_PARQUET_REPO` で指定可）。補完は追加のみで既存の名称は上書きしません。なお未収録コードは名称が空欄になります（記録・計算自体は可能）。

## スコープ外（次フェーズ）

CSVインポート/エクスポート、評価損益（含み損益）・現在株価、配当、信用の空売り。
