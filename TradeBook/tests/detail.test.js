// 銘柄詳細モーダル（TBK 詳細モーダル）の純粋関数テスト
import test from "node:test";
import assert from "node:assert/strict";

import { buildChartModel, buildDetailSections } from "../js/detail.js";

function rows(closes, startDay = 1) {
  return closes.map((c, i) => ({ d: `2026-07-${String(startDay + i).padStart(2, "0")}`, c }));
}

test("buildChartModel: 終値系列とラベルを直近 lastN に絞る", () => {
  const m = buildChartModel(rows([100, 101, 102, 103, 104]), null, 3);
  assert.deepEqual(m.close, [102, 103, 104]);
  assert.deepEqual(m.labels, ["2026-07-03", "2026-07-04", "2026-07-05"]);
  assert.equal(m.hasData, true);
});

test("buildChartModel: 表示価格域内の S/R 横線だけ残す", () => {
  // 終値 90〜110。域内: 95(支持)/105(抵抗)。域外: 10(支持)/1000(抵抗)は除外
  const sr = { support: [95, 10], resistance: [105, 1000] };
  const m = buildChartModel(rows([90, 100, 110]), sr, 10);
  const vals = m.srLines.map((l) => l.value).sort((a, b) => a - b);
  assert.deepEqual(vals, [95, 105]);
  assert.equal(m.srLines.find((l) => l.value === 95).kind, "support");
  assert.equal(m.srLines.find((l) => l.value === 105).kind, "resistance");
});

test("buildChartModel: 不正・空入力はクラッシュせず hasData=false", () => {
  assert.equal(buildChartModel(null, null).hasData, false);
  assert.equal(buildChartModel([], { support: [1] }).hasData, false);
  // 数値でない c は除外される
  const m = buildChartModel([{ d: "2026-07-01", c: "x" }, { d: "2026-07-02", c: 100 }], null);
  assert.deepEqual(m.close, [100]);
});

test("buildDetailSections: S/R にタッチ回数（並行配列）を対応付ける（TBK-0015）", () => {
  const s = buildDetailSections({
    code: "7203",
    currentPrice: 3000,
    sr: {
      support: [2900, 2750],
      resistance: [3100],
      support_touches: [3, 1],
      resistance_touches: [2],
    },
  });
  assert.deepEqual(s.sr.support, [
    { price: 2900, touches: 3 },
    { price: 2750, touches: 1 },
  ]);
  assert.deepEqual(s.sr.resistance, [{ price: 3100, touches: 2 }]);
});

test("buildDetailSections: touches 未配信（旧契約データ）は 0 扱いで完走", () => {
  const s = buildDetailSections({ code: "1", currentPrice: null, sr: { support: [100], resistance: [] } });
  assert.deepEqual(s.sr.support, [{ price: 100, touches: 0 }]);
});

test("buildDetailSections: 買いレベルを整形して渡す", () => {
  const s = buildDetailSections({
    code: "1",
    buyStock: { levels: [{ id: "L1", label: "25日線", price: 2784, dist: 0.08, hit: true }] },
  });
  assert.equal(s.buyLevels.length, 1);
  assert.deepEqual(s.buyLevels[0], { id: "L1", label: "25日線", price: 2784, dist: 0.08, hit: true });
});

test("buildDetailSections: 利確目標は σ とパラメータから幅を出し、保有時のみ目標価格", () => {
  const volParams = { k: 2.0, floor: 0.05, cap: 0.15 };
  // 非保有: width のみ（target は null）
  const noHold = buildDetailSections({ code: "1", currentPrice: 1000, sigma: 0.03, volParams });
  assert.ok(Math.abs(noHold.sellTarget.width - 0.06) < 1e-12); // 2.0×0.03=0.06
  assert.equal(noHold.sellTarget.target, null);
  // 保有: 取得単価から目標価格
  const held = buildDetailSections({
    code: "1", currentPrice: 1000, sigma: 0.03, volParams,
    holding: { quantity: 100, avg: 1000, price: 1000, unrealized: 0, unrealizedRate: 0, priced: true },
  });
  assert.ok(Math.abs(held.sellTarget.target.targetPrice - 1060) < 1e-9);
  assert.equal(held.sellTarget.target.basis, "sigma");
});

test("buildDetailSections: σ目標より手前の抵抗線があれば利確目標に採用（TBK-0016）", () => {
  const volParams = { k: 2.0, floor: 0.05, cap: 0.15 };
  const s = buildDetailSections({
    code: "1", currentPrice: 1000, sigma: 0.03, volParams,
    sr: { support: [], resistance: [1040, 1200], resistance_touches: [2, 1] },
    holding: { quantity: 100, avg: 1000, price: 1000, unrealized: 0, unrealizedRate: 0, priced: true },
  });
  // σ目標 1060 より抵抗線 1040 が手前 → 目標 1040・basis=resistance
  assert.ok(Math.abs(s.sellTarget.target.targetPrice - 1040) < 1e-9);
  assert.equal(s.sellTarget.target.basis, "resistance");
});

test("buildDetailSections: σ が無ければ利確目標セクションは null", () => {
  const s = buildDetailSections({ code: "1", currentPrice: 1000, sigma: null, volParams: { k: 2, floor: 0.05, cap: 0.15 } });
  assert.equal(s.sellTarget, null);
});

test("buildDetailSections: 含み損益は保有かつ数量>0のときだけ", () => {
  const held = buildDetailSections({
    code: "1",
    holding: { quantity: 100, avg: 900, price: 1000, unrealized: 10000, unrealizedRate: 0.111, priced: true },
  });
  assert.equal(held.holding.quantity, 100);
  assert.equal(held.holding.unrealized, 10000);
  // 数量0 → null
  const flat = buildDetailSections({ code: "1", holding: { quantity: 0, avg: 0 } });
  assert.equal(flat.holding, null);
  // 価格欠損 → unrealized は null（priced=false）
  const unpriced = buildDetailSections({
    code: "1", holding: { quantity: 50, avg: 900, priced: false, unrealized: null, unrealizedRate: null },
  });
  assert.equal(unpriced.holding.price, null);
  assert.equal(unpriced.holding.unrealized, null);
});

test("buildDetailSections: 客観指標スナップショットをそのまま整形", () => {
  const s = buildDetailSections({
    code: "1",
    snapshot: { d: "2026-07-17", dev: -0.03, abv: true, vol: 1.4, rsi: 42.1, hv: 0.24 },
  });
  assert.equal(s.indicators.asOf, "2026-07-17");
  assert.equal(s.indicators.dev, -0.03);
  assert.equal(s.indicators.abv, true);
});

test("buildDetailSections: 何も無くても各セクション null で完走（欠損銘柄）", () => {
  const s = buildDetailSections({ code: "9999" });
  assert.equal(s.sr, null);
  assert.equal(s.buyLevels, null);
  assert.equal(s.sellTarget, null);
  assert.equal(s.indicators, null);
  assert.equal(s.holding, null);
  assert.equal(s.code, "9999");
});
