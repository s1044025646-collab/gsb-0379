import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase } from "../src/db.js";
import { GameService, VersionConflict } from "../src/service.js";
import { totalStones } from "../src/engine.js";
import type { DatabaseSync } from "node:sqlite";

const dbFile = resolve("data", "test-service.db");
let db: DatabaseSync;
let service: GameService;

before(() => {
  rmSync(dbFile, { force: true });
  rmSync(`${dbFile}-wal`, { force: true });
  rmSync(`${dbFile}-shm`, { force: true });
  db = openDatabase(dbFile);
  service = new GameService(db);
});

after(() => db.close());

test("版本冲突：期望版本过期被拒绝", () => {
  const g = service.createGame().id;
  service.move(g, "A", "A3", 0, null);
  assert.throws(
    () => service.move(g, "A", "A3", 0, null),
    (e: Error) => e instanceof VersionConflict && e.code === "VERSION_CONFLICT"
  );
});

test("重复请求编号不重复播子", () => {
  const g = service.createGame().id;
  const first = service.move(g, "A", "A3", 0, "req-1");
  assert.equal(first.duplicated, false);
  const again = service.move(g, "A", "A3", 0, "req-1");
  assert.equal(again.duplicated, true);
  assert.equal(again.view.version, 1);
  assert.equal(totalStones(again.view.state.pits), 48);
  // 历史仍只有一条动作
  assert.equal(service.history(g).length, 1);
});

test("撤销末步完整还原（玩家/终局/坑仓/版本）", () => {
  const g = service.createGame().id;
  const initial = service.view(g).state;
  service.move(g, "A", "A3", 0, null);
  const restored = service.undo(g);
  assert.deepEqual(restored.state.pits, initial.pits);
  assert.equal(restored.state.turn, "A");
  assert.equal(restored.state.gameOver, false);
  assert.equal(restored.state.winner, null);
  assert.equal(restored.version, 0);
  assert.equal(service.history(g).length, 0);
});

test("撤销终局后恢复进行中状态且可继续落子", () => {
  //           A1 A2 A3 A4 A5 A6 A仓 B1 B2 B3 B4 B5 B6 B仓
  const g = service.createGame({ pits: [0, 0, 0, 0, 0, 1, 0, 2, 2, 2, 2, 2, 2, 0], turn: "A" }).id;
  service.move(g, "A", "A6", 0, null);
  assert.equal(service.view(g).state.gameOver, true);
  const restored = service.undo(g);
  assert.equal(restored.state.gameOver, false);
  assert.equal(restored.state.turn, "A");
  assert.equal(restored.state.pits[7], 2); // B1 子归还
});

test("多步撤销后玩家链正确还原", () => {
  const g = service.createGame().id;
  service.move(g, "A", "A6", 0, null); // 非额外回合（落 B1），换手 B
  assert.equal(service.view(g).state.turn, "B");
  const v1Pits = service.view(g).state.pits.slice();
  service.move(g, "B", "B1", 1, null);
  const restored = service.undo(g);
  assert.equal(restored.state.turn, "B");
  assert.deepEqual(restored.state.pits, v1Pits);
});

test("回放使用记录的初始盘面与动作，step 校验", () => {
  const g = service.createGame().id;
  service.move(g, "A", "A3", 0, null);
  service.move(g, "A", "A4", 1, null); // 额外回合后再走
  const r0 = service.replay(g, 0);
  assert.deepEqual(r0.state.pits, new Array(6).fill(4).concat([0]).concat(new Array(6).fill(4)).concat([0]));
  const r1 = service.replay(g, 1);
  assert.equal(r1.detail!.pitLabel, "A3");
  const r2 = service.replay(g, 2);
  assert.equal(totalStones(r2.state.pits), 48);
  assert.throws(() => service.replay(g, 3), (e: Error) => e.message.includes("步数"));
});

test("重启后继续对局（重新打开数据库）", () => {
  const g = service.createGame().id;
  service.move(g, "A", "A3", 0, "persist-1");
  db.close();
  const db2 = openDatabase(dbFile);
  const service2 = new GameService(db2);
  const view = service2.view(g);
  assert.equal(view.version, 1);
  assert.equal(view.state.turn, "A");
  // 相同请求编号在重启后仍幂等
  const dup = service2.move(g, "A", "A3", 0, "persist-1");
  assert.equal(dup.duplicated, true);
  db2.close();
  db = openDatabase(dbFile);
  service = new GameService(db);
});


