// indicators.js の純粋関数（lookupSnapshot / bucketOf）の単体テスト（Node標準 node:test）
//   実行: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { lookupSnapshot, bucketOf } from "../js/indicators.js";

const rows = [
  { d: "2026-01-05", dev: -0.02, abv: true, vol: 1.1, rsi: 55.0, hv: 0.18 },
  { d: "2026-01-06", dev: -0.05, abv: true, vol: 1.8, rsi: 42.0, hv: 0.31 },
  { d: "2026-01-09", dev: -0.08, abv: false, vol: 2.4, rsi: 22.0, hv: 0.52 },
];

test("lookupSnapshot: 完全一致の日付を引く（rsi/hvも含む）", () => {
  const s = lookupSnapshot(rows, "2026-01-06");
  assert.equal(s.date, "2026-01-06");
  assert.equal(s.dev, -0.05);
  assert.equal(s.abv, true);
  assert.equal(s.vol, 1.8);
  assert.equal(s.rsi, 42.0);
  assert.equal(s.hv, 0.31);
});

test("lookupSnapshot: 休場日は直近の営業日(<=date)へフォールバック", () => {
  // 1/7,1/8 はデータ無し → 1/6 を返す
  assert.equal(lookupSnapshot(rows, "2026-01-08").date, "2026-01-06");
  // 期間の末尾より後は最後の行
  assert.equal(lookupSnapshot(rows, "2026-02-01").date, "2026-01-09");
});

test("lookupSnapshot: 期間より前 / 空配列は null", () => {
  assert.equal(lookupSnapshot(rows, "2026-01-01"), null);
  assert.equal(lookupSnapshot([], "2026-01-06"), null);
  assert.equal(lookupSnapshot(undefined, "2026-01-06"), null);
});

test("bucketOf(dip): 凹みの深さのバケット境界", () => {
  assert.equal(bucketOf("dip", { dev: 0.01 }), "浅い/順張り（>-3%）");
  assert.equal(bucketOf("dip", { dev: -0.03 }), "中くらい（-3〜-7%）"); // 境界は中側
  assert.equal(bucketOf("dip", { dev: -0.05 }), "中くらい（-3〜-7%）");
  assert.equal(bucketOf("dip", { dev: -0.07 }), "深い押し（≤-7%）");
  assert.equal(bucketOf("dip", { dev: -0.12 }), "深い押し（≤-7%）");
});

test("bucketOf(vol/trend): 出来高急増・トレンド位置", () => {
  assert.equal(bucketOf("vol", { vol: 1.5 }), "出来高急増（≥1.5倍）");
  assert.equal(bucketOf("vol", { vol: 1.49 }), "通常出来高（<1.5倍）");
  assert.equal(bucketOf("trend", { abv: true }), "上昇トレンド（75日線上）");
  assert.equal(bucketOf("trend", { abv: false }), "下降局面（75日線下）");
});

test("bucketOf(rsi): 売られすぎ度のバケット境界", () => {
  assert.equal(bucketOf("rsi", { rsi: 30 }), "売られすぎ（≤30）");
  assert.equal(bucketOf("rsi", { rsi: 30.1 }), "中立（30〜50）");
  assert.equal(bucketOf("rsi", { rsi: 50 }), "中立（30〜50）");
  assert.equal(bucketOf("rsi", { rsi: 50.1 }), "強め（>50）");
  assert.equal(bucketOf("rsi", { rsi: null }), null); // 欠損は除外扱い
});

test("bucketOf(hv): ボラティリティのバケット境界", () => {
  assert.equal(bucketOf("hv", { hv: 0.19 }), "低ボラ（<20%）");
  assert.equal(bucketOf("hv", { hv: 0.2 }), "中ボラ（20〜40%）");
  assert.equal(bucketOf("hv", { hv: 0.39 }), "中ボラ（20〜40%）");
  assert.equal(bucketOf("hv", { hv: 0.4 }), "高ボラ（≥40%）");
  assert.equal(bucketOf("hv", { hv: null }), null);
});

test("bucketOf: snap が null / 未知軸は null", () => {
  assert.equal(bucketOf("dip", null), null);
  assert.equal(bucketOf("nope", { dev: -0.05 }), null);
});

import { isEntryDataReady } from "../js/indicators.js";

test("isEntryDataReady: 当日日中(最新=前日)は未確定、翌日(最新=約定日)で確定", () => {
  // 当日(6/05)に取引、データ最新は前日(6/04)→まだ凍結しない
  assert.equal(isEntryDataReady("2026-06-04", "2026-06-05"), false);
  // 翌日に最新が約定日へ到達→凍結OK
  assert.equal(isEntryDataReady("2026-06-05", "2026-06-05"), true);
  // さらに後日も当然OK
  assert.equal(isEntryDataReady("2026-06-08", "2026-06-05"), true);
  // データ未取得は未確定
  assert.equal(isEntryDataReady(null, "2026-06-05"), false);
});
