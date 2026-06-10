// buylevels.js の純粋関数（levelState / fmtDist / buildBoard）の単体テスト（Node標準 node:test）
//   実行: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { levelState, fmtDist, buildBoard } from "../js/buylevels.js";

const payload = {
  updated: "2026-06-10",
  near_threshold: 0.03,
  stocks: [
    {
      code: "6855",
      close: 6950.0,
      rebound: false,
      levels: [
        { id: "L1", label: "25日線", price: 7430.0, dist: 0.0691, hit: true },
        { id: "L4", label: "20日高値-10%", price: 6800.0, dist: -0.0216, hit: false },
        { id: "L6", label: "60日安値", price: 6000.0, dist: -0.1367, hit: false },
      ],
    },
    {
      code: "7203",
      close: 3000.0,
      rebound: true,
      levels: [
        { id: "L1", label: "25日線", price: 2900.0, dist: -0.0333, hit: false },
        { id: "L6", label: "60日安値", price: 2500.0, dist: -0.1667, hit: false },
      ],
    },
  ],
};

test("levelState: 到達 / 接近(3%以内) / 通常を判定する", () => {
  assert.equal(levelState({ hit: true, dist: 0.05 }, 0.03), "hit");
  assert.equal(levelState({ hit: false, dist: -0.0216 }, 0.03), "near");
  assert.equal(levelState({ hit: false, dist: -0.0301 }, 0.03), "far");
  // 閾値ちょうどは「接近」
  assert.equal(levelState({ hit: false, dist: -0.03 }, 0.03), "near");
});

test("fmtDist: 到達は「到達」、未到達は「あと◯%」", () => {
  assert.equal(fmtDist({ hit: true, dist: 0.0691 }), "到達");
  assert.equal(fmtDist({ hit: false, dist: -0.0216 }), "あと2.2%");
});

test("buildBoard: 到達数が多い銘柄 → 近い銘柄の順に並ぶ", () => {
  const board = buildBoard(payload);
  assert.equal(board.updated, "2026-06-10");
  // 6855 は到達1本あり → 先頭。7203 は到達なし
  assert.deepEqual(
    board.rows.map((r) => r.code),
    ["6855", "7203"]
  );
  assert.equal(board.rows[0].hitCount, 1);
  // 6855 の最接近は L4 の 2.16%
  assert.ok(Math.abs(board.rows[0].nearest - 0.0216) < 1e-9);
  // セルの状態が引き継がれている
  const l4 = board.rows[0].cells.find((c) => c.id === "L4");
  assert.equal(l4.state, "near");
  assert.equal(l4.distText, "あと2.2%");
});

test("buildBoard: 不正payloadは null を返す（カード非表示の劣化動作）", () => {
  assert.equal(buildBoard(null), null);
  assert.equal(buildBoard({}), null);
});
