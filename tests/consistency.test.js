// accountMixWarnings の単体テスト（口座をまたいだ同一銘柄の同時保有検出）
//   実行: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { accountMixWarnings } from "../js/pnl.js";

test("口座混在: 特定とNISAで同一銘柄を同時保有すると警告する", () => {
  const trades = [
    { date: "2026-05-07", code: "6590", side: "買", quantity: 100, price: 4950, account: "NISA" },
    { date: "2026-05-10", code: "6590", side: "買", quantity: 100, price: 4800, account: "特定" },
  ];
  const w = accountMixWarnings(trades);
  assert.equal(w.length, 1);
  assert.match(w[0], /6590/);
  assert.match(w[0], /NISA/);
  assert.match(w[0], /特定/);
});

test("口座混在なし: NISA建玉を決済してから特定で新規なら警告しない", () => {
  const trades = [
    { date: "2026-05-07", code: "6590", side: "買", quantity: 100, price: 4950, account: "NISA" },
    { date: "2026-05-25", code: "6590", side: "売", quantity: 100, price: 5450, account: "NISA" },
    { date: "2026-05-27", code: "6590", side: "買", quantity: 100, price: 4800, account: "特定" },
    { date: "2026-05-28", code: "6590", side: "売", quantity: 100, price: 5000, account: "特定" },
  ];
  assert.deepEqual(accountMixWarnings(trades), []);
});

test("同一口座で複数銘柄は警告しない（口座またぎのみ対象）", () => {
  const trades = [
    { date: "2026-06-01", code: "6855", side: "買", quantity: 100, price: 7550, account: "特定" },
    { date: "2026-06-02", code: "6101", side: "買", quantity: 100, price: 6090, account: "特定" },
  ];
  assert.deepEqual(accountMixWarnings(trades), []);
});

test("同一銘柄の警告は重複保有が続いても1件だけ", () => {
  const trades = [
    { date: "2026-05-07", code: "6590", side: "買", quantity: 100, price: 4950, account: "NISA" },
    { date: "2026-05-10", code: "6590", side: "買", quantity: 100, price: 4800, account: "特定" },
    { date: "2026-05-12", code: "6590", side: "買", quantity: 100, price: 4700, account: "特定" },
  ];
  assert.equal(accountMixWarnings(trades).length, 1);
});
