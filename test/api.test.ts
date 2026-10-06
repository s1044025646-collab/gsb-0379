import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase } from "../src/db.js";
import { GameService } from "../src/service.js";
import { startServer, type RunningServer } from "../src/server.js";

const dbFile = resolve("data", "test-api.db");
let running: RunningServer;
let base: string;

before(async () => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(dbFile + suffix, { force: true });
  const db = openDatabase(dbFile);
  const service = new GameService(db);
  running = await startServer(service, 0);
  base = `http://127.0.0.1:${running.port}`;
});

after(async () => {
  await running.close();
});

async function req(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: await res.json() };
}

test("完整 API 流程：开局/落子/额外回合/错误码/冲突/幂等/回放/撤销/导出", async () => {
  const health = await req("/health");
  assert.equal(health.status, 200);

  const created = await req("/games", { method: "POST", body: "{}" });
  assert.equal(created.status, 201);
  const gameId = created.body.id;
  assert.deepEqual(created.body.legalPits, ["A1", "A2", "A3", "A4", "A5", "A6"]);

  // 错误玩家
  const wrongPlayer = await req(`/games/${gameId}/moves`, {
    method: "POST",
    body: JSON.stringify({ player: "B", pit: "A3", expectedVersion: 0 }),
  });
  assert.equal(wrongPlayer.status, 400);
  assert.equal(wrongPlayer.body.error.code, "NOT_YOUR_TURN");

  // 非法编号（得分仓）
  const store = await req(`/games/${gameId}/moves`, {
    method: "POST",
    body: JSON.stringify({ player: "A", pit: "A仓", expectedVersion: 0 }),
  });
  assert.equal(store.body.error.code, "INVALID_PIT");

  // 正常落子 + 幂等
  const move = await req(`/games/${gameId}/moves`, {
    method: "POST",
    body: JSON.stringify({ player: "A", pit: "A3", expectedVersion: 0, reqId: "abc" }),
  });
  assert.equal(move.status, 201);
  assert.equal(move.body.detail.lastLabel, "A仓");
  assert.equal(move.body.game.state.turn, "A");

  const duplicate = await req(`/games/${gameId}/moves`, {
    method: "POST",
    body: JSON.stringify({ player: "A", pit: "A3", expectedVersion: 0, reqId: "abc" }),
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicated, true);
  assert.equal(duplicate.body.game.version, 1);

  // 版本冲突
  const conflict = await req(`/games/${gameId}/moves`, {
    method: "POST",
    body: JSON.stringify({ player: "A", pit: "A4", expectedVersion: 0 }),
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, "VERSION_CONFLICT");

  // 回放与撤销
  const replay = await req(`/games/${gameId}/replay?step=0`);
  assert.equal(replay.body.state.pits[2], 4);

  const undone = await req(`/games/${gameId}/undo`, { method: "POST" });
  assert.equal(undone.body.version, 0);
  assert.equal(undone.body.state.turn, "A");

  const exported = await req(`/games/${gameId}/export`);
  assert.equal(exported.body.moves.length, 0);
  assert.equal(exported.body.ruleVersion, "kalah-6-4-v1");
});

test("非法 JSON 与未知路由返回明确错误码", async () => {
  const bad = await fetch(base + "/games", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not-json",
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, "INVALID_JSON");

  const nf = await req("/nope");
  assert.equal(nf.status, 404);
  assert.equal(nf.body.error.code, "NOT_FOUND");
});

