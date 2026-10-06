/**
 * HTTP API（node:http，无外部依赖）。
 * 默认端口 0（操作系统分配空闲端口），可用 --port 或 PORT 覆盖。
 */
import http from "node:http";
import path from "node:path";
import { KalahStore, StoreError } from "./store.js";
import { legalPits, labelOf, parsePitLabel, type Player } from "./rules.js";

const DEFAULT_DB = path.join(process.cwd(), "data", "kalah.db");

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

function error(res: http.ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { error: { code, message } });
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new StoreError("VALIDATION", "请求体不是合法 JSON");
  }
}

function gameView(store: KalahStore, id: string) {
  const g = store.getGame(id);
  return {
    gameId: g.id,
    rulesVersion: g.rulesVersion,
    version: g.version,
    board: g.state.board,
    boardLabels: g.state.board.map((v, i) => ({ position: i, label: labelOf(i), seeds: v })),
    currentPlayer: g.state.currentPlayer,
    gameOver: g.state.gameOver,
    winner: g.state.winner,
    legalPits: legalPits(g.state).map((i) => ({ position: i, label: labelOf(i) })),
  };
}

export function createServer(store: KalahStore): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        return json(res, 200, { ok: true });
      }

      // POST /games  { board?: number[14] }
      if (method === "POST" && parts.length === 1 && parts[0] === "games") {
        const body = (await readBody(req)) as { board?: unknown };
        const game = store.createGame(body.board);
        return json(res, 201, gameView(store, game.id));
      }

      if (parts[0] === "games" && parts.length >= 2) {
        const id = parts[1];
        const sub = parts[2];

        // GET /games/:id
        if (method === "GET" && parts.length === 2) {
          return json(res, 200, gameView(store, id));
        }
        // GET /games/:id/legal-pits
        if (method === "GET" && sub === "legal-pits") {
          const g = store.getGame(id);
          return json(res, 200, {
            gameId: id,
            currentPlayer: g.state.currentPlayer,
            legalPits: legalPits(g.state).map((i) => ({ position: i, label: labelOf(i) })),
          });
        }
        // POST /games/:id/moves  { player, pit, expectedVersion, requestId }
        if (method === "POST" && sub === "moves") {
          const body = (await readBody(req)) as Record<string, unknown>;
          const player = body.player as Player;
          let pit: number;
          if (typeof body.pit === "number") {
            pit = body.pit;
          } else if (typeof body.pit === "string") {
            const parsed = parsePitLabel(body.pit);
            if (parsed === null) throw new StoreError("INVALID_PIT", `无法识别的坑位：${body.pit}`);
            pit = parsed;
          } else {
            throw new StoreError("VALIDATION", "缺少坑位 pit（下标 0..13 或编号如 A3）");
          }
          const result = store.playMove(
            id,
            player,
            pit,
            body.expectedVersion as number,
            body.requestId as string,
          );
          return json(res, result.idempotentReplay ? 200 : 201, {
            idempotentReplay: result.idempotentReplay,
            move: result.move.report,
            seq: result.move.seq,
            game: gameView(store, id),
          });
        }
        // POST /games/:id/undo
        if (method === "POST" && sub === "undo") {
          const { undone } = store.undo(id);
          return json(res, 200, {
            undoneSeq: undone.seq,
            game: gameView(store, id),
          });
        }
        // GET /games/:id/replay?to=N
        if (method === "GET" && sub === "replay") {
          const to = url.searchParams.has("to") ? Number(url.searchParams.get("to")) : undefined;
          const r = store.replay(id, to);
          return json(res, 200, {
            gameId: id,
            step: r.step,
            totalSteps: r.totalSteps,
            board: r.state.board,
            boardLabels: r.state.board.map((v, i) => ({
              position: i,
              label: labelOf(i),
              seeds: v,
            })),
            currentPlayer: r.state.currentPlayer,
            gameOver: r.state.gameOver,
            winner: r.state.winner,
          });
        }
        // GET /games/:id/moves  历史动作（只读）
        if (method === "GET" && sub === "moves") {
          const moves = store.listMoves(id);
          return json(res, 200, {
            gameId: id,
            moves: moves.map((m) => ({ seq: m.seq, requestId: m.requestId, report: m.report })),
          });
        }
        // GET /games/:id/export
        if (method === "GET" && sub === "export") {
          return json(res, 200, store.exportGame(id));
        }
      }

      return error(res, 404, "NOT_FOUND", `未知路由：${method} ${url.pathname}`);
    } catch (e) {
      if (e instanceof StoreError) return error(res, e.httpStatus, e.code, e.message);
      return error(res, 500, "INTERNAL", e instanceof Error ? e.message : String(e));
    }
  });
}

export function parsePort(argv: string[]): number {
  const idx = argv.indexOf("--port");
  if (idx >= 0 && argv[idx + 1]) return Number(argv[idx + 1]);
  if (process.env.PORT) return Number(process.env.PORT);
  return 0; // 默认：操作系统分配空闲端口
}

export function dbPathFromArgs(argv: string[]): string {
  const idx = argv.indexOf("--db");
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1];
  if (process.env.KALAH_DB) return process.env.KALAH_DB;
  return DEFAULT_DB;
}

export function startServer(argv: string[] = process.argv.slice(2)): http.Server {
  const store = new KalahStore(dbPathFromArgs(argv));
  const server = createServer(store);
  const port = parsePort(argv);
  server.listen(port, () => {
    const addr = server.address();
    const actual = typeof addr === "object" && addr ? addr.port : port;
    console.log(`Kalah API 已启动: http://localhost:${actual}`);
  });
  return server;
}

// 直接运行（node dist/src/server.js）时启动服务
const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file:///${path.resolve(process.argv[1]).replace(/\\/g, "/")}`).href;
if (invokedDirectly) {
  startServer();
}
