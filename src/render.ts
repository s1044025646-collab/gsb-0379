import { labelOf, STORE_A, STORE_B, type BoardState } from "./engine.js";

// 文本表（固定编号，不随玩家翻转）：
//      A1 A2 ... A6   <- A 方普通坑
// A仓                B仓
//      B1 B2 ... B6   <- B 方普通坑
export function renderBoard(state: BoardState): string {
  const p = state.pits;
  const aLabels = [0, 1, 2, 3, 4, 5].map((i) => labelOf(i));
  const bLabels = [7, 8, 9, 10, 11, 12].map((i) => labelOf(i));
  const aVals = [0, 1, 2, 3, 4, 5].map((i) => p[i]);
  const bVals = [7, 8, 9, 10, 11, 12].map((i) => p[i]);

  const w = 5;
  const cell = (s: string | number) => String(s).padStart(w, " ");
  const line: string[] = [];
  line.push("        " + aLabels.map((l) => cell(l)).join(" "));
  line.push("        " + aVals.map((v) => cell(v)).join(" "));
  line.push(cell(labelOf(STORE_A)) + " ".repeat(6 * (w + 1) - 2) + cell(labelOf(STORE_B)));
  line.push(cell(p[STORE_A]) + " ".repeat(6 * (w + 1) - 2) + cell(p[STORE_B]));
  line.push("        " + bLabels.map((l) => cell(l)).join(" "));
  line.push("        " + bVals.map((v) => cell(v)).join(" "));
  line.push(
    state.gameOver
      ? `对局结束，结果：${state.winner === "DRAW" ? "平局" : state.winner + " 获胜"}`
      : `轮到：${state.turn}（A 先走；编号固定不翻转）`
  );
  return line.join("\n");
}
