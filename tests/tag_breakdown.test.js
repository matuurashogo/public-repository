// entryTagAttribution / tagBreakdown の単体テスト（Node標準 node:test）
//   実行: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { entryTagAttribution, tagBreakdown } from "../js/pnl.js";

// 行をタグで引くヘルパー
const byTag = (rows, tag) => rows.find((r) => r.tag === tag);

test("tagBreakdown(entry): 1対1売買はタグに全額が乗る（厳密一致）", () => {
  const trades = [
    { id: "b1", date: "2026-01-01", code: "7203", side: "買", quantity: 100, price: 1000, entryTag: "25日線タッチ" },
    { id: "s1", date: "2026-01-11", code: "7203", side: "売", quantity: 100, price: 1300 }, // +30,000
    { id: "b2", date: "2026-02-01", code: "6758", side: "買", quantity: 100, price: 2000, entryTag: "高ボラ急落リバウンド" },
    { id: "s2", date: "2026-02-21", code: "6758", side: "売", quantity: 100, price: 1500 }, // −50,000
  ];
  const rows = tagBreakdown(trades, "entry");

  const a = byTag(rows, "25日線タッチ");
  assert.equal(a.count, 1);
  assert.equal(a.totalPnl, 30000);
  assert.equal(a.winRate, 1);
  assert.equal(a.avgWin, 30000);
  assert.equal(a.avgLoss, null);
  assert.equal(a.expectancy, 30000);

  const b = byTag(rows, "高ボラ急落リバウンド");
  assert.equal(b.count, 1);
  assert.equal(b.totalPnl, -50000);
  assert.equal(b.winRate, 0);
  assert.equal(b.avgLoss, -50000);

  // 合計損益の大きい順
  assert.equal(rows[0].tag, "25日線タッチ");
});

test("entryTagAttribution: 分割エントリーは株数比で按分される", () => {
  const trades = [
    { id: "b1", date: "2026-01-01", code: "7203", side: "買", quantity: 100, price: 1000, entryTag: "A" },
    { id: "b2", date: "2026-01-05", code: "7203", side: "買", quantity: 100, price: 1200, entryTag: "B" },
    { id: "s1", date: "2026-01-20", code: "7203", side: "売", quantity: 200, price: 1300 },
    // 平均取得 1100 → pnl = (1300-1100)*200 = +40,000
  ];
  const attr = entryTagAttribution(trades);
  assert.equal(attr.length, 2);
  const a = attr.find((x) => x.entryTag === "A");
  const b = attr.find((x) => x.entryTag === "B");
  assert.equal(a.qty, 100);
  assert.equal(a.pnlShare, 20000); // 40,000 × 100/200
  assert.equal(b.pnlShare, 20000);

  const rows = tagBreakdown(trades, "entry");
  assert.equal(byTag(rows, "A").totalPnl, 20000);
  assert.equal(byTag(rows, "B").totalPnl, 20000);
});

test("tagBreakdown(exit): 売りのexitTagを直接集計し、未設定はまとめる", () => {
  const trades = [
    { id: "b1", date: "2026-01-01", code: "7203", side: "買", quantity: 100, price: 1000 },
    { id: "s1", date: "2026-01-11", code: "7203", side: "売", quantity: 100, price: 1300, exitTag: "利確（目標到達）" },
    { id: "b2", date: "2026-02-01", code: "6758", side: "買", quantity: 100, price: 2000 },
    { id: "s2", date: "2026-02-21", code: "6758", side: "売", quantity: 100, price: 1500, exitTag: "損切り（ルール通り）" },
    { id: "b3", date: "2026-03-01", code: "9999", side: "買", quantity: 100, price: 500 },
    { id: "s3", date: "2026-03-06", code: "9999", side: "売", quantity: 100, price: 800 }, // exitTag 無し
  ];
  const rows = tagBreakdown(trades, "exit");
  assert.equal(byTag(rows, "利確（目標到達）").totalPnl, 30000);
  assert.equal(byTag(rows, "損切り（ルール通り）").totalPnl, -50000);
  assert.equal(byTag(rows, "（未設定）").totalPnl, 30000);
  assert.equal(byTag(rows, "（未設定）").count, 1);
});

test("tagBreakdown: 入口タグ未設定の買いは（未設定）グループへ", () => {
  const trades = [
    { id: "b1", date: "2026-01-01", code: "7203", side: "買", quantity: 100, price: 1000 }, // entryTag 無し
    { id: "s1", date: "2026-01-11", code: "7203", side: "売", quantity: 100, price: 1300 },
  ];
  const rows = tagBreakdown(trades, "entry");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tag, "（未設定）");
  assert.equal(rows[0].totalPnl, 30000);
});

test("tagBreakdown: 未知のaxisは例外", () => {
  assert.throws(() => tagBreakdown([], "nope"), /unknown axis/);
});
