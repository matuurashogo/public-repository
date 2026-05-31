// pnl.js の calcUnrealized（保有銘柄の含み損益）単体テスト
//   実行: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { calcUnrealized } from "../js/pnl.js";

test("通常銘柄: 評価額・含み損益・率を正しく算出する", () => {
  // 100株、取得原価 100,000円（手数料込み）→ 平均1000円。現在値1200円。
  const holdings = { 7203: { quantity: 100, cost: 100000 } };
  const { rows, total } = calcUnrealized(holdings, { 7203: 1200 });

  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.priced, true);
  assert.equal(r.price, 1200);
  assert.equal(r.marketValue, 120000); // 1200 * 100
  assert.equal(r.unrealized, 20000); // 120000 - 100000
  assert.equal(r.unrealizedRate, 0.2); // 20000 / 100000

  assert.equal(total.marketValue, 120000);
  assert.equal(total.cost, 100000);
  assert.equal(total.unrealized, 20000);
  assert.equal(total.unrealizedRate, 0.2);
  assert.equal(total.pricedAll, true);
  assert.equal(total.unpricedCount, 0);
});

test("含み損: 現在値が取得原価を下回るとマイナス", () => {
  const holdings = { 6758: { quantity: 50, cost: 100000 } }; // 平均2000円
  const { rows, total } = calcUnrealized(holdings, { 6758: 1800 });
  assert.equal(rows[0].marketValue, 90000); // 1800 * 50
  assert.equal(rows[0].unrealized, -10000);
  assert.equal(rows[0].unrealizedRate, -0.1);
  assert.equal(total.unrealized, -10000);
});

test("価格欠損銘柄: priced=false・合計から除外される", () => {
  const holdings = {
    7203: { quantity: 100, cost: 100000 }, // 価格あり
    9999: { quantity: 10, cost: 50000 }, // 価格なし
  };
  const { rows, total } = calcUnrealized(holdings, { 7203: 1200 });

  const priced = rows.find((r) => r.code === "7203");
  const unpriced = rows.find((r) => r.code === "9999");
  assert.equal(priced.priced, true);
  assert.equal(unpriced.priced, false);
  assert.equal(unpriced.price, null);
  assert.equal(unpriced.marketValue, null);
  assert.equal(unpriced.unrealized, null);

  // 合計は価格が取れた 7203 のみ（cost も 100000 のみ、9999 の 50000 は含めない）
  assert.equal(total.cost, 100000);
  assert.equal(total.marketValue, 120000);
  assert.equal(total.unrealized, 20000);
  assert.equal(total.pricedCount, 1);
  assert.equal(total.unpricedCount, 1);
  assert.equal(total.pricedAll, false);
});

test("保有0（売却済み）の銘柄は対象外", () => {
  const holdings = {
    7203: { quantity: 0, cost: 0 },
    6758: { quantity: 10, cost: 20000 },
  };
  const { rows } = calcUnrealized(holdings, { 7203: 1200, 6758: 2500 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, "6758");
});

test("並び順: 評価額の大きい順", () => {
  const holdings = {
    1111: { quantity: 10, cost: 10000 }, // 評価額 15000
    2222: { quantity: 100, cost: 100000 }, // 評価額 120000
    3333: { quantity: 5, cost: 30000 }, // 評価額 50000
  };
  const { rows } = calcUnrealized(holdings, { 1111: 1500, 2222: 1200, 3333: 10000 });
  assert.deepEqual(rows.map((r) => r.code), ["2222", "3333", "1111"]);
});

test("空の保有: 行なし・合計ゼロ・pricedAll=true", () => {
  const { rows, total } = calcUnrealized({}, {});
  assert.equal(rows.length, 0);
  assert.equal(total.marketValue, 0);
  assert.equal(total.cost, 0);
  assert.equal(total.unrealized, 0);
  assert.equal(total.unrealizedRate, null); // 分母0
  assert.equal(total.pricedAll, true);
});

test("priceMap 未指定でも落ちない（全て未取得扱い）", () => {
  const holdings = { 7203: { quantity: 100, cost: 100000 } };
  const { rows, total } = calcUnrealized(holdings);
  assert.equal(rows[0].priced, false);
  assert.equal(total.pricedCount, 0);
  assert.equal(total.unpricedCount, 1);
});
