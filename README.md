# Kalah 播子棋后端（TypeScript + Node.js + SQLite）

Windows 本地可运行的双人 Kalah 播子棋**落子与对面取子回放后端**，只提供 HTTP API 与命令行（CLI），
不含电脑选招、联网匹配或其他 Mancala 变体。数据保存在项目内 `data/` 目录的 SQLite 文件中，重启后可继续对局。

## 1. 运行环境

- Node.js **>= 22.5**（开发与验证使用 Node v25.5.0）。使用 Node 内置实验模块 `node:sqlite`，无需编译原生模块。
- 无需 Docker、WSL、付费服务或外部在线 API。
- 安装依赖（仅 `typescript` 与 `@types/node`）：

```powershell
npm install
```

## 2. 固定编号示意（API 与 CLI 完全一致，绝不随当前玩家翻转）

内部按固定环形顺序排列，下标写在括号中：

```
   A1(0)  A2(1)  A3(2)  A4(3)  A5(4)  A6(5)
                                              A仓(6)
   B1(7)  B2(8)  B3(9)  B4(10) B5(11) B6(12)
                                              B仓(13)
```

- 环形播撒顺序：`A1 → A2 → … → A6 → A仓 → B1 → … → B6 → B仓 → 回到 A1`。
- 每方六个普通坑 + 一个得分仓；开局每个普通坑 4 颗，两个仓为空；**A 先走**。
- 普通坑下标 `i` 的正对面固定为 **`12 - i`**（例如 `A3` 下标 2 ↔ `B4` 下标 10；`A1` ↔ `B6`）。
- 编号含义对 A、B 两名玩家始终相同：B 行动时 `A3` 仍然是 A 方第三坑，不会“镜像翻转”。

规则版本固定为 `kalah-6-4-v1`，随每局与导出一并记录。

## 3. 规则

1. **合法落子**：只能选择**自己**一侧**有子**的普通坑（A：`A1..A6`；B：`B1..B6`）。
   错误玩家、空坑、得分仓编号、越界或对方坑编号一律拒绝，且**完全不改盘面**。
2. **逐颗播撒**：拿起该坑全部子，从下一个位置起逐颗放入。
   - 经过**对手**得分仓时**跳过**（该颗继续投到下一位置）；自己的得分仓照常计入。
   - 子数多于一圈时继续绕圈播，不遗漏、不重新拿起途中已放的子。
3. **额外回合**：最后一颗落入**自己的得分仓**，仍由自己行动。
4. **对面取子**：最后一颗同时满足以下全部条件才取子——
   - 落入自己一方的普通坑；
   - 该坑在落入前为空（即本次只落入这一颗，落入坑内总数恰为 1）；
   - 其正对面坑 `12-i` 内**有子**。

   满足后把“最后这 1 颗 + 对面全部子”收进自己的得分仓，并清空两个普通坑。
   最后落在对方普通坑、自己的非空坑、或对面为空，都**不**取子。
5. **终局归仓**：一次播撒/取子完成后，若任一方六个普通坑全空，对局**立即结束**，
   把另一方普通坑中剩余子全部归入其得分仓；按两仓子数判定 `A` / `B` 获胜或 `DRAW` 平局。
   **终局优先于额外回合**，结束后不再接受落子。
6. 全部 48 颗（教学盘面为导入数量）棋子始终守恒；普通播撒不会减少任何一个得分仓的子。
7. **教学盘面导入**：允许导入任意 0..100 非负整数的 14 槽盘面与先手（`A`/`B`），
   不要求它能由默认开局到达；终局只在落子结算后判定，不在导入时提前归仓。

## 4. 构建、测试、启动、演示

```powershell
npm run build     # TypeScript 编译到 dist/
npm test          # 编译并运行 node:test（22 个用例）
npm start         # 启动 HTTP API（默认端口 0 = 自动选择空闲端口，仅监听 127.0.0.1）
npm run demo      # 固定可复现的六个教学演示
```

可配置端口（默认自动选空闲端口）：

```powershell
node --experimental-sqlite dist/src/cli.js serve --port 8080
# 或
$env:PORT=8080; npm start
```

## 5. CLI

```powershell
node --experimental-sqlite dist/src/cli.js new
node --experimental-sqlite dist/src/cli.js new --pits 0,1,0,1,1,1,0,1,1,1,9,1,1,0 --turn A
node --experimental-sqlite dist/src/cli.js list
node --experimental-sqlite dist/src/cli.js show <gameId>
node --experimental-sqlite dist/src/cli.js legal <gameId>
node --experimental-sqlite dist/src/cli.js move <gameId> --player A --pit A3 --expected-version 0 --req-id r1
node --experimental-sqlite dist/src/cli.js replay <gameId> --step 2
node --experimental-sqlite dist/src/cli.js undo <gameId>
node --experimental-sqlite dist/src/cli.js export <gameId>
```

文本盘面形如：

```
          A1    A2    A3    A4    A5    A6
           4     4     0     5     5     5
    A仓                                     B仓
     1                                       0
          B1    B2    B3    B4    B5    B6
           4     4     4     4     4     4
```

## 6. HTTP API

所有请求/响应均为 UTF-8 JSON。错误响应统一为 `{"error":{"code","message"}}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET  | `/health` | 健康检查 |
| POST | `/games` | 开局；空体为默认开局，或 `{"pits":[14个数],"turn":"A"}` 导入教学盘面 |
| GET  | `/games` | 列出对局 |
| GET  | `/games/:id` | 查看当前盘面、版本、合法坑 |
| POST | `/games/:id/moves` | 落子，见下 |
| GET  | `/games/:id/moves` | 历史动作（含逐步明细） |
| GET  | `/games/:id/replay?step=N` | 回放至第 N 步（0 = 记录的初始盘面） |
| POST | `/games/:id/undo` | 撤销末步 |
| GET  | `/games/:id/export` | 导出初始盘面、规则版本、全部动作与当前快照 |

落子请求体：

```json
{ "player": "A", "pit": "A3", "expectedVersion": 0, "reqId": "任意唯一字符串(可选)" }
```

- `expectedVersion` 必须等于当前版本，否则返回 **409 `VERSION_CONFLICT`**（不播子）。
- 相同 `reqId` 的重复提交返回首次结果（`duplicated:true`），**绝不重复播子**；幂等记录持久化，重启后仍有效。
- 每次成功落子版本 `+1`。

### 错误码

| HTTP | code | 触发情形 |
| --- | --- | --- |
| 400 | `INVALID_PLAYER` | 玩家不是 A/B |
| 400 | `NOT_YOUR_TURN` | 非当前行动玩家 |
| 400 | `EMPTY_PIT` | 选择了空坑 |
| 400 | `INVALID_PIT` | 得分仓、对方坑或非法编号 |
| 400 | `GAME_OVER` | 对局已结束 |
| 400 | `INVALID_VERSION` / `INVALID_STEP` / `INVALID_IMPORT` / `INVALID_JSON` / `MISSING_ARG` | 参数校验 |
| 409 | `VERSION_CONFLICT` | 期望版本过期 |
| 404 | `GAME_NOT_FOUND` / `NOT_FOUND` | 对局或路由不存在 |
| 400 | `NO_MOVE_TO_UNDO` | 无动作可撤销 |

### 一次落子响应中的 `detail`

包含：`player`、`pitLabel`、`pickedUp`、逐颗 `drops`（下标+固定编号）、被跳过的对手仓 `skipped`、
`lastIndex/lastLabel`、`capture`（双方公开编号与收取数量）、`extraTurn`、`endSweep`（终局逐坑归仓明细）、
`nextPlayer`、`gameOver`、`winner`、结算前后的 `before/after` 盘面，可直接用于回放与解释。

## 7. 持久化与一致性

- 数据库：`data/kalah.db`（SQLite，WAL 模式），可用 `--db` 覆盖。
- `games` 表保存当前快照与**记录的初始盘面、初始先手、规则版本**；`moves` 表保存每步明细、
  顺序号、前后版本与 `req_id`（`UNIQUE(game_id, req_id)` 保证幂等）。
- 落子在单个 `BEGIN IMMEDIATE` 事务中同时写入动作与快照，原子提交或回滚。
- **回放**始终从记录的初始盘面按历史动作重新推演，不改写旧动作来“消除”过去的非法状态。
- **撤销**删除最后一条动作，并依据该动作记录的 `before` 完整还原：所有坑/仓、当前玩家、
  终局标志、胜者、版本号（终局局同样可撤销，撤销后可继续落子）。

## 8. 可复现完整对局演示（`npm run demo`）

固定教学盘面依次演示：

1. 默认开局 A 选 `A3`：路径 `A4 → A5 → A6 → A仓`，最后落自己仓并获额外回合；
2. 对面取子：A 落 `A2`，落入原本为空的 `A3`，取走对面 `B4` 全部子；
3. 多圈跳过对方仓：A 拿起 14 颗，绕圈时跳过一次 `B仓`；
4. 终局归仓：A 落 `A6` 入仓后己方普通坑全空，B 方 12 颗全部归入 `B仓`；
5. 撤销该终局动作，盘面/玩家/终局标志逐项还原；
6. 历史回放至第 0 步初始盘面。

## 9. 项目结构

```
src/engine.ts    纯规则引擎（固定环形编号、播撒、取子、终局、守恒）
src/db.ts        SQLite 建表、原子提交、撤销、查询
src/service.ts   开局/落子/版本冲突/幂等/回放/撤销/导出
src/server.ts    零依赖 HTTP API
src/cli.ts       命令行
src/render.ts    两排坑 + 得分仓文本表
src/demo.ts      可复现演示
test/            node:test 规则、服务持久化、HTTP API 用例
data/            运行后生成的 SQLite 数据目录
```

## 10. 限制与假设

- 仅实现固定 6 坑 × 4 子 Kalah 变体；不支持其他 Mancala 规则配置。
- 仅监听本机 `127.0.0.1`，无鉴权、无 CORS、无多实例/网络匹配——定位为本地后端。
- `node:sqlite` 在当前 Node 版本带实验警告（`--experimental-sqlite`），API 稳定后可去掉该标志。
- 教学盘面只做 0..100 非负整数与总子数 >0 的受限校验，不做“可从默认开局到达”的可达性证明。
