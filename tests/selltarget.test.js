// selltarget.js の純粋関数（targetWidth / computeSellTarget / paramsFromPayload）の単体テスト。
//   実行: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clamp,
  targetWidth,
  computeSellTarget,
  paramsFromPayload,
} from "../js/selltarget.js";

const PARAMS = { k: 2.5, floor: 0.05, cap: 0.15 };

test("paramsFromPayload: JSONの値を採用し、欠損時は既定にフォールバック", () => {
  assert.deepEqual(paramsFromPayload({ k: 3, floor: 0.04, cap: 0.2 }), {
    k: 3,
    floor: 0.04,
    cap: 0.2,
  });
  assert.deepEqual(paramsFromPayload(null), { k: 2.5, floor: 0.05, cap: 0.15 });
});

test("clamp は下限・上限で頭打ちにする", () => {
  assert.equal(clamp(0.01, 0.05, 0.15), 0.05);
  assert.equal(clamp(0.2, 0.05, 0.15), 0.15);
  assert.equal(clamp(0.08, 0.05, 0.15), 0.08);
});

test("targetWidth: σに連動し floor/cap でクランプ", () => {
  // σ=2% → 2.5×0.02=0.05（ちょうど floor）
  assert.ok(Math.abs(targetWidth(0.02, PARAMS) - 0.05) < 1e-9);
  // 穏やか σ=1% → 0.025 だが floor 0.05 が効く
  assert.equal(targetWidth(0.01, PARAMS), 0.05);
  // 荒い σ=8% → 0.20 だが cap 0.15 が効く
  assert.equal(targetWidth(0.08, PARAMS), 0.15);
  // 中間 σ=4% → 0.10
  assert.ok(Math.abs(targetWidth(0.04, PARAMS) - 0.1) < 1e-9);
});

test("targetWidth: σが無効なら null（劣化動作）", () => {
  assert.equal(targetWidth(null, PARAMS), null);
  assert.equal(targetWidth(NaN, PARAMS), null);
  assert.equal(targetWidth(-0.01, PARAMS), null);
});

test("computeSellTarget: 目標価格・あと%・到達判定", () => {
  // 取得1000・σ4%(幅10%) → 目標1100
  const r = computeSellTarget(1000, 1050, 0.04, PARAMS);
  assert.ok(Math.abs(r.targetPrice - 1100) < 1e-6);
  assert.ok(Math.abs(r.width - 0.1) < 1e-9);
  // 現在1050 → あと 1100/1050-1 ≈ +4.76%
  assert.ok(Math.abs(r.dist - (1100 / 1050 - 1)) < 1e-9);
  assert.equal(r.hit, false);
});

test("computeSellTarget: 現在値が目標以上なら到達", () => {
  const r = computeSellTarget(1000, 1120, 0.04, PARAMS); // 目標1100
  assert.equal(r.hit, true);
  assert.ok(r.dist < 0); // 既に上抜け
});

test("computeSellTarget: σ欠損・取得単価不正は null", () => {
  assert.equal(computeSellTarget(1000, 1050, null, PARAMS), null);
  assert.equal(computeSellTarget(0, 1050, 0.04, PARAMS), null);
  assert.equal(computeSellTarget(-100, 1050, 0.04, PARAMS), null);
});

test("computeSellTarget: 価格欠損でも目標価格は出し、dist=null/hit=false", () => {
  const r = computeSellTarget(1000, null, 0.04, PARAMS);
  assert.ok(Math.abs(r.targetPrice - 1100) < 1e-6);
  assert.equal(r.dist, null);
  assert.equal(r.hit, false);
});
