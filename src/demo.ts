// 可复现完整对局/教学演示：全部动作与初始盘面固定，规则版本固定。
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase } from "./db.js";
import { GameService } from "./service.js";
import { describeMove, labelOf, totalStones } from "./engine.js";
import { renderBoard } from "./render.js";

const demoDb = resolve("data", "kalah-demo.db");
rmSync(demoDb, { force: true });
rmSync(`${demoDb}-wal`, { force: true });
rmSync(`${demoDb}-shm`, { force: true });

const db = openDatabase(demoDb);
const service = new GameService(db);

function section(title: string): void {
  console.log("\n" + "=".repeat(72));
  console.log(title);
  console.log("=".repeat(72));
}

function play(
  gameId: string,
  steps: { player: "A" | "B"; pit: string }[]
): void {
  let version = service.view(gameId).version;
  for (const s of steps) {
    const { detail, view } = service.move(gameId, s.player, s.pit, version, null);
    version = view.version;
    for (const line of describeMove(detail)) console.log("  " + line);
  }
  const v = service.view(gameId);
  console.log(renderBoard(v.state).split("\n").map((l) => "  " + l).join("\n"));
  console.log(`  总子数=${totalStones(v.state.pits)} 版本=${v.version} gameOver=${v.state.gameOver}`);
}

// 演示 1：默认开局，A 走第三坑 A3 -> 最后落 A仓，A 获额外回合。
section("演示 1：默认开局 A 选 A3（固定编号 A1..A6），最后落在自己的仓并获得额外回合");
const g1 = service.createGame().id;
play(g1, [{ player: "A", pit: "A3" }]);

// 演示 2：对面取子。
// A 方：A1=0,A2=1（落 A2 最终到 A3），A3 空 -> 取对面 B4。
section("演示 2：对面取子（A 落 A2，最后落入原本为空的 A3，取走对面 B4）");
//           A1 A2 A3 A4 A5 A6 A仓 B1 B2 B3 B4 B5 B6 B仓
const p2 = [0, 1, 0, 1, 1, 1, 0,  1, 1, 1, 9, 1, 1, 0];
const g2 = service.createGame({ pits: p2, turn: "A" }).id;
console.log("  初始公开编号：A3=" + labelOf(2) + " 对面固定为 " + labelOf(12 - 2) + "（下标 2 <-> 10）");
play(g2, [{ player: "A", pit: "A2" }]);

// 演示 3：多圈播撒并跳过对手得分仓。
section("演示 3：多圈播撒，途经 B仓 时跳过（A 拿起 14 颗）");
// 构造：A1=14，其余普通坑各放 1（避免立即终局）。
const p3 = [14, 1, 1, 1, 1, 1, 0,  1, 1, 1, 1, 1, 1, 0];
const g3 = service.createGame({ pits: p3, turn: "A" }).id;
play(g3, [{ player: "A", pit: "A1" }]);

// 演示 4：终局归仓。
section("演示 4：终局归仓（A 走完后己方普通坑全空，B 方剩余子全部归入 B仓）");
// A 方只有 A1=1；B 方各坑有子。播 1 颗入 A仓，A 额外回合但已无普通坑 -> 立即终局。
const p4 = [0, 0, 0, 0, 0, 1, 0,  2, 2, 2, 2, 2, 2, 0];
const g4 = service.createGame({ pits: p4, turn: "A" }).id;
play(g4, [{ player: "A", pit: "A6" }]);

// 演示 5：撤销终局，完整还原。
section("演示 5：撤销演示 4 的末步（终局也可撤销，逐项还原当前玩家/终局标志/坑仓）");
const beforeUndo = service.view(g4);
console.log("  撤销前：gameOver=" + beforeUndo.state.gameOver + " 版本=" + beforeUndo.version);
const restored = service.undo(g4);
console.log(renderBoard(restored.state).split("\n").map((l) => "  " + l).join("\n"));
console.log(`  撤销后：gameOver=${restored.state.gameOver} 版本=${restored.version} 总子数=${totalStones(restored.state.pits)}`);

// 演示 6：回放（演示 1 回到初始盘面）。
section("演示 6：历史回放（演示 1 回到第 0 步初始盘面，不改写旧动作）");
const r0 = service.replay(g1, 0);
console.log(renderBoard(r0.state).split("\n").map((l) => "  " + l).join("\n"));

db.close();
console.log("\n演示完成。数据库文件：" + demoDb);

