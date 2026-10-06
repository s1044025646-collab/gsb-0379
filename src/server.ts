import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { GameError } from "./engine.js";
import { GameService, VersionConflict } from "./service.js";

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(json);
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (raw.trim() === "") return {};
  return JSON.parse(raw);
}

export interface RunningServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

export function startServer(service: GameService, port = 0, host = "127.0.0.1"): Promise<RunningServer> {
  const server = createServer(async (req, res) => {
    try {
      await handle(req, res, service);
    } catch (err) {
      if (err instanceof SyntaxError) {
        send(res, 400, errorBody("INVALID_JSON", "请求体不是合法 JSON"));
      } else if (err instanceof GameError) {
        send(res, err instanceof VersionConflict ? 409 : 400, errorBody(err.code, err.message));
      } else {
        send(res, 500, errorBody("INTERNAL", (err as Error).message));
      }
    }
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const actual = (server.address() as AddressInfo).port;
      resolve({
        server,
        port: actual,
        close: () =>
          new Promise<void>((r, j) =>
            server.close((e) => (e ? j(e) : r()))
          ),
      });
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, service: GameService): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/health") {
    send(res, 200, { ok: true });
    return;
  }

  if (method === "POST" && path === "/games") {
    const body = await readJson(req);
    const view = service.createGame(
      body && (body.pits || body.turn) ? { pits: body.pits, turn: body.turn } : undefined
    );
    send(res, 201, view);
    return;
  }

  if (method === "GET" && path === "/games") {
    send(res, 200, { games: service.list() });
    return;
  }

  const gameMatch = /^\/games\/([^/]+)(\/(moves|replay|undo|export))?$/.exec(path);
  if (!gameMatch) {
    send(res, 404, errorBody("NOT_FOUND", `无此路由：${method} ${path}`));
    return;
  }
  const gameId = decodeURIComponent(gameMatch[1]);
  const sub = gameMatch[3];

  if (!sub && method === "GET") {
    send(res, 200, service.view(gameId));
    return;
  }
  if (sub === "moves" && method === "GET") {
    send(res, 200, { moves: service.history(gameId) });
    return;
  }
  if (sub === "export" && method === "GET") {
    send(res, 200, service.exportGame(gameId));
    return;
  }
  if (sub === "replay" && method === "GET") {
    const step = Number(url.searchParams.get("step") ?? "0");
    send(res, 200, service.replay(gameId, step));
    return;
  }
  if (sub === "undo" && method === "POST") {
    send(res, 200, service.undo(gameId));
    return;
  }
  if (sub === "moves" && method === "POST") {
    const body = await readJson(req);
    const result = service.move(
      gameId,
      body.player,
      body.pit,
      Number(body.expectedVersion),
      typeof body.reqId === "string" && body.reqId ? body.reqId : null
    );
    send(res, result.duplicated ? 200 : 201, {
      duplicated: result.duplicated,
      detail: result.detail,
      game: result.view,
    });
    return;
  }
  send(res, 404, errorBody("NOT_FOUND", `无此路由：${method} ${path}`));
}
