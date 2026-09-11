# Tool Use 展示优化（write / edit / read）设计方案

## 背景

`apps/web/src/components/TabChat.tsx` 的 tool_call 卡片收起时只有一行工具名。write/edit 修改了哪个文件、增删多少行，read 读了哪个文件、哪段行号，都要先展开卡片才能看到；`DiffViewer` 的摘要栏（文件名 + `+N -N`）也只在卡片展开后渲染。read 卡片展开后则是原始 JSON args。

## 需求（已与用户确认）

1. **文件工具聚合卡片**：同一条 assistant 消息内的多个 write/edit/read 调用合并为一张卡片，头部为 `chevron + 工具名(× N)`；下方以**多行文件列表**展示每个文件（路径 + `+N` / `-N`，read 为路径 + 行号范围）。
2. **两个交互**：① 每行可**独立展开**显示该文件的 diff 明细（read 显示读取内容，不带行号，行号只在行内范围里）；② 卡片级**只有一个**「展开全部 / 收起全部」总控（按钮 + 头部点击，两者同语义）。
3. **状态着色（工具调用视为一个整体）**：整组全部成功 → 绿色卡片；有任一失败 → 红色卡片（失败行额外标红并显示「失败」）；仍在运行（结果未回）→ 保持琥珀色。
4. **失败原因默认展开**在对应行内（点击该行仍可收起）；write/edit/read 的结果（成功与失败）均不再渲染独立结果卡片。
5. 其它工具（bash/grep/spawn 等）保持原交互：一条调用一张卡片，头部点击展开 args，无摘要行、无按钮；不做全局总控（其结果卡片仍按原样渲染）。
6. write 无法得知旧内容（见下），只显示 `+N`；edit 显示 `+N -N`。
7. 文件路径保持单行截断，鼠标悬停（`title`）看完整。

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
- `isFileToolCall(msg)` / `assistantEntryId(msgId)`：识别文件类调用；从 `${entryId}-tool-${i}` 还原所属 assistant 消息
- `buildFileToolGroups(messages) => { groups: Map<首条id, {id, calls}>, memberIds }`：把同一条 assistant 消息内的 write/edit/read 调用聚合为组（组渲染在首条位置，其余成员跳过渲染）
- `parseToolArgsJson(raw)`：args JSON 解析（格式化文本 + 对象形式，失败时降级原始文本）
- `splitReadContent(content) => { body, notice }`：剥离 pi 尾部续读/截断提示行（不参与行数统计与截断）

从 TabChat 迁移 `parseWriteEditArgs` 的解析职责到本模块（`parseWriteEditDiff`：返回 `{ path, oldText?, newText }`），供 `DiffViewer` 与 `summarizeWriteEdit` 共用。

### 2. `apps/web/src/components/ToolCallCard.tsx`

从 TabChat 抽出两类卡片：

**`FileToolGroupCard.tsx`（文件工具聚合卡片，本轮新增）**

```ts
interface FileToolGroupCardProps {
  calls: ChatMessageDTO[];       // 同一 assistant 消息内的 write/edit/read 调用
  messages: ChatMessageDTO[];    // 为每行查 result（edit 精确 diff / read 内容）
  expandedIds: Set<string>;      // 已独立展开的调用 id
  onToggleOne: (id: string) => void;
  onToggleAll: (ids: string[], expand: boolean) => void;
  runningIds: Set<string>;
}
```

- 头部：chevron（全展开态）+ 工具名列表（混合时如 `write + edit × 3`）+ 唯一的总控按钮「展开全部 / 收起全部」；头部点击与按钮同语义；整组有失败时头部附「失败」标识
- 文件行（每行一个调用，整行可点击=独立展开）：chevron + `FileCode` + 路径（`truncate` + `title`）+ `+N`/`-N` 或行号 chip；失败行标红并显示「失败」
- 行明细：失败 → 错误原因（rose `pre`，默认展开、点击可收起）；write/edit → `DiffViewer`；read → `ReadResultView`；无解析结果时回退 args JSON
- 状态着色：全部成功 → 绿色卡片；有任一失败 → 红色卡片；存在运行中调用且无失败 → 琥珀色
- 失败行的「收起」由组件内部 `collapsedErrorIds` 管理（纯展示态）；「展开全部/收起全部」总控会同步清空/填充该集合
- 任一调用运行中时卡片右侧显示 spinner

**`ToolCallCard.tsx`（非文件类单卡片）**

```ts
interface ToolCallCardProps {
  msg: ChatMessageDTO;
  expanded: boolean;
  onToggle: (id: string) => void;
  running?: boolean;
  roleSuffix?: string | null;    // spawn_session 等角色后缀
}
```

- 头部：chevron + 工具名，点击展开/收起
- 展开区：spawn_session / send_message_to_session → args 表格；其它 → JSON args
- 文件类工具的结果消息不再渲染独立结果卡片（由聚合卡片承载状态与失败原因）

**`ReadResultView.tsx`**：read 展开内容（等宽字体 `whitespace-pre`、`max-h-96` 滚动、超 500 行在滚动容器外提示、pi 尾部续读提示单独一行、失败文本 rose 样式、空内容占位）。

### 3. 改造 `apps/web/src/components/DiffViewer.tsx`

移除内部摘要栏与折叠按钮（摘要下移到卡片头部下方的摘要行），保留 diff 行渲染与截断提示；`viewType` 与 `+N/-N` 统计逻辑保留（截断提示仍需要 raw 行数）。

### 4. 改造 `apps/web/src/components/TabChat.tsx`

- 渲染前调用 `buildFileToolGroups(displayMessages)`：命中 `memberIds` 的消息交由 `FileToolGroupCard` 渲染（仅组内首条位置），其余走原有分支（非文件类 tool_call → `ToolCallCard`）
- `expandedToolIds` 语义：已展开的调用 id（文件行独立展开与单卡片展开共用）；新增 `toggleAllToolFiles(ids, expand)` 供聚合卡片总控
- 预先计算 `runningToolIds`（聚合卡片与单卡片共用同一判定），避免逐卡片重算

## 边界与降级

- args JSON 解析失败：不渲染摘要行，展开区回退原始 args 文本
- 缺少 path：摘要行显示 `(未提供路径)`，增减行数照常展示
- edit 的 details 缺失（旧会话、未落盘）：回退 args 行级 diff 计算
- write 的 `-N` 不显示（数据不存在）
- read 结果未落盘（流式中/被中断）：该行展开区回退展示 args JSON
- read 内容超长：截断到 500 行并提示「仅显示前 500 行（共 N 行）」，容器 `max-h-96` 可滚动
- read 行号是请求范围而非实际内容范围（offset 超出文件尾时会偏大），与已确认决策一致
- 超长路径：单行 `truncate`，hover 显示完整路径
- 消息 id 不含 `-tool-N` 后缀（非 pi 历史来源）时每条自成一组，行为与单文件卡片一致
- 分页边界：同一条 assistant 消息的调用被页边界切开时，仅对当前已加载页内的调用聚合
- 失败判定：result 文本以 `Error` 开头（大小写不敏感，与 TabChat 既有口径一致）；结果未落盘（流式中/被中断）视为成功态（绿色），不显示失败
- 部分失败：同组内可能部分成功部分失败（并行调用），整卡按“有任一失败即红色”着色，失败行单独标红
- 失败行默认展开；点「收起全部」会把失败行一并收起，再点「展开全部」恢复

## 测试

- `apps/web/src/lib/tool-summary.test.ts`：write 行数（普通/空/末尾换行）、edit 的 details.diff 解析与 args 回退、行号范围 4 种情形、result 匹配（含 toolCallId 精确配对与序数回退）、`isFileToolCall` / `buildFileToolGroups` / `parseToolArgsJson` / `splitReadContent`
- `apps/web/src/lib/diff.test.ts`：行级 diff 的末尾换行口径与 truncateDiff 截断边界
- `apps/web/src/components/FileToolGroupCard.test.tsx`（happy-dom + React 19，参照 `AskQuestionCard.test.tsx`）：
  1. 多行文件列表 + 卡片级**只有一个**总控按钮（计数断言）
  2. 默认收起不渲染明细；点击单行只展开该行；总控按钮/头部展开全部再收起
  3. 单文件组、混合工具组标签（`write + edit + read × 3`）、路径 `title`、running spinner
  4. 状态着色与失败展开：全部成功绿色卡片；运行中琥珀色；失败红色卡片 + 失败行默认展开错误原因 + 点击可收起；部分失败时仅失败行标红；全部收起/展开与失败行联动；失败的 edit 不渲染 diff 明细
  4. read 行：行号范围 chip、独立展开内容、无结果回退 args；edit 行：details.diff 精确 ±、diff 明细渲染
- `apps/web/src/components/ToolCallCard.test.tsx`：非文件类（bash/spawn_session）：无摘要无按钮、头部点击切换、args 表格、JSON 非法降级、spinner
- `apps/web/src/components/DiffViewer.test.tsx`：write/edit 明细渲染、>150 行截断提示、无折叠控件

## 验证

- `apps/web`：`bun run lint` + `bun test --isolate`（137 用例，改动范围，遵循仓库 AGENTS.md 的 scoped 检查纪律）

注：基线存在偶发 flaky（happy-dom 全局在并发测试文件间互踩，表现为 `createThrottledFlusher` 失败或 ws-provider 的 `window.event` 报错）；`test:web` 已改用 `bun test --isolate`（每个文件独立全局对象），实测 8/8 稳定通过且耗时无退化。
