// parseTradeText の単体テスト（松井「約定詳細」のLive Text出力を想定）
//   実行: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTradeText } from "../js/parse.js";

// 実機スクショ（約定詳細・現物買・特定）をLive Textでコピーした想定の文字列
const BUY_TOKUTEI = `約定詳細
電子材料 ★
6855 東証*
06/05 15:30
7,720
-70 -0.89%
注文情報（簡易）
受付日時 2026/06/05 10:46
取引区分 現物買
口座区分 特定
発注数 100株
執行条件 --
値段 7,490円
トリガー値段 --円
予約値段 --円
約定明細
約定数 100株
約定日 2026/06/05
受渡日 2026/06/09
受渡金額 -750,188円
約定代金 749,000円`;

test("約定詳細(現物買・特定): 全項目を正しく抽出する", () => {
  const p = parseTradeText(BUY_TOKUTEI);
  assert.deepEqual(p, {
    date: "2026-06-05",
    code: "6855",
    name: "電子材料",
    side: "買",
    quantity: 100,
    price: 7490, // 約定代金749,000 ÷ 約定数100
    account: "特定",
  });
});

test("現物売・NISA: 売却と口座を判別する", () => {
  const p = parseTradeText(`約定詳細
芝浦メカトロニクス
6590 東証
取引区分 現物売
口座区分 NISA
約定数 100株
約定日 2026/05/25
約定代金 545,000円`);
  assert.equal(p.side, "売");
  assert.equal(p.account, "NISA");
  assert.equal(p.code, "6590");
  assert.equal(p.date, "2026-05-25");
  assert.equal(p.quantity, 100);
  assert.equal(p.price, 5450);
});

test("約定代金が無ければ約定単価/値段から単価を取る", () => {
  const p = parseTradeText(`取引区分 現物買
口座区分 特定
約定数 100株
約定日 2026/06/04
値段 6,090円`);
  assert.equal(p.price, 6090);
  assert.equal(p.quantity, 100);
});

test("一般口座は特定（課税）扱いにマップする", () => {
  const p = parseTradeText(`取引区分 現物買
口座区分 一般
約定数 100株
約定日 2026/06/04
値段 6,090円`);
  assert.equal(p.account, "特定");
});

test("コードは年(2026)を誤検出しない", () => {
  const p = parseTradeText(BUY_TOKUTEI);
  assert.equal(p.code, "6855");
});

// 実機OCR(Tesseract)の生出力。丸数字に化け・文字間空白・カンマがピリオド誤読される。
const OCR_RAW = `⑨:①⑧ ml 令 GD
く 約 定 詳 細
電 子 材 料 0⑥/0⑤ ⑮:③0
ー ⑦⑦②0 -o.⑧⑨%
注 文 情 報 ( 簡 易 )
受 付 日 時 ⑳②⑥/0⑥/0⑤ ⑩:④⑥
取 引 区 分 現 物 買
口 座 区 分 特 定
発 注 数 ⑩0 株
執 行 条 件 ー
値 段 ⑦.④⑨0 円
約 定 明 細
約 定 数 ⑩0 株
約 定 日 ⑳②⑥/0⑥/0⑤
受 渡 日 ⑳②⑥/0⑥/0⑨
受 渡 金 額 -⑦⑤0,①⑧⑧ 円
約 定 代 金 ⑦④⑨.000 円`;

test("OCR生出力(丸数字・空白・カンマ誤読)を正規化して抽出する", () => {
  const p = parseTradeText(OCR_RAW);
  assert.equal(p.date, "2026-06-05");
  assert.equal(p.side, "買");
  assert.equal(p.account, "特定");
  assert.equal(p.quantity, 100);
  assert.equal(p.price, 7490); // 約定代金749,000 ÷ 100
  // コード数字(6855)は読めず誤検出も避けるため null。ただし社名は拾えるので逆引きに使える。
  assert.equal(p.code, null);
  assert.equal(p.name, "電子材料");
});

test("無関係なテキストは null を返す", () => {
  assert.equal(parseTradeText("こんにちは"), null);
  assert.equal(parseTradeText(""), null);
  assert.equal(parseTradeText(null), null);
});
