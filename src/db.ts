import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { BoardState, MoveDetail } from "./engine.js";

export interface GameRow {
  id: string;
  rule_version: string;
  version: number;
  pits: string;
  turn: "A" | "B";
  game_over: 0 | 1;
  winner: string | null;
  initial_pits: string;
  initial_turn: "A" | "B";
  created_at: string;
}

export interface MoveRow {
  id: number;
  game_id: string;
  seq: number;
  player: "A" | "B";
  pit_index: number;
  detail: string;
  req_id: string | null;
  before_version: number;
  after_version: number;
}

export function openDatabase(filePath: string): DatabaseSync {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      rule_version TEXT NOT NULL,
      version INTEGER NOT NULL,
      pits TEXT NOT NULL,
      turn TEXT NOT NULL,
      game_over INTEGER NOT NULL,
      winner TEXT,
      initial_pits TEXT NOT NULL,
      initial_turn TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS moves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      player TEXT NOT NULL,
      pit_index INTEGER NOT NULL,
      detail TEXT NOT NULL,
      req_id TEXT,
      before_version INTEGER NOT NULL,
      after_version INTEGER NOT NULL,
      UNIQUE(game_id, req_id)
    );
    CREATE INDEX IF NOT EXISTS idx_moves_game_seq ON moves(game_id, seq);
  `);
  return db;
}

export function insertGame(db: DatabaseSync, row: GameRow): void {
  db.prepare(
    `INSERT INTO games
       (id, rule_version, version, pits, turn, game_over, winner, initial_pits, initial_turn, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.rule_version,
    row.version,
    row.pits,
    row.turn,
    row.game_over,
    row.winner,
    row.initial_pits,
    row.initial_turn,
    row.created_at
  );
}

export function getGame(db: DatabaseSync, id: string): GameRow | null {
  return (db.prepare("SELECT * FROM games WHERE id = ?").get(id) as GameRow | undefined) ?? null;
}

export function listGames(db: DatabaseSync): GameRow[] {
  return db.prepare("SELECT * FROM games ORDER BY created_at").all() as unknown as GameRow[];
}

export function getMoves(db: DatabaseSync, gameId: string): MoveRow[] {
  return db
    .prepare("SELECT * FROM moves WHERE game_id = ? ORDER BY seq")
    .all(gameId) as unknown as MoveRow[];
}

export function getMoveByReqId(db: DatabaseSync, gameId: string, reqId: string): MoveRow | null {
  return (
    (db.prepare("SELECT * FROM moves WHERE game_id = ? AND req_id = ?").get(gameId, reqId) as
      | MoveRow
      | undefined) ?? null
  );
}

export function getMoveAtSeq(db: DatabaseSync, gameId: string, seq: number): MoveRow | null {
  return (
    (db.prepare("SELECT * FROM moves WHERE game_id = ? AND seq = ?").get(gameId, seq) as
      | MoveRow
      | undefined) ?? null
  );
}

// 原子写入：一条动作记录 + 快照更新同时成功或同时回滚。
export function commitMove(
  db: DatabaseSync,
  gameId: string,
  state: BoardState,
  detail: MoveDetail,
  seq: number,
  beforeVersion: number,
  afterVersion: number,
  reqId: string | null
): void {
  const update = db.prepare(`
    UPDATE games SET pits = ?, turn = ?, game_over = ?, winner = ?, version = ? WHERE id = ?
  `);
  const insert = db.prepare(`
    INSERT INTO moves
      (game_id, seq, player, pit_index, detail, req_id, before_version, after_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    update.run(
      JSON.stringify(state.pits),
      state.turn,
      state.gameOver ? 1 : 0,
      state.winner,
      afterVersion,
      gameId
    );
    insert.run(
      gameId,
      seq,
      detail.player,
      detail.pitIndex,
      JSON.stringify(detail),
      reqId,
      beforeVersion,
      afterVersion
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// 撤销末步：删除最后一条动作并将快照还原到上一步之后（用动作记录中的 before）。
export function rollbackLastMove(db: DatabaseSync, gameId: string): MoveRow | null {
  const moves = getMoves(db, gameId);
  if (moves.length === 0) return null;
  const last = moves[moves.length - 1];
  const detail = JSON.parse(last.detail) as MoveDetail;
  const restoreToVersion = last.before_version;
  const turn = moves.length === 1
    ? (getGame(db, gameId) as GameRow).initial_turn
    : (JSON.parse((moves[moves.length - 2].detail) as string) as MoveDetail).nextPlayer;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM moves WHERE id = ?").run(last.id);
    db.prepare(
      "UPDATE games SET pits = ?, turn = ?, game_over = 0, winner = NULL, version = ? WHERE id = ?"
    ).run(JSON.stringify(detail.before), turn, restoreToVersion, gameId);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return last;
}

export function rowToState(row: GameRow): BoardState {
  return {
    pits: JSON.parse(row.pits) as number[],
    turn: row.turn,
    gameOver: row.game_over === 1,
    winner: (row.winner as BoardState["winner"]) ?? null,
  };
}

export function rowInitialState(row: GameRow): BoardState {
  return {
    pits: JSON.parse(row.initial_pits) as number[],
    turn: row.initial_turn,
    gameOver: false,
    winner: null,
  };
}

