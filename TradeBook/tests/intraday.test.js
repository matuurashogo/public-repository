// intraday.js の純粋関数（pickFresh / asOfLabel）の単体テスト（Node標準 node:test）
//   実行: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickFresh, asOfLabel, MAX_AGE_MIN } from "../js/intraday.js";

const ASOF = "2026-06-11T13:30:00+09:00";
const ASOF_MS = Date.parse(ASOF);
const payload = { asOf: ASOF, source: "yahoo_chart", prices: { "5016": 3392.0 } };

test("pickFresh: 新鮮なデータは prices と時点ラベルを返す", () => {
  const r = pickFresh(payload, ASOF_MS + 5 * 60_000); // 5分後
  assert.deepEqual(r.prices, { "5016": 3392.0 });
  assert.equal(r.label, "13:30");
});

test("pickFresh: 古いデータは null（終値フォールバック・TBK-0008）", () => {
  // ちょうど閾値は許容、1ms 超えたら古い
  assert.ok(pickFresh(payload, ASOF_MS + MAX_AGE_MIN * 60_000) !== null);
  assert.equal(pickFresh(payload, ASOF_MS + MAX_AGE_MIN * 60_000 + 1), null);
});

test("pickFresh: 壊れたデータは null（asOf欠損・パース不能・未来すぎる）", () => {
  assert.equal(pickFresh(null, ASOF_MS), null);
  assert.equal(pickFresh({ prices: {} }, ASOF_MS), null);
  assert.equal(pickFresh({ asOf: "こわれた日付", prices: {} }, ASOF_MS), null);
  // asOf が現在より11分以上未来 = 異常データ
  assert.equal(pickFresh(payload, ASOF_MS - 11 * 60_000), null);
});

test("asOfLabel: ISO 8601 から HH:MM を切り出す", () => {
  assert.equal(asOfLabel("2026-06-11T09:05:00+09:00"), "09:05");
  assert.equal(asOfLabel(""), "");
  assert.equal(asOfLabel(null), "");
});
