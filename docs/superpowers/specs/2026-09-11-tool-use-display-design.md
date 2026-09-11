# Tool Use 展示优化（write / edit / read）设计方案

## 背景

`apps/web/src/components/TabChat.tsx` 的 tool_call 卡片收起时只有一行工具名。write/edit 修改了哪个文件、增删多少行，read 读了哪个文件、哪段行号，都要先展开卡片才能看到；`DiffViewer` 的摘要栏（文件名 + `+N -N`）也只在卡片展开后渲染。read 卡片展开后则是原始 JSON args。

## 需求（已与用户确认）

1. **write / edit 卡片**：头部只有 chevron + 工具名；头部下方常显文件摘要行（文件路径 + `+N` / `-N`），多条卡片自然形成多行文件列表。默认收起，展开后显示 diff 明细。
2. **read 卡片**：同样结构，摘要行显示文件路径 + 行号范围（如 `100-149`）；展开后显示读取到的文件内容（不带行号，行号只在摘要范围里）。无行号参数时不显示行号部分。
3. **交互**：点击头部、摘要行、「展开全部 / 收起全部」按钮三处均可切换该卡片；按钮仅 write/edit/read 卡片拥有。其它工具保持原交互（头部点击展开 args，无摘要行、无按钮）；不做全局总控。
4. write 无法得知旧内容（见下），只显示 `+N`；edit 显示 `+N -N`。

## 数据来源（已核实代码事实）

| 工具 | args | 结果侧 | 结论 |
|---|---|---|---|
| `write` | `{ path, content }` | `details: undefined`，文本 `Successfully wrote to <path>` | 只能算 `+N` = content 行数，`-N` 无法获得 |
| `edit` | `{ path, edits: [{ oldText, newText }] }` | pi 0.85 `details.diff`（`+行号 文本` / `-行号 文本` 格式，context 行被裁剪但增删行完整） | 优先数 `details.diff` 得精确 `+N -N`；缺失时回退 args + LCS |
| `read` | `{ path, offset, limit }` | 文本偶含 `[Showing lines X-Y of Z]`，不保证存在 | 行号范围按 args 推导：offset–offset+limit-1 |

`details` 经 `packages/pi-client/src/history.ts` → DTO 已透传到前端，**无需改后端 / pi-client / shared 类型**。

## 技术方案

### 1. 新增 `apps/web/src/lib/tool-summary.ts`（纯函数，可单测）

- `summarizeWriteEdit(toolName, args, details?) => { path: string | null; added: number; removed: number } | null`
  - `write`：`added` = content 行数（去掉末尾换行产生的空行；空 content 为 0），`removed` = 0
  - `edit`：优先解析 `details.diff` 字符串统计 `+`/`-` 行；否则用 `edits[].oldText/newText` 拼接后调用现有 `computeLineDiff`
  - 非 write/edit 或 args 非法时返回 `null`
- `formatReadLineRange(args) => string | null`
  - `offset` 与 `limit` 均为正整数：`offset-(offset+limit-1)`（例：100/50 → `100-149`，limit 为行数）
  - 仅 `offset`：`100+`
  - 仅 `limit`：`1-50`
  - 都没有：`null`
- `splitLineCount(text)`：行数统计（空文本 0；末尾换行不额外计一行）

从 TabChat 迁移 `parseWriteEditArgs` 的解析职责到本模块（`parseWriteEditDiff`：返回 `{ path, oldText?, newText }`），供 `DiffViewer` 与 `summarizeWriteEdit` 共用。

### 2. `apps/web/src/components/ToolCallCard.tsx`

从 TabChat 抽出 tool_call 卡片渲染，props：

```ts
interface ToolCallCardProps {
  msg: ChatMessageDTO;
  expanded: boolean;
  onToggle: (id: string) => void;
  running?: boolean;
  roleSuffix?: string | null;    // spawn_session 等角色后缀
  resultDetails?: unknown;       // 对应 tool result 的 details（edit 精确 diff）
  resultContent?: string | null; // 对应 tool result 文本（read 展开内容）
}
```

- 头部（整行可点击）：chevron + 工具名（含 spawn_session 角色后缀）
- 摘要行（仅 write/edit/read，头部下方常显，整行可点击）：
  - write/edit：`FileCode` 图标 + 路径（`truncate`，`title` 全路径）+ `+N`（emerald）/ `-N`（rose）
  - read：`FileCode` 图标 + 路径 + 行号范围（amber chip）
  - 行尾「展开全部 / 收起全部」按钮
- 展开区：write/edit 渲染 `DiffViewer` 明细；read 渲染读取内容（等宽字体 `whitespace-pre`、`max-h-96` 滚动、超过 500 行时在滚动容器外提示、pi 尾部续读提示单独一行展示且不计入行数、失败文本用 rose 样式）；其它工具保持 TabChat 现状（spawn_session 表格 / JSON args）
- 运行中 spinner 与时间戳沿用现有样式

### 3. 改造 `apps/web/src/components/DiffViewer.tsx`

移除内部摘要栏与折叠按钮（摘要上移到卡片头部），保留 diff 行渲染与截断提示；`viewType` 与 `+N/-N` 统计逻辑保留（截断提示仍需要 raw 行数）。

### 4. 改造 `apps/web/src/components/TabChat.tsx`

tool_call 分支替换为 `<ToolCallCard …>`；`expandedToolIds` 状态与 `isToolCallPending` 匹配逻辑保留；`DiffViewerInline`、`parseWriteEditArgs` 移除（迁移至新模块）。

## 边界与降级

- args JSON 解析失败：不渲染摘要行，展开区回退原始 args 文本
- 缺少 path：摘要行显示 `(未提供路径)`，增减行数照常展示
- edit 的 details 缺失（旧会话、未落盘）：回退 args 行级 diff 计算
- write 的 `-N` 不显示（数据不存在）
- read 结果未落盘（流式中/被中断）：展开区回退展示 args JSON
- read 内容超长：截断到 500 行并提示「仅显示前 500 行（共 N 行）」，容器 `max-h-96` 可滚动
- read 行号是请求范围而非实际内容范围（offset 超出文件尾时会偏大），与已确认决策一致
- 超长路径：单行 `truncate`，hover 显示完整路径

## 测试

- `apps/web/src/lib/tool-summary.test.ts`：write 行数（普通/空/末尾换行）、edit 的 details.diff 解析与 args 回退、行号范围 4 种情形、result 匹配
- `apps/web/src/lib/diff.test.ts`：行级 diff 的末尾换行口径与 truncateDiff 截断边界
- `apps/web/src/components/ToolCallCard.test.tsx`（happy-dom + React 19，参照 `AskQuestionCard.test.tsx`）：
  1. write 卡片默认收起：头部只有工具名，下方摘要行显示路径与 `+N`，不渲染 diff 明细
  2. 点击头部 / 摘要行 / 「展开全部」按钮三处均可切换，按钮文案随状态变化
  3. read 卡片摘要行显示路径与 `100-149`；无 offset/limit 不显示行号
  4. read 展开显示读取内容（不带行号）；无结果时回退 args；超长内容截断提示
  5. 其它工具（bash/spawn）：无摘要行、无按钮，头部点击展开；JSON 非法降级；running spinner
- `apps/web/src/components/DiffViewer.test.tsx`：write/edit 明细渲染、>150 行截断提示、无折叠控件

## 验证

- `apps/web`：`bun run lint` + `bun test --isolate`（124 用例，改动范围，遵循仓库 AGENTS.md 的 scoped 检查纪律）

注：基线存在偶发 flaky（happy-dom 全局在并发测试文件间互踩，表现为 `createThrottledFlusher` 失败或 ws-provider 的 `window.event` 报错）；`test:web` 已改用 `bun test --isolate`（每个文件独立全局对象），实测 8/8 稳定通过且耗时无退化。
