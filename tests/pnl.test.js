// pnl.js の単体テスト（Node標準 node:test で実行）
//   実行: node --test TradeBook/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TAX_RATE,
  estimateTax,
  calcRealized,
  aggregate,
  cumulative,
  matsuiBoxRate,
  withMatsuiFees,
} from "../js/pnl.js";

test("estimateTax: 利益には20.315%課税、損失・ゼロは非課税", () => {
  assert.equal(TAX_RATE, 0.20315);
  assert.equal(estimateTax(100000), 20315);
  assert.equal(estimateTax(0), 0);
  assert.equal(estimateTax(-5000), 0);
});

test("単純な買い→全部売り", () => {
  const trades = [
    { id: "1", date: "2026-03-10", code: "7203", side: "買", quantity: 100, price: 2300 },
    { id: "2", date: "2026-03-25", code: "7203", side: "売", quantity: 100, price: 3466 },
  ];
  const { records, holdings } = calcRealized(trades);
  assert.equal(records.length, 1);
  assert.equal(records[0].pnl, 116600); // (3466-2300)*100
  assert.equal(holdings["7203"].quantity, 0);
});

test("買い増し→一部売却（平均法）", () => {
  const trades = [
    { id: "1", date: "2026-01-05", code: "6758", side: "買", quantity: 100, price: 1000 },
    { id: "2", date: "2026-02-05", code: "6758", side: "買", quantity: 100, price: 2000 },
    // 平均取得単価 = (100*1000 + 100*2000) / 200 = 1500
    { id: "3", date: "2026-03-05", code: "6758", side: "売", quantity: 100, price: 1800 },
  ];
  const { records, holdings } = calcRealized(trades);
  assert.equal(records.length, 1);
  assert.equal(records[0].avgCost, 1500);
  assert.equal(records[0].pnl, 30000); // (1800-1500)*100
  assert.equal(holdings["6758"].quantity, 100); // 100株残
});

test("損失取引は概算税0", () => {
  const trades = [
    { id: "1", date: "2026-04-05", code: "6758", side: "買", quantity: 100, price: 13000 },
    { id: "2", date: "2026-04-20", code: "6758", side: "売", quantity: 100, price: 11750 },
  ];
  const { records } = calcRealized(trades);
  assert.equal(records[0].pnl, -125000);
  const rows = aggregate(records, "month");
  assert.equal(rows[0].gross, -125000);
  assert.equal(rows[0].tax, 0);
  assert.equal(rows[0].net, -125000);
});

test("複数銘柄・年間/月間/銘柄別の集計", () => {
  const trades = [
    { id: "1", date: "2026-03-10", code: "7203", side: "買", quantity: 100, price: 2300 },
    { id: "2", date: "2026-03-25", code: "7203", side: "売", quantity: 100, price: 3466 }, // +116600 (3月)
    { id: "3", date: "2026-04-05", code: "6758", side: "買", quantity: 100, price: 13000 },
    { id: "4", date: "2026-04-20", code: "6758", side: "売", quantity: 100, price: 11750 }, // -125000 (4月)
    { id: "5", date: "2026-05-02", code: "7011", side: "買", quantity: 100, price: 2000 },
    { id: "6", date: "2026-05-20", code: "7011", side: "売", quantity: 100, price: 2482 }, // +48200 (5月)
  ];
  const { records } = calcRealized(trades);

  const year = aggregate(records, "year");
  assert.equal(year.length, 1);
  assert.equal(year[0].key, "2026");
  assert.equal(year[0].gross, 116600 - 125000 + 48200); // 39800
  assert.equal(year[0].tax, estimateTax(39800));

  const month = aggregate(records, "month");
  assert.deepEqual(month.map((m) => m.key), ["2026-05", "2026-04", "2026-03"]); // 新しい順
  const may = month.find((m) => m.key === "2026-05");
  assert.equal(may.gross, 48200);

  const byCode = aggregate(records, "code", (c) => `名称_${c}`);
  assert.equal(byCode[0].key, "7203"); // 損益最大が先頭
  assert.equal(byCode[0].name, "名称_7203");
});

test("保有を超える売却は警告し保有分のみ計算", () => {
  const trades = [
    { id: "1", date: "2026-01-10", code: "9999", side: "買", quantity: 50, price: 1000 },
    { id: "2", date: "2026-01-20", code: "9999", side: "売", quantity: 100, price: 1200 },
  ];
  const { records, warnings } = calcRealized(trades);
  assert.equal(warnings.length, 1);
  assert.equal(records[0].quantity, 50); // 保有分のみ
  assert.equal(records[0].pnl, 10000); // (1200-1000)*50
});

test("手数料: 買は取得原価に加算、売は売却額から控除", () => {
  const trades = [
    { id: "1", date: "2026-03-10", code: "7203", side: "買", quantity: 100, price: 1000, fee: 500 },
    { id: "2", date: "2026-03-25", code: "7203", side: "売", quantity: 100, price: 1200, fee: 300 },
  ];
  const { records } = calcRealized(trades);
  // 取得原価 = 100*1000 + 500 = 100500、平均取得単価 = 1005
  assert.equal(records[0].avgCost, 1005);
  // pnl = 1200*100 - 1005*100 - 300(売手数料) = 120000 - 100500 - 300 = 19200
  assert.equal(records[0].pnl, 19200);
});

test("NISA口座は課税対象から除外される（gross は含むが tax は0）", () => {
  const trades = [
    // NISA: +30,000（非課税）
    { id: "1", date: "2026-02-01", code: "7203", side: "買", quantity: 100, price: 1000, account: "NISA" },
    { id: "2", date: "2026-02-10", code: "7203", side: "売", quantity: 100, price: 1300, account: "NISA" },
    // 特定: +20,000（課税）
    { id: "3", date: "2026-02-01", code: "6758", side: "買", quantity: 100, price: 2000, account: "特定" },
    { id: "4", date: "2026-02-10", code: "6758", side: "売", quantity: 100, price: 2200, account: "特定" },
  ];
  const { records } = calcRealized(trades);
  const year = aggregate(records, "year");
  assert.equal(year[0].gross, 50000); // 30000(NISA) + 20000(特定)
  assert.equal(year[0].taxable, 20000); // 特定のみ
  assert.equal(year[0].tax, estimateTax(20000));
  assert.equal(year[0].net, 50000 - estimateTax(20000));
});

test("matsuiBoxRate: 1日の約定代金合計で段階的に決まる", () => {
  assert.equal(matsuiBoxRate(0), 0);
  assert.equal(matsuiBoxRate(500000), 0); // 〜50万は無料
  assert.equal(matsuiBoxRate(500001), 1100); // 〜100万
  assert.equal(matsuiBoxRate(1000000), 1100);
  assert.equal(matsuiBoxRate(1000001), 2200); // 〜200万
  assert.equal(matsuiBoxRate(2000000), 2200);
  assert.equal(matsuiBoxRate(300000000), 110000); // 上限
});

test("withMatsuiFees: 50万円/日まで0円、NISAは無料扱い", () => {
  const trades = [
    { id: "1", date: "2026-03-01", code: "7203", side: "買", quantity: 100, price: 4000 }, // 40万・特定→0
    { id: "2", date: "2026-03-02", code: "6758", side: "買", quantity: 100, price: 9000, account: "NISA" }, // 90万・NISA→0
  ];
  const out = withMatsuiFees(trades);
  assert.equal(out[0].fee, 0);
  assert.equal(out[1].fee, 0);
});

test("withMatsuiFees: 同日の特定取引へ約定代金で按分（合計はボックスレートに一致）", () => {
  const trades = [
    { id: "1", date: "2026-03-01", code: "7203", side: "買", quantity: 100, price: 7000 }, // 70万
    { id: "2", date: "2026-03-01", code: "6758", side: "売", quantity: 100, price: 5000 }, // 50万
  ];
  // 合計120万 → ボックスレート2200
  const out = withMatsuiFees(trades);
  assert.equal(out[0].fee + out[1].fee, 2200); // 按分しても合計一致
  assert.equal(out[0].fee, Math.round(2200 * (700000 / 1200000))); // 1283
});

test("withMatsuiFees → calcRealized: 買は原価、売は売却額に手数料が反映される", () => {
  const trades = [
    { id: "1", date: "2026-03-01", code: "7203", side: "買", quantity: 100, price: 6000 }, // 60万→1100
    { id: "2", date: "2026-03-10", code: "7203", side: "売", quantity: 100, price: 7000 }, // 70万→1100
  ];
  const { records } = calcRealized(withMatsuiFees(trades));
  // 取得原価 = 600000 + 1100 = 601100、売却 = 700000 - 1100
  // pnl = 700000 - 1100 - 601100 = 97800
  assert.equal(records[0].pnl, 97800);
});

test("累積損益は約定日順の積み上げ", () => {
  const records = [
    { date: "2026-05-20", code: "7011", quantity: 100, sellPrice: 2482, avgCost: 2000, pnl: 48200 },
    { date: "2026-03-25", code: "7203", quantity: 100, sellPrice: 3466, avgCost: 2300, pnl: 116600 },
    { date: "2026-04-20", code: "6758", quantity: 100, sellPrice: 11750, avgCost: 13000, pnl: -125000 },
  ];
  const cum = cumulative(records);
  assert.deepEqual(cum.map((c) => c.date), ["2026-03-25", "2026-04-20", "2026-05-20"]);
  assert.deepEqual(cum.map((c) => c.cum), [116600, -8400, 39800]);
});
