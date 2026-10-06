/**
 * Kalah(6,6,4) 固定变体规则引擎（纯函数，无 IO）。
 *
 * 固定环形编号（永不随当前玩家翻转）：
 *   下标 0..5   = A1..A6   （A 方普通坑）
 *   下标 6      = A 仓     （A 方得分仓）
 *   下标 7..12  = B1..B6   （B 方普通坑）
 *   下标 13     = B 仓     （B 方得分仓）
 * 播撒顺序：A1→…→A6→A仓→B1→…→B6→B仓→A1→…（经过对手得分仓时跳过）。
 * 普通坑下标 i 的正对面为 12 - i。
 */

export const RULES_VERSION = "kalah-6x4-v1";
export const PIT_COUNT_PER_SIDE = 6;
export const INITIAL_SEEDS_PER_PIT = 4;
export const BOARD_SIZE = 14;
export const STORE_A = 6;
export const STORE_B = 13;

export type Player = "A" | "B";

export interface GameState {
  /** 长度 14：0..5 A 坑，6 A 仓，7..12 B 坑，13 B 仓 */
  board: number[];
  currentPlayer: Player;
  gameOver: boolean;
  winner: Player | "draw" | null;
}

export interface CaptureDetail {
  /** 最后一颗落入的自己的空坑（下标与公开编号） */
  landingPit: number;
  landingLabel: string;
  /** 被取子的对面坑（下标与公开编号） */
  oppositePit: number;
  oppositeLabel: string;
  capturedFromOpposite: number;
  /** 收进自己仓的总数 = 对面坑子数 + 最后落下的这 1 颗 */
  totalToStore: number;
}

export interface EndgameCollection {
  /** 哪一方的普通坑被清空触发终局 */
  emptiedSide: Player;
  /** 另一方剩余普通坑被归仓的明细 */
  collected: { pit: number; label: string; seeds: number }[];
  collectedTotal: number;
  intoStore: number;
  intoStoreLabel: string;
}

export interface MoveReport {
  rulesVersion: string;
  player: Player;
  /** 所选坑下标与公开编号 */
  pit: number;
  pitLabel: string;
  pickedUp: number;
  /** 逐颗播撒经过的位置（下标序列，含重复绕圈） */
  path: number[];
  pathLabels: string[];
  lastPosition: number;
  lastPositionLabel: string;
  extraTurn: boolean;
  capture: CaptureDetail | null;
  endgame: EndgameCollection | null;
  nextPlayer: Player | null;
  gameOver: boolean;
  winner: Player | "draw" | null;
  boardAfter: number[];
}

export class RuleError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "RuleError";
  }
}

export function defaultBoard(): number[] {
  const board = new Array<number>(BOARD_SIZE).fill(INITIAL_SEEDS_PER_PIT);
  board[STORE_A] = 0;
  board[STORE_B] = 0;
  return board;
}

export function initialState(board?: number[]): GameState {
  return {
    board: board ? [...board] : defaultBoard(),
    currentPlayer: "A",
    gameOver: false,
    winner: null,
  };
}

/** 校验导入的教学盘面；非法时抛 RuleError(ILLEGAL_IMPORT) */
export function validateImportedBoard(board: unknown): number[] {
  if (!Array.isArray(board) || board.length !== BOARD_SIZE) {
    throw new RuleError("ILLEGAL_IMPORT", `盘面必须是长度 ${BOARD_SIZE} 的数组`);
  }
  for (const v of board) {
    if (!Number.isInteger(v) || (v as number) < 0) {
      throw new RuleError("ILLEGAL_IMPORT", "每个位置的子数必须是非负整数");
    }
  }
  const nums = board as number[];
  const total = nums.reduce((a, b) => a + b, 0);
  if (total === 0) {
    throw new RuleError("ILLEGAL_IMPORT", "盘面不能没有任何棋子");
  }
  if (total > PIT_COUNT_PER_SIDE * 2 * INITIAL_SEEDS_PER_PIT) {
    throw new RuleError("ILLEGAL_IMPORT", "总子数不能超过 48");
  }
  const sideEmpty = (start: number) =>
    nums.slice(start, start + PIT_COUNT_PER_SIDE).every((v) => v === 0);
  if (sideEmpty(0) || sideEmpty(7)) {
    throw new RuleError(
      "ILLEGAL_IMPORT",
      "导入盘面不能是终局形态（任意一方六个普通坑全空）",
    );
  }
  return [...nums];
}

export function storeIndexOf(player: Player): number {
  return player === "A" ? STORE_A : STORE_B;
}

export function pitRangeOf(player: Player): number[] {
  const start = player === "A" ? 0 : 7;
  return Array.from({ length: PIT_COUNT_PER_SIDE }, (_, k) => start + k);
}

/** 下标 → 公开编号（A1..A6 / A仓 / B1..B6 / B仓） */
export function labelOf(index: number): string {
  if (index >= 0 && index <= 5) return `A${index + 1}`;
  if (index === STORE_A) return "A仓";
  if (index >= 7 && index <= 12) return `B${index - 6}`;
  if (index === STORE_B) return "B仓";
  throw new RuleError("INVALID_PIT", `非法位置下标 ${index}`);
}

/** 公开编号 → 下标；接受 A1..A6 / B1..B6（仓编号不可落子，由调用方拒绝） */
export function parsePitLabel(label: string): number | null {
  const m = /^([ABab])([1-6])$/.exec(label.trim());
  if (!m) return null;
  const n = Number(m[2]);
  return m[1].toUpperCase() === "A" ? n - 1 : 6 + n;
}

export function oppositeOf(index: number): number {
  return 12 - index;
}

export function legalPits(state: GameState): number[] {
  if (state.gameOver) return [];
  return pitRangeOf(state.currentPlayer).filter((i) => state.board[i] > 0);
}

export function totalSeeds(board: number[]): number {
  return board.reduce((a, b) => a + b, 0);
}

/**
 * 执行一次落子。非法输入抛 RuleError，且保证完全不修改传入 state。
 */
export function applyMove(state: GameState, player: Player, pit: number): MoveReport {
  if (state.gameOver) {
    throw new RuleError("GAME_OVER", "对局已结束，不再接受落子");
  }
  if (player !== "A" && player !== "B") {
    throw new RuleError("INVALID_PLAYER", `非法玩家：${String(player)}`);
  }
  if (player !== state.currentPlayer) {
    throw new RuleError(
      "WRONG_PLAYER",
      `当前应由 ${state.currentPlayer} 行动，不能由 ${player} 落子`,
    );
  }
  if (!Number.isInteger(pit) || pit < 0 || pit >= BOARD_SIZE) {
    throw new RuleError("INVALID_PIT", `非法坑位：${String(pit)}`);
  }
  if (pit === STORE_A || pit === STORE_B) {
    throw new RuleError("STORE_PIT", "得分仓不能作为落子起点");
  }
  if (!pitRangeOf(player).includes(pit)) {
    throw new RuleError("NOT_OWN_PIT", `玩家 ${player} 不能选择 ${labelOf(pit)}`);
  }
  if (state.board[pit] === 0) {
    throw new RuleError("EMPTY_PIT", `${labelOf(pit)} 是空坑，不能选择`);
  }

  const board = [...state.board];
  const myStore = storeIndexOf(player);
  const oppStore = storeIndexOf(player === "A" ? "B" : "A");

  const pickedUp = board[pit];
  board[pit] = 0;

  const path: number[] = [];
  let pos = pit;
  for (let s = 0; s < pickedUp; s++) {
    do {
      pos = (pos + 1) % BOARD_SIZE;
    } while (pos === oppStore); // 经过对手得分仓时跳过
    board[pos] += 1;
    path.push(pos);
  }
  const last = path[path.length - 1];

  // 额外回合：最后一颗落入自己的仓
  let extraTurn = last === myStore;

  // 对面取子：最后一颗落入自己原本为空的普通坑，且正对面有子
  let capture: CaptureDetail | null = null;
  const ownPits = pitRangeOf(player);
  if (ownPits.includes(last) && board[last] === 1) {
    const opp = oppositeOf(last);
    if (board[opp] > 0) {
      const taken = board[opp];
      board[opp] = 0;
      board[last] = 0;
      board[myStore] += taken + 1;
      capture = {
        landingPit: last,
        landingLabel: labelOf(last),
        oppositePit: opp,
        oppositeLabel: labelOf(opp),
        capturedFromOpposite: taken,
        totalToStore: taken + 1,
      };
    }
  }

  // 终局归仓：任意一方六个普通坑全空（终局优先于额外回合）
  let endgame: EndgameCollection | null = null;
  const sideEmpty = (p: Player) => pitRangeOf(p).every((i) => board[i] === 0);
  let gameOver = false;
  let winner: Player | "draw" | null = null;
  if (sideEmpty("A") || sideEmpty("B")) {
    gameOver = true;
    extraTurn = false;
    const emptiedSide: Player = sideEmpty("A") ? "A" : "B";
    const other: Player = emptiedSide === "A" ? "B" : "A";
    const otherStore = storeIndexOf(other);
    const collected = pitRangeOf(other)
      .filter((i) => board[i] > 0)
      .map((i) => ({ pit: i, label: labelOf(i), seeds: board[i] }));
    const collectedTotal = collected.reduce((a, c) => a + c.seeds, 0);
    for (const i of pitRangeOf(other)) board[i] = 0;
    board[otherStore] += collectedTotal;
    endgame = {
      emptiedSide,
      collected,
      collectedTotal,
      intoStore: otherStore,
      intoStoreLabel: labelOf(otherStore),
    };
    const sa = board[STORE_A];
    const sb = board[STORE_B];
    winner = sa === sb ? "draw" : sa > sb ? "A" : "B";
  }

  const nextPlayer: Player | null = gameOver
    ? null
    : extraTurn
      ? player
      : player === "A"
        ? "B"
        : "A";

  return {
    rulesVersion: RULES_VERSION,
    player,
    pit,
    pitLabel: labelOf(pit),
    pickedUp,
    path,
    pathLabels: path.map(labelOf),
    lastPosition: last,
    lastPositionLabel: labelOf(last),
    extraTurn,
    capture,
    endgame,
    nextPlayer,
    gameOver,
    winner,
    boardAfter: board,
  };
}

/** 应用报告得到新状态（调用方需已用 applyMove 校验） */
export function nextState(state: GameState, report: MoveReport): GameState {
  return {
    board: [...report.boardAfter],
    currentPlayer: report.gameOver ? state.currentPlayer : (report.nextPlayer as Player),
    gameOver: report.gameOver,
    winner: report.winner,
  };
}
