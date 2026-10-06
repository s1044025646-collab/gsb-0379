// Kalah（6 坑 × 4 子固定变体）纯规则引擎。
// 固定环形下标，不随当前玩家翻转：
//   0..5 = A1..A6，6 = A仓，7..12 = B1..B6，13 = B仓，随后回到 0。

export const RULE_VERSION = "kalah-6-4-v1";
export const PIT_COUNT = 14;
export const STORE_A = 6;
export const STORE_B = 13;
export const TOTAL_PITS_PER_SIDE = 6;

export type Player = "A" | "B";
export type Winner = Player | "DRAW";

export interface BoardState {
  pits: number[];          // 长度 14，下标含义见文件头注释
  turn: Player;            // 下一位行动玩家
  gameOver: boolean;
  winner: Winner | null;
}

export interface Drop {
  index: number;           // 落入的固定下标
  label: string;           // 固定公开编号，如 A3 / B仓
}

export interface Capture {
  landIndex: number;       // 最后落点（自己的普通坑）
  landLabel: string;
  oppositeIndex: number;   // 对面坑下标 = 12 - landIndex
  oppositeLabel: string;
  ownSideLabel: string;    // 最后落点在落子方阵营的公开编号
  otherSideLabel: string;  // 对面坑在对手阵营的公开编号
  stones: number;          // 收进仓的总数（最后一颗 + 对面全部）
}

export interface EndSweep {
  player: Player;          // 被归仓的一方
  collected: { index: number; label: string; stones: number }[];
  total: number;
}

export interface MoveDetail {
  player: Player;
  pitIndex: number;
  pitLabel: string;
  pickedUp: number;
  drops: Drop[];           // 逐颗播撒路径（跳过对手仓时不计入）
  skipped: Drop[];         // 被跳过的对手得分仓经过记录
  lastIndex: number;
  lastLabel: string;
  capture: Capture | null;
  extraTurn: boolean;
  endSweep: EndSweep | null;
  nextPlayer: Player;
  gameOver: boolean;
  winner: Winner | null;
  before: number[];
  after: number[];
}

export class GameError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GameError";
    this.code = code;
  }
}

export function storeOf(player: Player): number {
  return player === "A" ? STORE_A : STORE_B;
}

export function opponent(player: Player): Player {
  return player === "A" ? "B" : "A";
}

export function labelOf(index: number): string {
  if (index < 0 || index >= PIT_COUNT) throw new Error(`非法下标 ${index}`);
  if (index === STORE_A) return "A仓";
  if (index === STORE_B) return "B仓";
  if (index < STORE_A) return `A${index + 1}`;
  return `B${index - STORE_A}`; // 7..12 -> B1..B6
}

// 公开编号（如 "A3" / "B2"）解析为固定下标；得分仓与未知编号返回 null。
export function parsePitLabel(label: string): number | null {
  const m = /^([AB])([1-6])$/.exec(label.trim().toUpperCase());
  if (!m) return null;
  const side = m[1] === "A" ? 0 : 7;
  return side + Number(m[2]) - 1;
}

export function ownerOf(index: number): Player | null {
  if (index >= 0 && index <= 5) return "A";
  if (index >= 7 && index <= 12) return "B";
  return null; // 得分仓
}

// 普通坑 i（0..11）的正对面固定为 12 - i。
export function oppositeIndex(index: number): number {
  return 12 - index;
}

export function sidePits(player: Player): number[] {
  return player === "A" ? [0, 1, 2, 3, 4, 5] : [7, 8, 9, 10, 11, 12];
}

export function initialState(): BoardState {
  const pits = new Array<number>(PIT_COUNT).fill(0);
  for (const i of sidePits("A")) pits[i] = 4;
  for (const i of sidePits("B")) pits[i] = 4;
  return { pits, turn: "A", gameOver: false, winner: null };
}

export function totalStones(pits: number[]): number {
  return pits.reduce((sum, n) => sum + n, 0);
}

// 受限教学盘面导入：允许任意非负整数配置（不要求可由默认开局到达）。
export function importState(
  input: unknown,
  turn: unknown = "A"
): BoardState {
  if (!Array.isArray(input) || input.length !== PIT_COUNT) {
    throw new GameError("INVALID_IMPORT", "盘面必须是长度 14 的非负整数数组（A1..A6,A仓,B1..B6,B仓）");
  }
  const pits = input.map((v) => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 100) {
      throw new GameError("INVALID_IMPORT", "每个坑/仓的棋子数必须是 0..100 的整数");
    }
    return v;
  });
  if (totalStones(pits) === 0) {
    throw new GameError("INVALID_IMPORT", "盘面总子数必须大于 0");
  }
  if (turn !== "A" && turn !== "B") {
    throw new GameError("INVALID_IMPORT", "先手玩家必须是 A 或 B");
  }
  // 教学盘面不要求可由默认开局到达，也不在导入时立即终局：
  // 终局只在一次播撒/取子完成后判定。
  return { pits, turn, gameOver: false, winner: null };
}

export function legalPits(state: BoardState, player?: Player): number[] {
  if (state.gameOver) return [];
  const actor = player ?? state.turn;
  return sidePits(actor).filter((i) => state.pits[i] > 0);
}

function nextSowIndex(index: number, movingPlayer: Player): { index: number; skipped: boolean } {
  const candidate = (index + 1) % PIT_COUNT;
  // 经过对手得分仓时跳过。
  if (candidate === storeOf(opponent(movingPlayer))) {
    return { index: (candidate + 1) % PIT_COUNT, skipped: true };
  }
  return { index: candidate, skipped: false };
}

function finalizeIfEmpty(state: BoardState): boolean {
  const aEmpty = sidePits("A").every((i) => state.pits[i] === 0);
  const bEmpty = sidePits("B").every((i) => state.pits[i] === 0);
  if (!aEmpty && !bEmpty) return false;

  let sweep: EndSweep | null = null;
  // 将仍有剩余子的一方普通坑全部归入其得分仓。
  const survivor: Player | null = !aEmpty ? "A" : !bEmpty ? "B" : null;
  if (survivor) {
    const collected: EndSweep["collected"] = [];
    let total = 0;
    for (const i of sidePits(survivor)) {
      const stones = state.pits[i];
      if (stones > 0) {
        collected.push({ index: i, label: labelOf(i), stones });
        state.pits[storeOf(survivor)] += stones;
        state.pits[i] = 0;
        total += stones;
      }
    }
    sweep = { player: survivor, collected, total };
  }
  state.gameOver = true;
  state.winner =
    state.pits[STORE_A] > state.pits[STORE_B]
      ? "A"
      : state.pits[STORE_B] > state.pits[STORE_A]
        ? "B"
        : "DRAW";
  (state as BoardState & { lastSweep?: EndSweep | null }).lastSweep = sweep;
  return true;
}

export interface MoveOutcome {
  state: BoardState;
  detail: MoveDetail;
}

// 在给定盘面上执行一次落子；任何校验失败都抛出且不修改入参盘面。
export function applyMove(
  source: BoardState,
  player: Player,
  pitIndex: number
): MoveOutcome {
  if (source.gameOver) {
    throw new GameError("GAME_OVER", "对局已结束，不再接受落子");
  }
  if (player !== "A" && player !== "B") {
    throw new GameError("INVALID_PLAYER", "玩家必须是 A 或 B");
  }
  if (player !== source.turn) {
    throw new GameError("NOT_YOUR_TURN", `现在轮到 ${source.turn} 行动，${player} 不能落子`);
  }
  if (pitIndex === STORE_A || pitIndex === STORE_B || pitIndex < 0 || pitIndex >= PIT_COUNT) {
    throw new GameError("INVALID_PIT", "得分仓或越界编号不能落子");
  }
  if (ownerOf(pitIndex) !== player) {
    throw new GameError("INVALID_PIT", `只能选择自己的普通坑，${labelOf(pitIndex)} 不属于 ${player}`);
  }
  if (source.pits[pitIndex] === 0) {
    throw new GameError("EMPTY_PIT", `${labelOf(pitIndex)} 为空，不能选择空坑`);
  }

  const before = source.pits.slice();
  const pits = source.pits.slice();
  const pickedUp = pits[pitIndex];
  pits[pitIndex] = 0; // 拿起该坑全部子

  const drops: Drop[] = [];
  const skipped: Drop[] = [];
  let current = pitIndex;
  for (let n = 0; n < pickedUp; n++) {
    const step = nextSowIndex(current, player);
    if (step.skipped) {
      skipped.push({ index: storeOf(opponent(player)), label: labelOf(storeOf(opponent(player))) });
      // 被跳过的仓不投子，但这一颗继续投到下一个位置。
    }
    current = step.index;
    pits[current] += 1;
    drops.push({ index: current, label: labelOf(current) });
  }

  const lastIndex = current;
  let capture: Capture | null = null;
  let extraTurn = false;

  if (lastIndex === storeOf(player)) {
    // 最后一颗落在自己的得分仓：额外回合。
    extraTurn = true;
  } else if (
    ownerOf(lastIndex) === player &&
    pits[lastIndex] === 1 // 落入前为空（本次只落入这一颗）
  ) {
    const opp = oppositeIndex(lastIndex);
    if (pits[opp] > 0) {
      const stones = 1 + pits[opp];
      pits[storeOf(player)] += stones;
      pits[lastIndex] = 0;
      pits[opp] = 0;
      capture = {
        landIndex: lastIndex,
        landLabel: labelOf(lastIndex),
        oppositeIndex: opp,
        oppositeLabel: labelOf(opp),
        ownSideLabel: labelOf(lastIndex),
        otherSideLabel: labelOf(opp),
        stones,
      };
    }
  }

  const next: BoardState = {
    pits,
    turn: source.turn,
    gameOver: false,
    winner: null,
  };

  const ended = finalizeIfEmpty(next);
  const sweep = ended
    ? (next as BoardState & { lastSweep?: EndSweep | null }).lastSweep ?? null
    : null;
  if (!ended) {
    next.turn = extraTurn ? player : opponent(player);
  }

  const detail: MoveDetail = {
    player,
    pitIndex,
    pitLabel: labelOf(pitIndex),
    pickedUp,
    drops,
    skipped,
    lastIndex,
    lastLabel: labelOf(lastIndex),
    capture,
    extraTurn: ended ? false : extraTurn, // 终局优先于额外回合
    endSweep: sweep,
    nextPlayer: next.turn,
    gameOver: next.gameOver,
    winner: next.winner,
    before,
    after: pits.slice(),
  };
  return { state: next, detail };
}

export function describeMove(d: MoveDetail): string[] {
  const lines: string[] = [];
  lines.push(`${d.player} 选择 ${d.pitLabel}，拿起 ${d.pickedUp} 颗`);
  lines.push(`逐颗路径：${d.drops.map((x) => x.label).join(" → ")}`);
  if (d.skipped.length > 0) {
    lines.push(`跳过对手仓 ${d.skipped.map((x) => x.label).join("、")}（共 ${d.skipped.length} 次）`);
  }
  lines.push(`最后落点：${d.lastLabel}`);
  if (d.capture) {
    lines.push(
      `触发对面取子：${d.capture.ownSideLabel} 的最后 1 颗 + 对面 ${d.capture.otherSideLabel} 的 ${
        d.capture.stones - 1
      } 颗，共 ${d.capture.stones} 颗进入 ${d.player}仓`
    );
  }
  if (d.gameOver) {
    lines.push("对局结束");
    if (d.endSweep) {
      lines.push(
        `终局归仓：${d.endSweep.player} 方剩余 ${d.endSweep.total} 颗进入 ${d.endSweep.player}仓`
      );
    }
    lines.push(d.winner === "DRAW" ? "双方仓内子数相同：平局" : `获胜方：${d.winner}`);
  } else if (d.extraTurn) {
    lines.push(`最后一颗进入自己的仓，${d.player} 获得额外回合`);
  } else {
    lines.push(`下一位玩家：${d.nextPlayer}`);
  }
  return lines;
}
