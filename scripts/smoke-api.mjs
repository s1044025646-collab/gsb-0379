// 冒烟脚本：启动 API（随机空闲端口），走一遍 开局→落子→幂等→冲突→撤销→回放→导出
import { startServer } from "../dist/src/server.js";

const server = startServer(["--port", "0", "--db", "data/smoke.db"]);
await new Promise((r) => server.on("listening", r));
const port = server.address().port;
const base = `http://localhost:${port}`;

const post = (p, body) =>
  fetch(base + p, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
const get = (p) => fetch(base + p).then(async (r) => ({ status: r.status, body: await r.json() }));

const g = await post("/games");
console.log("开局:", g.status, "当前行动方:", g.body.currentPlayer);
const id = g.body.gameId;

const m1 = await post(`/games/${id}/moves`, { player: "A", pit: "A3", expectedVersion: 0, requestId: "req-1" });
console.log("落子A3:", m1.status, "最后落点:", m1.body.move.lastPositionLabel, "额外回合:", m1.body.move.extraTurn);

const dup = await post(`/games/${id}/moves`, { player: "A", pit: "A3", expectedVersion: 0, requestId: "req-1" });
console.log("重复请求:", dup.status, "idempotentReplay:", dup.body.idempotentReplay);

const conflict = await post(`/games/${id}/moves`, { player: "A", pit: "A1", expectedVersion: 9, requestId: "req-2" });
console.log("版本冲突:", conflict.status, conflict.body.error.code);

const wrong = await post(`/games/${id}/moves`, { player: "B", pit: "B1", expectedVersion: 1, requestId: "req-3" });
console.log("错误玩家:", wrong.status, wrong.body.error.code);

const undo = await post(`/games/${id}/undo`);
console.log("撤销:", undo.status, "A3子数:", undo.body.game.board[2], "版本:", undo.body.game.version);

const replay = await get(`/games/${id}/replay?to=0`);
console.log("回放至0:", replay.body.board.join(","));

const exp = await get(`/games/${id}/export`);
console.log("导出: 规则版本", exp.body.rulesVersion, "动作数", exp.body.moves.length);

// node:sqlite 实验特性在 Windows 退出阶段有已知句柄告警，直接退出即可
process.exit(0);
