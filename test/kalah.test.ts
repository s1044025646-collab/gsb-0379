import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyMove,
  initialState,
  legalPits,
  nextState,
  validateImportedBoard,
  totalSeeds,
  RuleError,
  STORE_A,
  STORE_B,
  type GameState,
} from "../src/rules.js";
import { KalahStore, StoreError } from "../src/store.js";

function stateFrom(board: number[], currentPlayer: "A" | "B" = "A"): GameState {
  return { board: [...board], currentPlayer, gameOver: false, winner: null };
}

// 下标参考：0..5=A1..A6，6=A仓，7..12=B1..B6，13=B仓

test("默认开局 A 落 A3：最后一颗入自己仓并获得额外回合", () => {
  const s = initialState();
  const r = applyMove(s, "A", 2); // A3
  assert.equal(r.pickedUp, 4);
  assert.deepEqual(r.path, [3, 4, 5, STORE_A]);
  assert.equal(r.lastPosition, STORE_A);
  assert.equal(r.extraTurn, true);
  assert.equal(r.capture, null);
  assert.equal(r.nextPlayer, "A");
  assert.equal(r.boardAfter[STORE_A], 1);
  assert.equal(totalSeeds(r.boardAfter), 48);
});

test("对面取子：最后一颗落自己空坑且对面有子", () => {
  // A1=1，B5(下标11)=3；A 落 A1 → 落 A2(空)，对面 B5 有子（总子数 48）
  const board = [1, 0, 0, 0, 0, 0, 10, 3, 3, 3, 3, 3, 2, 20];
  const r = applyMove(stateFrom(board), "A", 0);
  assert.equal(r.lastPosition, 1);
  assert.ok(r.capture);
  assert.equal(r.capture!.oppositePit, 11);
  assert.equal(r.capture!.oppositeLabel, "B5");
  assert.equal(r.capture!.capturedFromOpposite, 3);
  assert.equal(r.capture!.totalToStore, 4);
  assert.equal(r.boardAfter[STORE_A], 14);
  assert.equal(r.boardAfter[1], 0);
  assert.equal(r.boardAfter[11], 0);
  assert.equal(totalSeeds(r.boardAfter), 48);
});

test("对面为空不触发取子", () => {
  // A1=1 落入空坑 A2，但对面 B5=0；双方其余坑非空，不触发终局
  const board = [1, 0, 0, 0, 0, 5, 10, 2, 0, 0, 0, 0, 0, 20];
  const r = applyMove(stateFrom(board), "A", 0);
  assert.equal(r.lastPosition, 1);
  assert.equal(r.capture, null);
  assert.equal(r.boardAfter[1], 1);
  assert.equal(r.gameOver, false);
});

test("多圈播撒跳过对手得分仓", () => {
  // A6(下标5) 放 25 颗，验证绕圈且永不落入 B仓(13)
  const board = [0, 0, 0, 0, 0, 25, 0, 1, 1, 1, 1, 1, 1, 0];
  const r = applyMove(stateFrom(board), "A", 5);
  assert.equal(r.pickedUp, 25);
  assert.equal(r.path.length, 25);
  assert.ok(!r.path.includes(STORE_B), "路径不得包含 B仓");
  // 25 颗 = 将近两圈，路径必须经过 A仓两次
  assert.equal(r.path.filter((p) => p === STORE_A).length, 2);
  assert.equal(totalSeeds(r.boardAfter), 31);
});

test("终局归仓：一方坑空即结束，另一方剩余归入其仓", () => {
  // A6=2：一颗入 A仓、一颗入 B1；A 方坑全空 → 终局，B 剩余归 B仓
  const board = [0, 0, 0, 0, 0, 2, 10, 2, 3, 0, 0, 0, 0, 20];
  const r = applyMove(stateFrom(board), "A", 5);
  assert.equal(r.capture, null);
  assert.equal(r.gameOver, true);
  assert.ok(r.endgame);
  assert.equal(r.endgame!.emptiedSide, "A");
  assert.equal(r.endgame!.collectedTotal, 6);
  assert.equal(r.boardAfter[STORE_B], 26);
  assert.equal(r.boardAfter.slice(7, 13).every((v) => v === 0), true);
  assert.equal(r.winner, "B");
  assert.equal(totalSeeds(r.boardAfter), 37);
});

test("终局优先于额外回合", () => {
  // A6=1，落入自己仓本应额外回合，但 A 方坑已全空 → 直接终局
  const board = [0, 0, 0, 0, 0, 1, 10, 0, 0, 0, 0, 0, 2, 20];
  const r = applyMove(stateFrom(board), "A", 5);
  assert.equal(r.lastPosition, STORE_A);
  assert.equal(r.extraTurn, false);
  assert.equal(r.gameOver, true);
  assert.equal(r.boardAfter[STORE_B], 22);
});

test("平局判定", () => {
  // A6=1 入 A仓（A 方坑空，终局优先于额外回合），B6=1 归 B仓后 24:24
  const board = [0, 0, 0, 0, 0, 1, 23, 0, 0, 0, 0, 0, 1, 23];
  const r = applyMove(stateFrom(board), "A", 5);
  assert.equal(r.gameOver, true);
  assert.equal(r.boardAfter[STORE_A], 24);
  assert.equal(r.boardAfter[STORE_B], 24);
  assert.equal(r.winner, "draw");
});

test("错误玩家 / 空坑 / 得分仓 / 对方坑：拒绝且盘面不变", () => {
  const s = initialState();
  const before = JSON.stringify(s);
  assert.throws(() => applyMove(s, "B", 0), (e: unknown) => (e as RuleError).code === "WRONG_PLAYER");
  assert.throws(() => applyMove(s, "A", STORE_A), (e: unknown) => (e as RuleError).code === "STORE_PIT");
  assert.throws(() => applyMove(s, "A", 7), (e: unknown) => (e as RuleError).code === "NOT_OWN_PIT");
  const emptyBoard = stateFrom([0, 4, 4, 4, 4, 4, 0, 4, 4, 4, 4, 4, 4, 0]);
  assert.throws(() => applyMove(emptyBoard, "A", 0), (e: unknown) => (e as RuleError).code === "EMPTY_PIT");
  assert.equal(JSON.stringify(s), before);
  assert.throws(() => applyMove(s, "X" as never, 0), (e: unknown) => (e as RuleError).code === "INVALID_PLAYER");
});

test("非法导入被拒绝", () => {
  assert.throws(() => validateImportedBoard([1, 2, 3]), /长度/);
  assert.throws(() => validateImportedBoard(new Array(14).fill(-1)), /非负整数/);
  assert.throws(() => validateImportedBoard(new Array(14).fill(0)), /没有任何棋子/);
  assert.throws(() => validateImportedBoard(new Array(14).fill(4)), /不能超过 48/);
  const terminal = [0, 0, 0, 0, 0, 0, 24, 1, 1, 1, 1, 1, 1, 18];
  assert.throws(() => validateImportedBoard(terminal), /终局/);
});

test("合法教学盘面可导入", () => {
  const board = [1, 0, 0, 0, 0, 0, 10, 2, 3, 0, 0, 0, 0, 20];
  assert.deepEqual(validateImportedBoard(board), board);
});

test("store：落子、版本冲突、幂等、撤销、回放、导出", () => {
  const store = new KalahStore(":memory:");
  const g = store.createGame();

  // 版本冲突
  assert.throws(
    () => store.playMove(g.id, "A", 2, 5, "r-x"),
    (e: unknown) => (e as StoreError).code === "VERSION_CONFLICT",
  );

  const m1 = store.playMove(g.id, "A", 2, 0, "r-1");
  assert.equal(m1.move.seq, 1);
  assert.equal(m1.game.version, 1);

  // 重复 requestId：不重复播子
  const dup = store.playMove(g.id, "A", 2, 0, "r-1");
  assert.equal(dup.idempotentReplay, true);
  assert.equal(dup.move.seq, 1);
  assert.equal(dup.game.version, 1);
  assert.deepEqual(store.getGame(g.id).state.board, m1.game.state.board);

  // 额外回合：仍由 A 行动
  assert.equal(m1.game.state.currentPlayer, "A");
  const m2 = store.playMove(g.id, "A", 5, 1, "r-2");
  assert.equal(m2.game.state.currentPlayer, "B");

  // 回放
  const r0 = store.replay(g.id, 0);
  assert.deepEqual(r0.state.board, g.initialBoard);
  const r1 = store.replay(g.id, 1);
  assert.deepEqual(r1.state.board, m1.move.stateAfter.board);

  // 撤销末步：逐项还原
  const { game: afterUndo } = store.undo(g.id);
  assert.deepEqual(afterUndo.state, m1.move.stateAfter);
  assert.equal(afterUndo.state.gameOver, false);

  // 导出
  const exp = store.exportGame(g.id) as { moves: unknown[]; rulesVersion: string };
  assert.equal(exp.moves.length, 1);
  store.close();
});

test("store：撤销终局完整还原（含终局标志与归仓）", () => {
  const store = new KalahStore(":memory:");
  const board = [0, 0, 0, 0, 0, 2, 10, 2, 3, 0, 0, 0, 0, 20];
  const g = store.createGame(board);
  const before = g.state;
  const m = store.playMove(g.id, "A", 5, 0, "t-1");
  assert.equal(m.game.state.gameOver, true);
  assert.equal(m.game.state.board[STORE_B], 26);
  // 结束后拒绝落子
  assert.throws(
    () => store.playMove(g.id, "B", 7, 1, "t-2"),
    (e: unknown) => (e as StoreError).code === "GAME_OVER",
  );
  const { game: restored } = store.undo(g.id);
  assert.deepEqual(restored.state, before);
  assert.equal(restored.state.gameOver, false);
  assert.equal(restored.state.currentPlayer, "A");
  store.close();
});

test("逐颗路径核对 + 每步守恒 + 两仓单调不减 + 撤销逐项还原（长对局）", () => {
  const store = new KalahStore(":memory:");
  const g = store.createGame();
  let version = g.version;
  let prevBoard = [...g.initialBoard];
  const snapshots: GameState[] = [];

  for (let step = 0; step < 40; step++) {
    const cur = store.getGame(g.id);
    snapshots.push(cur.state);
    if (cur.state.gameOver) break;
    const legal = legalPits(cur.state);
    if (legal.length === 0) break;
    const pit = legal[step % legal.length];
    const player = cur.state.currentPlayer;
    const { move, game: after } = store.playMove(g.id, player, pit, version, `auto-${step}`);
    version++;
    const r = move.report;
    // 逐颗路径：长度等于拿起数量，且不含对手仓
    assert.equal(r.path.length, r.pickedUp);
    const oppStore = player === "A" ? STORE_B : STORE_A;
    assert.ok(!r.path.includes(oppStore));
    // 守恒
    assert.equal(totalSeeds(r.boardAfter), 48);
    // 两仓单调不减
    assert.ok(r.boardAfter[STORE_A] >= prevBoard[STORE_A]);
    assert.ok(r.boardAfter[STORE_B] >= prevBoard[STORE_B]);
    // 下一步行动方与报告一致
    if (!r.gameOver) assert.equal(after.state.currentPlayer, r.nextPlayer);
    prevBoard = r.boardAfter;
  }

  // 逐步撤销并逐项比对快照
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const cur = store.getGame(g.id);
    if (store.listMoves(g.id).length === 0) break;
    store.undo(g.id);
    const restored = store.getGame(g.id).state;
    assert.deepEqual(restored, snapshots[i]);
    void cur;
  }
  assert.deepEqual(store.getGame(g.id).state.board, g.initialBoard);
  store.close();
});

test("nextState 与 legalPits 基本行为", () => {
  const s = initialState();
  assert.deepEqual(legalPits(s), [0, 1, 2, 3, 4, 5]);
  const r = applyMove(s, "A", 2);
  const s2 = nextState(s, r);
  assert.equal(s2.currentPlayer, "A");
  assert.equal(s2.board[2], 0);
});
