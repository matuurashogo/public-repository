// calcKpis / holdingDaysBySell の単体テスト（Node標準 node:test）
//   実行: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { calcKpis, holdingDaysBySell } from "../js/pnl.js";

// 共通のサンプル取引（2026年）
// 7203: 100株@1000 買 → 100株@1300 売（+30,000・10日保有）
// 6758: 100株@2000 買 → 100株@1500 売（−50,000・20日保有）
// 9999: 100株@500  買 → 100株@800  売（+30,000・ 5日保有）
const trades = [
  { id: "b1", date: "2026-01-01", code: "7203", side: "買", quantity: 100, price: 1000 },
  { id: "s1", date: "2026-01-11", code: "7203", side: "売", quantity: 100, price: 1300 },
  { id: "b2", date: "2026-02-01", code: "6758", side: "買", quantity: 100, price: 2000 },
  { id: "s2", date: "2026-02-21", code: "6758", side: "売", quantity: 100, price: 1500 },
  { id: "b3", date: "2026-03-01", code: "9999", side: "買", quantity: 100, price: 500 },
  { id: "s3", date: "2026-03-06", code: "9999", side: "売", quantity: 100, price: 800 },
];

test("calcKpis: 勝率・件数・平均損益・損益レシオ・期待値", () => {
  const k = calcKpis(trades, "2026");
  assert.equal(k.sellCount, 3);
  assert.equal(k.buyCount, 3);
  assert.equal(k.winningCount, 2);
  assert.equal(k.losingCount, 1);
  assert.ok(Math.abs(k.winRate - 2 / 3) < 1e-9);
  assert.equal(k.avgWin, 30000); // (30000 + 30000) / 2
  assert.equal(k.avgLoss, -50000);
  assert.ok(Math.abs(k.payoffRatio - 30000 / 50000) < 1e-9); // 0.6倍
  assert.equal(k.expectancy, (30000 - 50000 + 30000) / 3); // +3333.33...
});

test("calcKpis: 平均保有期間（全体／勝ち／負け・実日数）", () => {
  const k = calcKpis(trades, "2026");
  // 全体: (10 + 20 + 5) / 3 = 11.666...
  assert.ok(Math.abs(k.avgHoldDays - 35 / 3) < 1e-9);
  // 勝ち: (10 + 5) / 2 = 7.5、負け: 20
  assert.equal(k.avgHoldDaysWin, 7.5);
  assert.equal(k.avgHoldDaysLoss, 20);
});

test("calcKpis: 最大ドローダウン（累積のピーク→谷）", () => {
  const k = calcKpis(trades, "2026");
  // 日付順 累積: +30,000 → −20,000 → +10,000
  // ピーク30,000 から −20,000 まで → DD = 50,000
  assert.equal(k.maxDrawdown, 50000);
});

test("calcKpis: ヒストグラム用 pnls は売却ごとの実現損益", () => {
  const k = calcKpis(trades, "2026");
  assert.deepEqual([...k.pnls].sort((a, b) => a - b), [-50000, 30000, 30000]);
});

test("calcKpis: 年フィルタで対象外の年は除外", () => {
  const k2025 = calcKpis(trades, "2025");
  assert.equal(k2025.sellCount, 0);
  assert.equal(k2025.winRate, null);
  assert.equal(k2025.avgWin, null);
  assert.equal(k2025.payoffRatio, null);
  assert.equal(k2025.maxDrawdown, 0);
});

test("calcKpis: 売却0件は各指標が null / 0 で安全", () => {
  const buysOnly = [
    { id: "b1", date: "2026-01-01", code: "7203", side: "買", quantity: 100, price: 1000 },
  ];
  const k = calcKpis(buysOnly, "2026");
  assert.equal(k.sellCount, 0);
  assert.equal(k.buyCount, 1);
  assert.equal(k.winRate, null);
  assert.equal(k.expectancy, null);
  assert.equal(k.avgHoldDays, null);
  assert.equal(k.maxDrawdown, 0);
  assert.deepEqual(k.pnls, []);
});

test("holdingDaysBySell: 分割売却は古いロットから株数加重で突き合わせ", () => {
  // 100株@10日前, 100株@4日前 を買い、その後 150株を売却
  // → 100株は10日保有, 50株は4日保有 → 加重平均 = (100*10 + 50*4) / 150 = 8日
  const t = [
    { id: "b1", date: "2026-04-01", code: "1234", side: "買", quantity: 100, price: 100 },
    { id: "b2", date: "2026-04-07", code: "1234", side: "買", quantity: 100, price: 100 },
    { id: "s1", date: "2026-04-11", code: "1234", side: "売", quantity: 150, price: 120 },
  ];
  const m = holdingDaysBySell(t);
  // b1: 04-01→04-11 = 10日、b2: 04-07→04-11 = 4日
  assert.ok(Math.abs(m.get("s1") - (100 * 10 + 50 * 4) / 150) < 1e-9);
});
