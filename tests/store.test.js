// store.js の mergeMasters（Drive同期マージ）の単体テスト
//   実行: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeMasters, Store, SEED_ENTRY_TAGS, SEED_EXIT_TAGS } from "../js/store.js";

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
  assert.equal(m.version, 3);
  assert.deepEqual(m.trades.map((t) => t.id).sort(), ["a", "b"]);
});

test("version3: 旧データ正規化でタグseedが補われ、取引のタグ欄はnull既定", () => {
  // entryTags/exitTags 欠損のマスター → seed が補われる
  const m = mergeMasters({ version: 2, trades: [T("a", 100)], deletedIds: {} }, null);
  assert.deepEqual(m.entryTags, SEED_ENTRY_TAGS);
  assert.deepEqual(m.exitTags, SEED_EXIT_TAGS);
  assert.equal(m.trades[0].entryTag, null);
  assert.equal(m.trades[0].exitTag, null);
});

test("既存のタグ値は尊重され上書きされない", () => {
  const tagged = T("a", 100, { side: "買", entryTag: "25日線タッチ", entryNote: "メモ" });
  const m = mergeMasters({ version: 3, trades: [tagged], deletedIds: {}, entryTags: ["独自タグ"] }, null);
  assert.equal(m.trades[0].entryTag, "25日線タッチ");
  assert.equal(m.trades[0].entryNote, "メモ");
  assert.ok(m.entryTags.includes("独自タグ"));
});

test("マージ時、タグ候補は両端末の和集合で残る（消失しない）", () => {
  const local = { version: 3, trades: [], deletedIds: {}, entryTags: ["A", "B"], exitTags: ["X"] };
  const remote = { version: 3, trades: [], deletedIds: {}, entryTags: ["B", "C"], exitTags: ["Y"] };
  const m = mergeMasters(local, remote);
  assert.deepEqual(m.entryTags, ["A", "B", "C"]); // 順序保持・重複排除
  assert.deepEqual(m.exitTags, ["X", "Y"]);
});

test("Store.addEntryTag / addExitTag: 重複と空白は無視・trimされる", () => {
  const s = new Store();
  // 空配列は normalizeTagList が seed へフォールバックするため、明示の非空リストで検証する
  s.setMaster({ version: 3, trades: [], deletedIds: {}, entryTags: ["A"], exitTags: ["既存"] });
  assert.equal(s.addEntryTag("B"), true);
  assert.equal(s.addEntryTag("A"), false); // 既存は無視
  assert.equal(s.addEntryTag("  "), false); // 空白は無視
  assert.deepEqual(s.getMaster().entryTags, ["A", "B"]);
  assert.equal(s.addExitTag(" 利確 "), true); // trim される
  assert.deepEqual(s.getMaster().exitTags, ["既存", "利確"]);
});

test("Store.renameTag: 候補リストと既存取引のタグを同時に更新", () => {
  const s = new Store();
  s.setMaster({
    version: 3,
    trades: [
      { id: "b1", date: "2026-01-01", code: "7203", side: "買", quantity: 100, price: 1000, entryTag: "旧名" },
      { id: "b2", date: "2026-01-02", code: "6758", side: "買", quantity: 100, price: 2000, entryTag: "別" },
    ],
    deletedIds: {},
    entryTags: ["旧名", "別"],
    exitTags: ["既存"],
  });
  assert.equal(s.renameTag("entry", "旧名", " 新名 "), true); // trim される
  assert.deepEqual(s.getMaster().entryTags, ["新名", "別"]);
  assert.equal(s.getMaster().trades[0].entryTag, "新名"); // 取引も追従
  assert.ok(s.getMaster().trades[0].updatedAt > 0); // 同期に乗るよう更新
  assert.equal(s.getMaster().trades[1].entryTag, "別"); // 無関係は不変
});

test("Store.renameTag: 改名先が既存なら重複を作らず統合", () => {
  const s = new Store();
  s.setMaster({ version: 3, trades: [], deletedIds: {}, entryTags: ["A", "B"], exitTags: ["x"] });
  assert.equal(s.renameTag("entry", "A", "B"), true);
  assert.deepEqual(s.getMaster().entryTags, ["B"]); // 重複しない
});

test("Store.deleteTag: 候補から外すが既存取引のタグ値は残す（非破壊）", () => {
  const s = new Store();
  s.setMaster({
    version: 3,
    trades: [{ id: "s1", date: "2026-01-01", code: "7203", side: "売", quantity: 100, price: 1300, exitTag: "損切り" }],
    deletedIds: {},
    entryTags: ["a"],
    exitTags: ["損切り", "利確"],
  });
  assert.equal(s.deleteTag("exit", "損切り"), true);
  assert.deepEqual(s.getMaster().exitTags, ["利確"]); // 候補からは消える
  assert.equal(s.getMaster().trades[0].exitTag, "損切り"); // 取引の記録は残る
  assert.equal(s.deleteTag("exit", "無い"), false); // 無いものは false
});

// --- GLOB-0005: エントリー・スナップショットの凍結保存 ---
const SNAP = { dev: -0.0123, abv: false, vol: 1.42, rsi: 48.2, hv: 0.243, asOf: "2026-06-04" };

test("マージ: entrySnap を持つ新しい方(updatedAt大)が採用され凍結値が残る", () => {
  const local = { version: 2, trades: [T("a", 200, { entrySnap: SNAP })], deletedIds: {} };
  const remote = { version: 2, trades: [T("a", 100)], deletedIds: {} }; // 古い・凍結なし
  const m = mergeMasters(local, remote);
  assert.equal(m.trades.length, 1);
  assert.deepEqual(m.trades[0].entrySnap, SNAP);
});

test("マージ: 相手が古い凍結なしでも、こちらの凍結が消えない（透過）", () => {
  const local = { version: 2, trades: [T("a", 100)], deletedIds: {} };
  const remote = { version: 2, trades: [T("a", 300, { entrySnap: SNAP })], deletedIds: {} };
  const m = mergeMasters(local, remote);
  assert.deepEqual(m.trades[0].entrySnap, SNAP); // 新しい方(remote)が勝つ
});

test("setEntrySnap: 凍結を保存し updatedAt を更新する", () => {
  const s = new Store();
  const t = s.addTrade({ date: "2026-06-04", code: "6101", side: "買", quantity: 100, price: 6090 });
  const before = t.updatedAt;
  const ok = s.setEntrySnap(t.id, SNAP);
  assert.equal(ok, true);
  const saved = s.getMaster().trades[0];
  assert.deepEqual(saved.entrySnap, SNAP);
  assert.ok(saved.updatedAt >= before);
  assert.equal(s.setEntrySnap("無いid", SNAP), false);
});
