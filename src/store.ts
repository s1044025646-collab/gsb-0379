/**
 * SQLite 持久层（node:sqlite，无需外部依赖）。
 * 每步动作与动作前快照同事务原子写入；重启后可继续对局与回放。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  applyMove,
  initialState,
  nextState,
  validateImportedBoard,
  RuleError,
  RULES_VERSION,
  type GameState,
  type MoveReport,
  type Player,
} from "./rules.js";

export class StoreError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus = 400,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

export interface MoveRow {
  seq: number;
  requestId: string;
  player: Player;
  pit: number;
  report: MoveReport;
  stateBefore: GameState;
  stateAfter: GameState;
  createdAt: string;
}

export interface GameRecord {
  id: string;
  rulesVersion: string;
  version: number;
  state: GameState;
  initialBoard: number[];
  createdAt: string;
}

export interface MoveResult {
  game: GameRecord;
  move: MoveRow;
  /** true 表示命中幂等重放（重复 requestId），未再次播子 */
  idempotentReplay: boolean;
}

export class KalahStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        rules_version TEXT NOT NULL,
        version INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        initial_board_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS moves (
        game_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        request_id TEXT NOT NULL,
        player TEXT NOT NULL,
        pit INTEGER NOT NULL,
        report_json TEXT NOT NULL,
        state_before_json TEXT NOT NULL,
        state_after_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (game_id, seq),
        UNIQUE (game_id, request_id)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  createGame(importedBoard?: unknown): GameRecord {
    const board =
      importedBoard === undefined || importedBoard === null
        ? null
        : validateImportedBoard(importedBoard);
    const state = initialState(board ?? undefined);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO games (id, rules_version, version, state_json, initial_board_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, RULES_VERSION, 0, JSON.stringify(state), JSON.stringify(state.board), now);
    return this.getGame(id);
  }

  getGame(id: string): GameRecord {
    const row = this.db.prepare("SELECT * FROM games WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new StoreError("GAME_NOT_FOUND", `对局不存在：${id}`, 404);
    return {
      id: row.id as string,
      rulesVersion: row.rules_version as string,
      version: row.version as number,
      state: JSON.parse(row.state_json as string) as GameState,
      initialBoard: JSON.parse(row.initial_board_json as string) as number[],
      createdAt: row.created_at as string,
    };
  }

  listGames(): GameRecord[] {
    const rows = this.db.prepare("SELECT id FROM games ORDER BY created_at").all() as {
      id: string;
    }[];
    return rows.map((r) => this.getGame(r.id));
  }

  listMoves(gameId: string): MoveRow[] {
    this.getGame(gameId);
    const rows = this.db
      .prepare("SELECT * FROM moves WHERE game_id = ? ORDER BY seq")
      .all(gameId) as Record<string, unknown>[];
    return rows.map(rowToMove);
  }

  /**
   * 落子：校验期望版本（乐观锁）+ 请求编号幂等。
   * 动作与快照在同一事务内原子写入。
   */
  playMove(
    gameId: string,
    player: Player,
    pit: number,
    expectedVersion: number,
    requestId: string,
  ): MoveResult {
    if (!requestId || typeof requestId !== "string") {
      throw new StoreError("VALIDATION", "缺少请求编号 requestId");
    }
    if (!Number.isInteger(expectedVersion)) {
      throw new StoreError("VALIDATION", "expectedVersion 必须是整数");
    }

    // 幂等：同一对局内 requestId 已存在则直接返回原结果，不重复播子
    const dup = this.db
      .prepare("SELECT * FROM moves WHERE game_id = ? AND request_id = ?")
      .get(gameId, requestId) as Record<string, unknown> | undefined;
    if (dup) {
      return { game: this.getGame(gameId), move: rowToMove(dup), idempotentReplay: true };
    }

    const game = this.getGame(gameId);
    if (game.version !== expectedVersion) {
      throw new StoreError(
        "VERSION_CONFLICT",
        `期望版本 ${expectedVersion} 与当前版本 ${game.version} 不一致`,
        409,
      );
    }

    let report: MoveReport;
    try {
      report = applyMove(game.state, player, pit);
    } catch (e) {
      if (e instanceof RuleError) throw new StoreError(e.code, e.message, 422);
      throw e;
    }
    const after = nextState(game.state, report);
    const seq =
      ((this.db
        .prepare("SELECT MAX(seq) AS m FROM moves WHERE game_id = ?")
        .get(gameId) as { m: number | null }).m ?? 0) + 1;
    const now = new Date().toISOString();

    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "INSERT INTO moves (game_id, seq, request_id, player, pit, report_json, state_before_json, state_after_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          gameId,
          seq,
          requestId,
          player,
          pit,
          JSON.stringify(report),
          JSON.stringify(game.state),
          JSON.stringify(after),
          now,
        );
      this.db
        .prepare("UPDATE games SET version = ?, state_json = ? WHERE id = ? AND version = ?")
        .run(game.version + 1, JSON.stringify(after), gameId, game.version);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }

    const move = this.listMoves(gameId).find((m) => m.seq === seq)!;
    return { game: this.getGame(gameId), move, idempotentReplay: false };
  }

  /** 撤销末步：完整还原动作前快照（当前玩家、终局标志、全部坑与仓） */
  undo(gameId: string): { game: GameRecord; undone: MoveRow } {
    const game = this.getGame(gameId);
    const last = this.db
      .prepare("SELECT * FROM moves WHERE game_id = ? ORDER BY seq DESC LIMIT 1")
      .get(gameId) as Record<string, unknown> | undefined;
    if (!last) throw new StoreError("NOTHING_TO_UNDO", "没有可撤销的动作");
    const before = JSON.parse(last.state_before_json as string) as GameState;
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("DELETE FROM moves WHERE game_id = ? AND seq = ?")
        .run(gameId, last.seq as number);
      this.db
        .prepare("UPDATE games SET version = ?, state_json = ? WHERE id = ?")
        .run(game.version + 1, JSON.stringify(before), gameId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { game: this.getGame(gameId), undone: rowToMove(last) };
  }

  /**
   * 回放：以记录的初始盘面 + 逐步动作后快照还原第 step 步结束时的盘面。
   * step = 0 表示初始盘面；缺省为最新。历史动作只读，不改写。
   */
  replay(gameId: string, step?: number): { step: number; totalSteps: number; state: GameState } {
    const game = this.getGame(gameId);
    const moves = this.listMoves(gameId);
    const target = step === undefined ? moves.length : step;
    if (!Number.isInteger(target) || target < 0 || target > moves.length) {
      throw new StoreError("VALIDATION", `回放步数必须在 0..${moves.length} 之间`);
    }
    if (target === 0) {
      return {
        step: 0,
        totalSteps: moves.length,
        state: { ...initialState(game.initialBoard), board: [...game.initialBoard] },
      };
    }
    const move = moves[target - 1];
    return { step: target, totalSteps: moves.length, state: move.stateAfter };
  }

  /** 导出完整对局（初始盘面、规则版本、全部动作与快照） */
  exportGame(gameId: string): Record<string, unknown> {
    const game = this.getGame(gameId);
    const moves = this.listMoves(gameId);
    return {
      gameId: game.id,
      rulesVersion: game.rulesVersion,
      version: game.version,
      createdAt: game.createdAt,
      initialBoard: game.initialBoard,
      currentState: game.state,
      moves: moves.map((m) => ({
        seq: m.seq,
        requestId: m.requestId,
        player: m.player,
        pit: m.pit,
        report: m.report,
        createdAt: m.createdAt,
      })),
    };
  }
}

function rowToMove(row: Record<string, unknown>): MoveRow {
  return {
    seq: row.seq as number,
    requestId: row.request_id as string,
    player: row.player as Player,
    pit: row.pit as number,
    report: JSON.parse(row.report_json as string) as MoveReport,
    stateBefore: JSON.parse(row.state_before_json as string) as GameState,
    stateAfter: JSON.parse(row.state_after_json as string) as GameState,
    createdAt: row.created_at as string,
  };
}
