// 支持線・抵抗線表示（TBK-0014）の純粋関数テスト
import test from "node:test";
import assert from "node:assert/strict";

import { srForCode, nearestSr, fmtSrDist } from "../js/srlevels.js";

const payload = {
  updated: "2026-07-17",
  params: { max_levels: 3 },
  stocks: [
    { code: "7203", close: 3000, support: [2900, 2750, 2500], resistance: [3100, 3250] },
    { code: "9501", close: 500, support: [], resistance: [520] },
  ],
};

test("srForCode: 対象銘柄を引ける・無ければ null", () => {
  assert.equal(srForCode(payload, "7203").close, 3000);
  assert.equal(srForCode(payload, 7203).close, 3000); // 数値コードでも一致
  assert.equal(srForCode(payload, "9999"), null);
  assert.equal(srForCode(null, "7203"), null);
});

test("nearestSr: close 基準で最寄りの支持線・抵抗線を返す", () => {
  const sr = srForCode(payload, "7203");
  const { support, resistance } = nearestSr(sr);
  assert.equal(support.price, 2900);
  assert.equal(resistance.price, 3100);
  assert.ok(Math.abs(support.dist - (2900 - 3000) / 3000) < 1e-12);
  assert.ok(Math.abs(resistance.dist - (3100 - 3000) / 3000) < 1e-12);
});

test("nearestSr: 現在値が水準を跨いだら振り分け直す（場中価格対応）", () => {
  const sr = srForCode(payload, "7203");
  // 現在値が 2800 まで下落 → 元の支持線 2900 は抵抗側に回る
  const { support, resistance } = nearestSr(sr, 2800);
  assert.equal(support.price, 2750);
  assert.equal(resistance.price, 2900);
});

test("nearestSr: 片側しか無い場合は無い側が null", () => {
  const sr = srForCode(payload, "9501");
  const { support, resistance } = nearestSr(sr);
  assert.equal(support, null);
  assert.equal(resistance.price, 520);
});

test("nearestSr: 不正入力は両側 null（クラッシュしない）", () => {
  assert.deepEqual(nearestSr(null), { support: null, resistance: null });
  assert.deepEqual(nearestSr({ close: "abc", support: [], resistance: [] }), {
    support: null,
    resistance: null,
  });
});

test("fmtSrDist: 符号付きパーセント表示", () => {
  assert.equal(fmtSrDist(-0.032), "-3.2%");
  assert.equal(fmtSrDist(0.041), "+4.1%");
  assert.equal(fmtSrDist(NaN), "");
});
