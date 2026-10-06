/**
 * CLI：与 HTTP API 共用同一套规则引擎、持久层与固定编号。
 *
 * 用法：
 *   node dist/src/cli.js new [--board "4,4,4,4,4,4,0,4,4,4,4,4,4,0"]
 *   node dist/src/cli.js board <gameId>
 *   node dist/src/cli.js legal <gameId>
 *   node dist/src/cli.js move <gameId> <A|B> <坑位，如 A3> [--expected-version N] [--request-id R]
 *   node dist/src/cli.js replay <gameId> [step]
 *   node dist/src/cli.js undo <gameId>
 *   node dist/src/cli.js export <gameId>
 *   node dist/src/cli.js list
 *   node dist/src/cli.js serve [--port N]
 *   node dist/src/cli.js demo
 */
import path from "node:path";
import { KalahStore } from "./store.js";
import { startServer } from "./server.js";
import {
  legalPits,
  labelOf,
  parsePitLabel,
  STORE_A,
  STORE_B,
  type GameState,
  type MoveReport,
  type Player,
} from "./rules.js";

const DEFAULT_DB = path.join(process.cwd(), "data", "kalah.db");

function dbPath(argv: string[]): string {
  const idx = argv.indexOf("--db");
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1];
  return process.env.KALAH_DB ?? DEFAULT_DB;
}

function opt(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

/** 两排坑 + 两侧得分仓的文本表（固定编号：上方 B6..B1，下方 A1..A6） */
export function renderBoard(board: number[]): string {
  const b = board;
  const cell = (n: number) => String(n).padStart(3);
  const top = b.slice(7, 13).reverse(); // B6 B5 B4 B3 B2 B1
  const bottom = b.slice(0, 6); // A1..A6
  const topLabels = ["B6", "B5", "B4", "B3", "B2", "B1"].map((s) => s.padStart(3)).join(" ");
  const bottomLabels = ["A1", "A2", "A3", "A4", "A5", "A6"].map((s) => s.padStart(3)).join(" ");
  return [
    `        ${topLabels}`,
    `B仓${cell(b[STORE_B])} | ${top.map(cell).join(" ")} | ${cell(b[STORE_A])} A仓`,
    `        ${bottomLabels}`,
    `             ${bottom.map(cell).join(" ")}`,
  ].join("\n");
}

function renderState(state: GameState): string {
  const lines = [renderBoard(state.board)];
  if (state.gameOver) {
    const w = state.winner === "draw" ? "平局" : `${state.winner} 胜`;
    lines.push(`对局已结束：${w}（A仓 ${state.board[STORE_A]} : B仓 ${state.board[STORE_B]}）`);
  } else {
    lines.push(`当前行动方：${state.currentPlayer}`);
    lines.push(`合法坑：${legalPits(state).map(labelOf).join(", ") || "（无）"}`);
  }
  return lines.join("\n");
}

function renderMoveReport(r: MoveReport): string {
  const lines = [
    `第 ${r.player} 方落子 ${r.pitLabel}，拿起 ${r.pickedUp} 颗`,
    `播撒路径：${r.pathLabels.join(" → ")}`,
    `最后落点：${r.lastPositionLabel}`,
  ];
  if (r.capture) {
    lines.push(
      `对面取子：${r.capture.landingLabel} 原本为空，取走正对面 ${r.capture.oppositeLabel} 的 ${r.capture.capturedFromOpposite} 颗，共 ${r.capture.totalToStore} 颗收入 ${r.player}仓`,
    );
  }
  if (r.extraTurn) lines.push("最后一颗落入自己的仓，获得额外回合");
  if (r.endgame) {
    const c = r.endgame;
    const detail = c.collected.map((x) => `${x.label}(${x.seeds})`).join(" ") || "无剩余";
    lines.push(
      `终局归仓：${c.emptiedSide} 方普通坑已空，${detail} 共 ${c.collectedTotal} 颗归入 ${c.intoStoreLabel}`,
    );
  }
  if (r.gameOver) {
    lines.push(`对局结束：${r.winner === "draw" ? "平局" : `${r.winner} 胜`}`);
  } else {
    lines.push(`下位玩家：${r.nextPlayer}`);
  }
  return lines.join("\n");
}

function parseBoardArg(text: string): number[] {
  return text.split(",").map((s) => Number(s.trim()));
}

/** 可复现演示对局：默认开局 A 先走 A3（落自己仓、额外回合），再走 A6 */
function runDemo(store: KalahStore): void {
  const game = store.createGame();
  console.log(`演示对局 ${game.id}（默认开局，A 先走）\n`);
  console.log(renderState(game.state));
  const script: [Player, string][] = [
    ["A", "A3"],
    ["A", "A6"],
    ["B", "B3"],
  ];
  let version = game.version;
  for (const [player, label] of script) {
    const pit = parsePitLabel(label)!;
    const { move } = store.playMove(game.id, player, pit, version, `demo-${version}`);
    version++;
    console.log(`\n--- 第 ${move.seq} 步 ---`);
    console.log(renderMoveReport(move.report));
    console.log(renderState(move.stateAfter));
  }
}

export function runCli(argv: string[]): void {
  const [cmd, ...rest] = argv;
  if (cmd === "serve") {
    startServer(rest);
    return;
  }
  const store = new KalahStore(dbPath(rest));
  try {
    switch (cmd) {
      case "new": {
        const boardArg = opt(rest, "--board");
        const game = store.createGame(boardArg ? parseBoardArg(boardArg) : undefined);
        console.log(`新对局：${game.id}（规则版本 ${game.rulesVersion}）`);
        console.log(renderState(game.state));
        break;
      }
      case "list": {
        for (const g of store.listGames()) {
          console.log(
            `${g.id}  版本${g.version}  ${g.state.gameOver ? `已结束(${g.state.winner})` : `轮到${g.state.currentPlayer}`}  ${g.createdAt}`,
          );
        }
        break;
      }
      case "board": {
        const game = store.getGame(rest[0]);
        console.log(renderState(game.state));
        break;
      }
      case "legal": {
        const game = store.getGame(rest[0]);
        console.log(
          game.state.gameOver
            ? "对局已结束，无合法坑"
            : `${game.state.currentPlayer} 可落子：${legalPits(game.state).map(labelOf).join(", ")}`,
        );
        break;
      }
      case "move": {
        const [gameId, player, pitLabel] = rest;
        const pit = parsePitLabel(pitLabel ?? "");
        if (pit === null) throw new Error(`无法识别的坑位：${pitLabel}（应为 A1..A6 或 B1..B6）`);
        const game = store.getGame(gameId);
        const expected = opt(rest, "--expected-version");
        const requestId = opt(rest, "--request-id") ?? `cli-${Date.now()}`;
        const { move, idempotentReplay } = store.playMove(
          gameId,
          player as Player,
          pit,
          expected ? Number(expected) : game.version,
          requestId,
        );
        if (idempotentReplay) console.log("（重复请求编号，返回首次结果，未再次播子）");
        console.log(renderMoveReport(move.report));
        console.log(renderState(store.getGame(gameId).state));
        break;
      }
      case "replay": {
        const [gameId, stepArg] = rest;
        const r = store.replay(gameId, stepArg === undefined ? undefined : Number(stepArg));
        console.log(`回放至第 ${r.step} 步（共 ${r.totalSteps} 步）`);
        console.log(renderState(r.state));
        break;
      }
      case "undo": {
        const { undone, game } = store.undo(rest[0]);
        console.log(`已撤销第 ${undone.seq} 步（${undone.player} 落 ${labelOf(undone.pit)}）`);
        console.log(renderState(game.state));
        break;
      }
      case "export": {
        console.log(JSON.stringify(store.exportGame(rest[0]), null, 2));
        break;
      }
      case "demo": {
        runDemo(store);
        break;
      }
      default:
        console.log(
          "命令：new | list | board | legal | move | replay | undo | export | serve | demo\n用 --help 查看源文件头部注释了解参数。",
        );
    }
  } finally {
    store.close();
  }
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === new URL(`file:///${path.resolve(process.argv[1]).replace(/\\/g, "/")}`).href;
if (invokedDirectly) {
  try {
    runCli(process.argv.slice(2));
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error(`错误：${msg}`);
    process.exitCode = 1;
  }
}
