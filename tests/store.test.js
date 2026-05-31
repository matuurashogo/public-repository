// store.js の mergeMasters（Drive同期マージ）の単体テスト
//   実行: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeMasters } from "../js/store.js";

const T = (id, updatedAt, extra = {}) => ({
  id,
  date: "2026-05-01",
  code: "7203",
  side: "買",
  quantity: 100,
  price: 1000,
  updatedAt,
  ...extra,
});

test("追加同士のマージ: 双方の取引が和集合で残る", () => {
  const local = { version: 2, trades: [T("a", 100)], deletedIds: {} };
  const remote = { version: 2, trades: [T("b", 100)], deletedIds: {} };
  const m = mergeMasters(local, remote);
  assert.deepEqual(m.trades.map((t) => t.id).sort(), ["a", "b"]);
});

test("同一idは updatedAt が新しい方を採用する", () => {
  const local = { version: 2, trades: [T("a", 200, { price: 1500 })], deletedIds: {} };
  const remote = { version: 2, trades: [T("a", 100, { price: 1000 })], deletedIds: {} };
  const m = mergeMasters(local, remote);
  assert.equal(m.trades.length, 1);
  assert.equal(m.trades[0].price, 1500); // ローカルが新しい
});

test("tombstone より古い取引は削除が有効（復活しない）", () => {
  // remote はまだ取引を持つが、local では削除済み（tombstone が取引より新しい）
  const local = { version: 2, trades: [], deletedIds: { a: 300 } };
  const remote = { version: 2, trades: [T("a", 100)], deletedIds: {} };
  const m = mergeMasters(local, remote);
  assert.equal(m.trades.length, 0); // 削除が勝つ＝復活しない
});

test("削除後に再編集された取引は生存する（tombstoneより新しいupdatedAt）", () => {
  const local = { version: 2, trades: [], deletedIds: { a: 100 } };
  const remote = { version: 2, trades: [T("a", 200)], deletedIds: {} };
  const m = mergeMasters(local, remote);
  assert.equal(m.trades.length, 1);
  assert.equal(m.trades[0].id, "a");
  assert.equal(m.deletedIds.a, undefined); // 不要な tombstone は掃除される
});

test("tombstone は双方の和集合で新しい時刻を採用", () => {
  const local = { version: 2, trades: [], deletedIds: { a: 100, b: 500 } };
  const remote = { version: 2, trades: [], deletedIds: { a: 300, c: 50 } };
  const m = mergeMasters(local, remote);
  assert.equal(m.deletedIds.a, 300); // 新しい方
  assert.equal(m.deletedIds.b, 500);
  assert.equal(m.deletedIds.c, 50);
});

test("version1（updatedAt/deletedIds欠損）でも安全にマージできる", () => {
  const local = { version: 1, trades: [{ id: "a", date: "2026-01-01", code: "7203", side: "買", quantity: 100, price: 1000 }] };
  const remote = { version: 1, trades: [{ id: "b", date: "2026-01-02", code: "6758", side: "買", quantity: 100, price: 2000 }] };
  const m = mergeMasters(local, remote);
  assert.equal(m.version, 2);
  assert.deepEqual(m.trades.map((t) => t.id).sort(), ["a", "b"]);
});
