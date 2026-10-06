# Kalah 播子棋后端（TypeScript + Node.js + SQLite）

双人 Kalah(6,6,4) 播子棋的本地后端：HTTP API + CLI，规则引擎、持久层、回放与导出一应俱全。
只做后端，不做电脑选招、联网匹配或其他 Mancala 变体。Windows 本地直接运行，不依赖 Docker / WSL / 外部服务。

## 固定编号（API、CLI、README 共用，永不随当前玩家翻转）

```
            B6  B5  B4  B3  B2  B1
   B仓(13) | 12  11  10  9   8   7 | (6) A仓
            A1  A2  A3  A4  A5  A6
             0   1   2   3   4   5
```

- 下标 `0..5` = `A1..A6`（A 方普通坑），下标 `6` = `A仓`
- 下标 `7..12` = `B1..B6`（B 方普通坑），下标 `13` = `B仓`
- 播撒环形顺序：`A1→…→A6→A仓→B1→…→B6→B仓→A1→…`
- 普通坑下标 `i` 的正对面是 `12 - i`（如 `A2`(1) 对面是 `B5`(11)）

## 固定变体规则（规则版本 `kalah-6x4-v1`）

1. 每方 6 个普通坑 + 1 个得分仓；初始每普通坑 4 子、两仓为空，A 先走。
2. 玩家只能选择**自己有子的普通坑**；拿起该坑全部子，从下一个位置起沿环形顺序**逐颗**播撒。
3. 经过**对手得分仓时跳过**，自己的得分仓照常计入；子数多于一圈继续播，不遗漏、不重复拿起。
4. 最后一颗落在**自己的仓** → 获得额外回合（仍由自己行动）。
5. 最后一颗落在**自己原本为空的普通坑**，且**正对面坑有子** → 把这 1 颗与对面全部子收进自己的仓，对面坑清空。
   落在对方普通坑、自己的非空坑、或对面为空，均不触发取子。
6. 一次播撒与取子完成后，任意一方六个普通坑全空 → **对局立即结束**（终局优先于额外回合），
   另一方普通坑剩余子全部归入其得分仓，按仓内子数定胜负或平局；结束后不再接受落子。
7. 错误玩家、空坑、得分仓编号、对方坑一律拒绝且**完全不改盘面**。
8. 每步记录：拿起数量、逐颗经过位置、最后落点、取子明细、下位玩家、终局归仓；全盘面子数始终守恒。

## 安装与命令

要求：Node.js ≥ 22.5（使用内置 `node:sqlite`，开发验证于 Node 25），无运行时第三方依赖。

```bash
npm install        # 仅安装 typescript / @types/node（开发依赖）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 HTTP API（默认随机空闲端口；--port N 或 PORT 指定）
npm run cli -- ... # 等价于 node dist/src/cli.js ...
npm run demo       # 可复现演示对局
```

数据目录为项目内 `data/`（默认 `data/kalah.db`），可用 `--db <路径>` 或环境变量 `KALAH_DB` 覆盖。重启后对局可继续。

## HTTP API

`npm start`（或 `node dist/src/cli.js serve --port 8080`）。未指定端口时由操作系统分配空闲端口并打印实际地址。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/games` | 开局。Body 可带 `board: number[14]` 导入受限教学盘面 |
| GET | `/games/:id` | 查看盘面（含公开编号与合法坑） |
| GET | `/games/:id/legal-pits` | 查询当前玩家合法坑 |
| POST | `/games/:id/moves` | 落子。Body：`{player, pit, expectedVersion, requestId}`，`pit` 接受下标或 `"A3"` 编号 |
| GET | `/games/:id/moves` | 历史动作（只读，含每步完整报告） |
| GET | `/games/:id/replay?to=N` | 回放至第 N 步（0 = 初始盘面；缺省为最新） |
| POST | `/games/:id/undo` | 撤销末步（完整还原当前玩家、终局标志、各坑与仓） |
| GET | `/games/:id/export` | 导出完整对局 JSON（初始盘面、规则版本、全部动作） |
| GET | `/health` | 健康检查 |

落子并发与重试语义：

- `expectedVersion` 与当前版本不一致 → `409 VERSION_CONFLICT`（乐观锁）。
- 同一对局内相同 `requestId` 重复提交 → 返回首次结果 `idempotentReplay: true`，**不会重复播子**。
- 动作与快照在同一 SQLite 事务内原子写入。

### 错误码

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `VALIDATION` | 参数缺失或格式错误 |
| 404 | `GAME_NOT_FOUND` / `NOT_FOUND` | 对局或路由不存在 |
| 409 | `VERSION_CONFLICT` | 期望版本过期 |
| 422 | `WRONG_PLAYER` / `INVALID_PLAYER` | 行动方错误 / 玩家非法 |
| 422 | `EMPTY_PIT` / `STORE_PIT` / `NOT_OWN_PIT` / `INVALID_PIT` | 坑位非法（拒绝且不改盘面） |
| 422 | `GAME_OVER` | 对局已结束 |
| 422 | `ILLEGAL_IMPORT` | 导入盘面非法（非 14 个非负整数、总子数 > 48、全空、或已为终局形态） |
| 400 | `NOTHING_TO_UNDO` | 没有可撤销的动作 |

## CLI

```bash
node dist/src/cli.js new [--board "4,4,4,4,4,4,0,4,4,4,4,4,4,0"]
node dist/src/cli.js list
node dist/src/cli.js board <gameId>
node dist/src/cli.js legal <gameId>
node dist/src/cli.js move <gameId> A A3 [--expected-version 0] [--request-id r1]
node dist/src/cli.js replay <gameId> [step]
node dist/src/cli.js undo <gameId>
node dist/src/cli.js export <gameId>
node dist/src/cli.js serve [--port N]
node dist/src/cli.js demo
```

棋盘以两排坑 + 两侧得分仓的文本表展示（上排固定为 `B6..B1`，下排固定为 `A1..A6`）。

## 可复现完整对局

`npm run demo` 使用默认开局固定走 `A3 → A6 → B3`：

1. **A 落 A3**：拿起 4 颗，路径 `A4→A5→A6→A仓`，最后一颗入自己仓 → 额外回合，A仓 = 1。
2. **A 落 A6**：拿起 5 颗，路径 `A仓→B1→B2→B3→B4`，落对方普通坑不取子，轮到 B。
3. **B 落 B3**：拿起 5 颗，路径 `B4→B5→B6→B仓→A1`，经过自己仓计入，轮到 A。

每一步均可通过 `replay` 逐步回放核对；测试中还用小盘面分别演示对面取子、多圈跳过对方仓、
终局归仓、撤销终局、平局与非法导入（见 `test/kalah.test.ts`）。

## 项目结构

```
src/rules.ts   纯函数规则引擎（固定编号、播撒、取子、终局）
src/store.ts   SQLite 持久层（开局、落子、幂等、撤销、回放、导出）
src/server.ts  HTTP API（node:http）
src/cli.ts     CLI 与文本棋盘、演示对局
test/          node:test 测试
scripts/smoke-api.mjs  API 冒烟脚本
data/          SQLite 数据目录（运行时生成）
```

## 已知限制

- `node:sqlite` 在 Node 25 仍标记为实验特性；Windows 上进程退出时可能打印一条无害的
  `Assertion failed: ... win\async.c` 告警（退出码仍为 0，数据已落盘）。
- 单进程服务，未做鉴权；面向本机教学与回放场景。
- 导入教学盘面仅做受限校验（非负整数、总数 ≤ 48、非终局形态），不保证可由默认开局到达。
