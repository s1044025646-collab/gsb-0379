import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyMove,
  importState,
  initialState,
  legalPits,
  oppositeIndex,
  parsePitLabel,
  STORE_A,
  STORE_B,
  totalStones,
  GameError,
  type BoardState,
} from "../src/engine.js";

const TOTAL = 48;

test("固定编号解析与对面下标 12-i", () => {
  assert.equal(parsePitLabel("A1"), 0);
  assert.equal(parsePitLabel("A6"), 5);
  assert.equal(parsePitLabel("B1"), 7);
  assert.equal(parsePitLabel("B6"), 12);
  assert.equal(parsePitLabel("A仓"), null);
  assert.equal(oppositeIndex(2), 10); // A3 <-> B4
  assert.equal(oppositeIndex(0), 12); // A1 <-> B6
});

test("默认开局 A 选 A3：路径、最后落 A仓、额外回合、逐颗路径核对", () => {
  const s0 = initialState();
  const { state, detail } = applyMove(s0, "A", 2);
  assert.deepEqual(detail.drops.map((d) => d.index), [3, 4, 5, STORE_A]);
  assert.equal(detail.lastIndex, STORE_A);
  assert.equal(detail.extraTurn, true);
  assert.equal(state.turn, "A");
  assert.equal(detail.pickedUp, 4);
  assert.equal(state.gameOver, false);
  // 盘面核对
  assert.deepEqual(state.pits, [4, 4, 0, 5, 5, 5, 1, 4, 4, 4, 4, 4, 4, 0]);
  assert.equal(totalStones(state.pits), TOTAL);
});

test("对面取子：A2 -> 空的 A3，对面 B4 有子", () => {
  //           A1 A2 A3 A4 A5 A6 A仓 B1 B2 B3 B4 B5 B6 B仓
  const pits = [0, 1, 0, 1, 1, 1, 0, 1, 1, 1, 9, 1, 1, 0];
  const s0 = importState(pits, "A");
  const { state, detail } = applyMove(s0, "A", 1);
  assert.equal(detail.lastIndex, 2);
  assert.ok(detail.capture);
  assert.equal(detail.capture!.oppositeIndex, 10);
  assert.equal(detail.capture!.stones, 10);
  assert.equal(state.pits[2], 0);
  assert.equal(state.pits[10], 0);
  assert.equal(state.pits[STORE_A], 10);
  assert.equal(totalStones(state.pits), totalStones(pits));
});

test("对面为空时不取子（即使最后落在自己的空坑）", () => {
  //           A1 A2 A3 A4 A5 A6 A仓 B1 B2 B3 B4 B5 B6 B仓
  const pits = [0, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 0];
  const s0 = importState(pits, "A");
  const { state, detail } = applyMove(s0, "A", 1);
  assert.equal(detail.capture, null);
  assert.equal(state.pits[2], 1); // 最后一颗留在 A3
  assert.equal(state.pits[STORE_A], 0);
  assert.equal(state.turn, "B");
  assert.equal(totalStones(state.pits), totalStones(pits));
});

test("最后落在自己非空坑不取子、换手", () => {
  //           A1 A2 A3 A4 A5 A6 A仓 B1 B2 B3 B4 B5 B6 B仓
  const pits = [0, 2, 5, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 0];
  const s0 = importState(pits, "A");
  const { state, detail } = applyMove(s0, "A", 1);
  assert.equal(detail.capture, null);
  assert.equal(detail.lastIndex, 3);
  assert.equal(state.turn, "B");
});

test("多圈播撒跳过对手仓：14 颗，B仓在普通播撒中不增，A仓+1", () => {
  //           A1 A2 A3 A4 A5 A6 A仓 B1 B2 B3 B4 B5 B6 B仓
  const pits = [14, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 0];
  const s0 = importState(pits, "A");
  const before = pits.slice();
  const { state, detail } = applyMove(s0, "A", 0);
  // 路径：1..5(5颗), A仓(1), B1..B6(6颗), 跳过 B仓, A1..A2(2颗) = 14
  assert.deepEqual(
    detail.drops.map((d) => d.index),
    [1, 2, 3, 4, 5, STORE_A, 7, 8, 9, 10, 11, 12, 0, 1]
  );
  assert.equal(detail.skipped.length, 1);
  assert.equal(state.pits[STORE_B], before[STORE_B]); // 对手仓不增
  assert.equal(state.pits[STORE_A], before[STORE_A] + 1);
  assert.equal(totalStones(state.pits), totalStones(pits));
});

test("B 方播撒跳过 A仓，编号不随玩家翻转", () => {
  // B1 放 8 颗：B2..B6(5), B仓(1), 跳过 A仓, A1..A2(2)
  //           A1 A2 A3 A4 A5 A6 A仓 B1 B2 B3 B4 B5 B6 B仓
  const pits = [1, 1, 1, 1, 1, 1, 0, 8, 1, 1, 1, 1, 1, 0];
  const s0 = importState(pits, "B");
  const { state, detail } = applyMove(s0, "B", 7);
  assert.deepEqual(
    detail.drops.map((d) => d.index),
    [8, 9, 10, 11, 12, STORE_B, 0, 1]
  );
  assert.equal(state.pits[STORE_A], 0);
  assert.equal(totalStones(state.pits), totalStones(pits));
});

test("终局归仓：一方普通坑全空，另一方剩余子归其仓，终局优先于额外回合", () => {
  //           A6=1：仅 1 颗直接入 A仓，随后 A 方普通坑全空；B 方共 12 子。
  const pits = [0, 0, 0, 0, 0, 1, 0, 2, 2, 2, 2, 2, 2, 0];
  const s0 = importState(pits, "A");
  const { state, detail } = applyMove(s0, "A", 5);
  assert.equal(state.gameOver, true);
  assert.equal(detail.extraTurn, false); // 终局优先
  assert.ok(detail.endSweep);
  assert.equal(detail.endSweep!.player, "B");
  assert.equal(detail.endSweep!.total, 12);
  for (const i of [7, 8, 9, 10, 11, 12]) assert.equal(state.pits[i], 0);
  assert.equal(state.pits[STORE_B], 12);
  assert.equal(state.pits[STORE_A], 1);
  assert.equal(state.winner, "B");
  assert.equal(totalStones(state.pits), totalStones(pits));
});

test("平局判定", () => {
  // A6=1 入 A仓；B 方普通坑共 1 子终局归 B仓，双方仓各 1
  //           A1 A2 A3 A4 A5 A6 A仓 B1 ... B6 B仓
  const pits = [0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0];
  const s0 = importState(pits, "A");
  const { state } = applyMove(s0, "A", 5);
  assert.equal(state.gameOver, true);
  assert.equal(state.winner, "DRAW");
  assert.equal(state.pits[STORE_A], 1);
  assert.equal(state.pits[STORE_B], 1);
});

test("错误玩家、空坑、得分仓、越界均被拒绝且盘面不变", () => {
  const s0 = initialState();
  const before = s0.pits.slice();
  assert.throws(() => applyMove(s0, "B", 2), (e: Error) => (e as GameError).code === "NOT_YOUR_TURN");
  const empty: BoardState = { ...s0, pits: s0.pits.slice() };
  empty.pits[2] = 0;
  assert.throws(() => applyMove(empty, "A", 2), (e: Error) => (e as GameError).code === "EMPTY_PIT");
  assert.throws(() => applyMove(s0, "A", STORE_A), (e: Error) => (e as GameError).code === "INVALID_PIT");
  assert.throws(() => applyMove(s0, "A", 13), (e: Error) => (e as GameError).code === "INVALID_PIT");
  assert.throws(() => applyMove(s0, "A", 9), (e: Error) => (e as GameError).code === "INVALID_PIT"); // B 坑
  assert.deepEqual(s0.pits, before);
});

test("已结束对局拒绝落子", () => {
  const pits = [0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0];
  const s0 = importState(pits, "A");
  const { state } = applyMove(s0, "A", 5);
  assert.throws(() => applyMove(state, "B", 7), (e: Error) => (e as GameError).code === "GAME_OVER");
});

test("非法导入拒绝", () => {
  assert.throws(() => importState([], "A"), (e: Error) => (e as GameError).code === "INVALID_IMPORT");
  assert.throws(() => importState(new Array(14).fill(-1), "A"));
  assert.throws(() => importState(new Array(14).fill(0), "A"));
  assert.throws(() => importState(new Array(14).fill(1), "C"));
});

test("合法坑只列出己方有子的普通坑", () => {
  const s0 = initialState();
  assert.deepEqual(legalPits(s0), [0, 1, 2, 3, 4, 5]);
});


