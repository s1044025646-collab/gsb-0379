import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  applyMove,
  GameError,
  importState,
  initialState,
  labelOf,
  legalPits,
  parsePitLabel,
  RULE_VERSION,
  type BoardState,
  type MoveDetail,
} from "./engine.js";
import {
  commitMove,
  getGame,
  getMoveAtSeq,
  getMoveByReqId,
  getMoves,
  insertGame,
  rollbackLastMove,
  rowInitialState,
  rowToState,
  type GameRow,
} from "./db.js";

export interface PublicMove {
  seq: number;
  player: "A" | "B";
  pit: string;
  detail: MoveDetail;
}

export interface GameView {
  id: string;
  ruleVersion: string;
  version: number;
  state: BoardState;
  legalPits: string[];
}

function stateAfter(row: GameRow): BoardState {
  return rowToState(row);
}

export class GameService {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  createGame(initial?: { pits?: number[]; turn?: "A" | "B" }): GameView {
    const state = initial ? importState(initial.pits, initial.turn) : initialState();
    const id = randomUUID();
    const now = new Date().toISOString();
    insertGame(this.db, {
      id,
      rule_version: RULE_VERSION,
      version: 0,
      pits: JSON.stringify(state.pits),
      turn: state.turn,
      game_over: state.gameOver ? 1 : 0,
      winner: state.winner,
      initial_pits: JSON.stringify(state.pits),
      initial_turn: initial?.turn ?? "A",
      created_at: now,
    });
    return this.view(id);
  }

  private requireGame(id: string): GameRow {
    const row = getGame(this.db, id);
    if (!row) throw new GameError("GAME_NOT_FOUND", `对局 ${id} 不存在`);
    return row;
  }

  view(id: string): GameView {
    const row = this.requireGame(id);
    const state = stateAfter(row);
    return {
      id: row.id,
      ruleVersion: row.rule_version,
      version: row.version,
      state,
      legalPits: legalPits(state).map((i) => labelOf(i)),
    };
  }

  list(): { id: string; version: number; gameOver: boolean }[] {
    return (this.db.prepare("SELECT id, version, game_over FROM games ORDER BY created_at").all() as {
      id: string;
      version: number;
      game_over: number;
    }[]).map((r) => ({ id: r.id, version: r.version, gameOver: r.game_over === 1 }));
  }

  // 落子：期望版本冲突报 VERSION_CONFLICT；相同请求编号重放返回首次结果，不重复播子。
  move(
    id: string,
    player: string,
    pitLabel: string,
    expectedVersion: number,
    reqId: string | null
  ): { view: GameView; detail: MoveDetail; duplicated: boolean } {
    const row = this.requireGame(id);

    if (reqId) {
      const prior = getMoveByReqId(this.db, id, reqId);
      if (prior) {
        const detail = JSON.parse(prior.detail) as MoveDetail;
        return { view: this.view(id), detail, duplicated: true };
      }
    }

    if (player !== "A" && player !== "B") {
      throw new GameError("INVALID_PLAYER", "玩家必须是 A 或 B");
    }
    const pitIndex = parsePitLabel(pitLabel);
    if (pitIndex === null) {
      throw new GameError("INVALID_PIT", "坑位编号必须形如 A1..A6 或 B1..B6（得分仓不可落子）");
    }
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      throw new GameError("INVALID_VERSION", "expectedVersion 必须为非负整数");
    }
    if (expectedVersion !== row.version) {
      throw new VersionConflict(row.version);
    }

    const state = stateAfter(row);
    const outcome = applyMove(state, player, pitIndex);
    commitMove(
      this.db,
      id,
      outcome.state,
      outcome.detail,
      row.version + 1,
      row.version,
      row.version + 1,
      reqId
    );
    return { view: this.view(id), detail: outcome.detail, duplicated: false };
  }

  history(id: string): PublicMove[] {
    this.requireGame(id);
    return getMoves(this.db, id).map((m) => ({
      seq: m.seq,
      player: m.player,
      pit: labelOf(m.pit_index),
      detail: JSON.parse(m.detail) as MoveDetail,
    }));
  }

  // 回放至第 step 步（step=0 为记录的初始盘面）。使用记录的初始盘面与动作重放，不改写历史。
  replay(id: string, step: number): { step: number; state: BoardState; detail: MoveDetail | null } {
    const row = this.requireGame(id);
    const total = getMoves(this.db, id).length;
    if (!Number.isInteger(step) || step < 0 || step > total) {
      throw new GameError("INVALID_STEP", `步数必须在 0..${total} 之间`);
    }
    let state = rowInitialState(row);
    let detail: MoveDetail | null = null;
    for (let s = 1; s <= step; s++) {
      const moveRow = getMoveAtSeq(this.db, id, s);
      if (!moveRow) throw new GameError("REPLAY_ERROR", `缺少第 ${s} 步记录`);
      const outcome = applyMove(state, moveRow.player, moveRow.pit_index);
      state = outcome.state;
      detail = outcome.detail;
      if (state.gameOver && s < step) {
        throw new GameError("REPLAY_ERROR", "终局之后不存在更多合法动作");
      }
    }
    return { step, state, detail };
  }

  undo(id: string): GameView {
    this.requireGame(id);
    const removed = rollbackLastMove(this.db, id);
    if (!removed) throw new GameError("NO_MOVE_TO_UNDO", "尚无动作可以撤销");
    return this.view(id);
  }

  exportGame(id: string) {
    const row = this.requireGame(id);
    return {
      id: row.id,
      ruleVersion: row.rule_version,
      version: row.version,
      initial: {
        pits: JSON.parse(row.initial_pits) as number[],
        turn: row.initial_turn,
      },
      current: stateAfter(row),
      moves: this.history(id),
      exportedAt: new Date().toISOString(),
    };
  }
}

export class VersionConflict extends GameError {
  currentVersion: number;
  constructor(currentVersion: number) {
    super("VERSION_CONFLICT", `版本过期：当前版本为 ${currentVersion}`);
    this.currentVersion = currentVersion;
  }
}
