// indicators.js の取得・状態管理（loadIndicator / indicatorStatus / prefetch dedup）の
// 単体テスト。fetch をモックして検証する。   実行: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadIndicator,
  prefetchIndicators,
  indicatorStatus,
  getSnapshot,
} from "../js/indicators.js";

// url から code を取り出し、map にあれば 200+payload、無ければ 404 を返す簡易モック。
function mockFetch(map) {
  return async (url) => {
    const m = String(url).match(/indicators\/([^.]+)\.json/);
    const payload = m && map[m[1]];
    if (!payload) return { ok: false };
    return { ok: true, json: async () => payload };
  };
}

test("loadIndicator: 取得成功で status=ok・スナップショットを引ける", async () => {
  global.fetch = mockFetch({
    1111: { code: "1111", rows: [{ d: "2026-01-06", dev: -0.05, abv: true, vol: 1.8 }] },
  });
  assert.equal(indicatorStatus("1111"), "unknown"); // 取得前
  await loadIndicator("1111");
  assert.equal(indicatorStatus("1111"), "ok");
  assert.equal(getSnapshot("1111", "2026-01-06").vol, 1.8);
});

test("loadIndicator: 404（監視リスト外）は status=missing", async () => {
  global.fetch = mockFetch({}); // すべて404
  await loadIndicator("2222");
  assert.equal(indicatorStatus("2222"), "missing");
  assert.equal(getSnapshot("2222", "2026-01-06"), null);
});

test("prefetchIndicators: 同一コードは1回だけfetch（in-flight dedup）", async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ code: "3333", rows: [{ d: "2026-01-06", dev: 0, abv: false, vol: 1 }] }) };
  };
  await prefetchIndicators(["3333", "3333", "3333"]);
  assert.equal(calls, 1);
  assert.equal(indicatorStatus("3333"), "ok");
});
