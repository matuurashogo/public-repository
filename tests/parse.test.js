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

test("無関係なテキストは null を返す", () => {
  assert.equal(parseTradeText("こんにちは"), null);
  assert.equal(parseTradeText(""), null);
  assert.equal(parseTradeText(null), null);
});
