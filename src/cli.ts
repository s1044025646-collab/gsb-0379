#!/usr/bin/env node
import { resolve } from "node:path";
import { openDatabase } from "./db.js";
import { GameService, VersionConflict } from "./service.js";
import { startServer } from "./server.js";
import { describeMove, GameError, RULE_VERSION, totalStones } from "./engine.js";
import { renderBoard } from "./render.js";

const DATA_DIR = resolve(process.cwd(), "data");
const DB_FILE = resolve(DATA_DIR, "kalah.db");

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function usage(): string {
  return [
    "Kalah 播子棋后端 CLI（固定编号 A1..A6 / B1..B6，A 先走）",
    "",
    "用法：",
    "  kalah serve [--port 0] [--db data/kalah.db]   启动 HTTP API（默认端口 0=自动选空闲端口）",
    "  kalah new [--pits 4,4,...14个数] [--turn A]   开局（默认 4 子）或导入受限教学盘面",
    "  kalah list                                    列出对局",
    "  kalah show <gameId>                           查看盘面",
    "  kalah legal <gameId>                          查询当前合法坑",
    "  kalah move <gameId> --player A --pit A3 --expected-version 0 [--req-id r1]",
    "  kalah replay <gameId> --step 2                回放至第 N 步（0=初始盘面）",
    "  kalah undo <gameId>                           撤销末步",
    "  kalah export <gameId>                         导出对局 JSON",
    "",
    `规则版本：${RULE_VERSION}`,
  ].join("\n");
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  if (!command || command === "help" || command === "--help") {
    console.log(usage());
    return;
  }

  const dbFile = flags.db ? resolve(flags.db) : DB_FILE;
  const db = openDatabase(dbFile);
  const service = new GameService(db);

  try {
    switch (command) {
      case "serve": {
        const port = Number(flags.port ?? process.env.PORT ?? 0);
        const running = await startServer(service, port);
        console.log(`Kalah API 已启动：http://127.0.0.1:${running.port}`);
        console.log(`数据库：${dbFile}`);
        const shutdown = async () => {
          await running.close();
          db.close();
          process.exit(0);
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
        break;
      }
      case "new": {
        const initial = flags.pits
          ? { pits: flags.pits.split(",").map((s) => Number(s.trim())), turn: (flags.turn ?? "A") as "A" | "B" }
          : undefined;
        const view = service.createGame(initial);
        console.log(`已创建对局 ${view.id}（规则 ${view.ruleVersion}，版本 ${view.version}）`);
        console.log(renderBoard(view.state));
        break;
      }
      case "list": {
        const games = service.list();
        if (games.length === 0) console.log("（无对局）");
        for (const g of games) {
          console.log(`${g.id}  version=${g.version}  ${g.gameOver ? "已结束" : "进行中"}`);
        }
        break;
      }
      case "show": {
        const view = service.view(requireId(positional));
        console.log(`对局 ${view.id}  版本 ${view.version}  规则 ${view.ruleVersion}`);
        console.log(renderBoard(view.state));
        console.log(`合法坑：${view.legalPits.join(" ") || "（无）"}  总子数=${totalStones(view.state.pits)}`);
        break;
      }
      case "legal": {
        const view = service.view(requireId(positional));
        console.log(view.legalPits.join(" ") || "（无合法坑）");
        break;
      }
      case "move": {
        const id = requireId(positional);
        const result = service.move(
          id,
          requireFlag(flags, "player"),
          requireFlag(flags, "pit"),
          Number(requireFlag(flags, "expected-version")),
          flags["req-id"] ?? null
        );
        if (result.duplicated) console.log("重复请求：返回首次结果，未重复播子。");
        for (const line of describeMove(result.detail)) console.log(line);
        console.log(renderBoard(result.view.state));
        console.log(`新版本=${result.view.version} 总子数=${totalStones(result.view.state.pits)}`);
        break;
      }
      case "replay": {
        const id = requireId(positional);
        const step = Number(flags.step ?? "0");
        const result = service.replay(id, step);
        console.log(`回放至第 ${step} 步（总子数=${totalStones(result.state.pits)}）`);
        console.log(renderBoard(result.state));
        if (result.detail) {
          console.log("--- 该步说明 ---");
          for (const line of describeMove(result.detail)) console.log(line);
        }
        break;
      }
      case "undo": {
        const view = service.undo(requireId(positional));
        console.log("已撤销末步，盘面已完整还原：");
        console.log(renderBoard(view.state));
        console.log(`版本=${view.version} 总子数=${totalStones(view.state.pits)}`);
        break;
      }
      case "export": {
        console.log(JSON.stringify(service.exportGame(requireId(positional)), null, 2));
        break;
      }
      default:
        console.error(`未知命令：${command}\n`);
        console.log(usage());
        process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof GameError) {
      console.error(`错误 [${err.code}] ${err.message}`);
      if (err instanceof VersionConflict) process.exitCode = 2;
      else process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    if (command !== "serve") db.close();
  }
}

function requireId(positional: string[]): string {
  const id = positional[1];
  if (!id) throw new GameError("MISSING_ARG", "缺少对局 id");
  return id;
}

function requireFlag(flags: Record<string, string>, key: string): string {
  const value = flags[key];
  if (value === undefined) throw new GameError("MISSING_ARG", `缺少必填参数 --${key}`);
  return value;
}

main();
