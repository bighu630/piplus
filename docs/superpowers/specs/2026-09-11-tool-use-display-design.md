# Tool Use 展示优化（write / edit / read）设计方案

## 背景

`apps/web/src/components/TabChat.tsx` 的 tool_call 卡片收起时只有一行工具名。write/edit 修改了哪个文件、增删多少行，read 读了哪个文件、哪段行号，都要先展开卡片才能看到；`DiffViewer` 的摘要栏（文件名 + `+N -N`）也只在卡片展开后渲染。read 卡片展开后则是原始 JSON args。

## 需求（已与用户确认）

1. **文件工具聚合卡片**：同一条 assistant 消息内的多个 write/edit/read 调用合并为一张卡片，头部为 `chevron + 工具名(× N)`；下方以**多行文件列表**展示每个文件（路径 + `+N` / `-N`，read 为路径 + 行号范围）。
2. **两个交互**：① 每行可**独立展开**显示该文件的 diff 明细（read 显示读取内容，不带行号，行号只在行内范围里）；② 卡片级总控 = 头部点击（整组展开/收起）；**仅当组内有多个文件时**额外显示唯一的「展开全部 / 收起全部」按钮（单文件时点行/头部即可切换）。
3. **状态着色（工具调用视为一个整体）**：整组全部成功 → 绿色卡片；有任一失败 → 红色卡片（失败行额外标红并显示「失败」）；仍在运行（结果未回）→ 保持琥珀色。
4. **失败原因默认展开**在对应行内（点击该行仍可收起）；write/edit/read 的结果（成功与失败）均不再渲染独立结果卡片。
5. **普通工具（bash/grep/find/ls 等）**：一条调用一张卡片，**卡片本身按执行结果着色**（成功绿 / 失败红 / 结果未回琥珀，与文件聚合卡片同口径）；头部点击展开后为两个可折叠子项——「执行参数」（默认收起）与「结果」（默认展开，成功/失败标识）；结果不再渲染独立卡片。`ask_question`（交互型工具，结果即用户答案）保持中性琥珀并与例外展示一致。
6. **连续同工具调用合并**：连续相邻（跨 assistant 消息也算）、**同一工具、且成功**的普通调用合并为一张卡片，头部右侧显示 `×N`；展开后为 N 组「执行参数 + 结果」（参数默认收起、结果默认展开），**组间以分割线 + 间隙隔开**。失败的调用不参与合并（单独渲染，保持失败卡片）；`read`/`write`/`edit` 保持同回合多文件卡片；`ask_question` / `spawn_session` / `send_message_to_session` 不参与合并。
7. **独立结果卡片仅保留三类**：`ask_question` 的结构化答案卡片、`spawn_session` / `send_message_to_session` 的紫色摘要卡片，以及**调用不在当前视图内的孤立结果**降级卡片（分页边界，避免信息丢失）。前两类工具卡片本身也保持既有展示。
7. **bash 的「执行参数」**用**表格**展示（`command` / `timeout` 等键值行），其中 `command` 的值做**命令格式化**：在顶层分隔符（`&&` / `||` / `|` / `;`）处断行缩进 + bash 语法高亮；表格右上角提供「复制命令」按钮（复制**原始命令**，保证可直接执行）。其它工具仍为 JSON 原文。
8. 工具结果统一截断标准：**200 行**（read 内容与普通工具结果同一口径），容器内滚动，截断提示在滚动容器外。
9. write 无法得知旧内容（见下），只显示 `+N`；edit 显示 `+N -N`。
10. 文件路径保持单行截断，鼠标悬停（`title`）看完整。

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

- 头部：chevron（全展开态）+ 工具名列表（混合时如 `write + edit × 3`）+ 总控按钮「展开全部 / 收起全部」（**仅 `calls.length > 1` 时渲染**）；头部点击与按钮同语义；整组有失败时头部附「失败」标识
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
  resultContent?: string | null; // 对应 tool result 文本（卡片内「结果」子项）
}
```

- 卡片容器：按状态着色（error → rose / pending → amber / ok → emerald），带 `data-testid="tool-call-card"` + `data-status`；展开区边框、图标、标题、args 内容、子项 hover 与卡片悬停反馈随色系（正文/表格键名/状态徽标用 700/800 档保证对比度 ≥4.5:1，图标用 600 档）；`ask_question` 成功态恒为 amber，**失败态仍按红色**
- 头部：chevron + 工具名，点击展开/收起（运行中时卡片右侧 spinner）；失败时附折叠态可见的「失败」徽标
- 展开区（普通工具）：两个可折叠子项
  - 「执行参数」：默认收起；bash → **参数表格**（`command` 值经 `formatBashCommand` 断行缩进 + highlight.js bash 高亮，表格右上角「复制命令」复制原始命令）；其它工具 → JSON 原文（非法 JSON 显示原文；无参数显示「（无参数）」）
  - 「结果」：默认展开，`成功`/`失败`/`运行中` 标识 + `ToolResultView` 内容（运行中显示「执行中…」占位）
  - 每次重新展开主卡片时恢复默认（参数收起 / 结果展开）
- 例外保持既有展示：`spawn_session` / `send_message_to_session` → args 表格；`ask_question` → JSON args
- 结果消息不再渲染独立结果卡片：文件类由聚合卡片承载、普通工具由「结果」子项承载

**`lib/format-bash-command.ts`**：`formatBashCommand(command)` —— 顶层分隔符（`&&` / `||` / `|` / `;`）处断行并缩进，引号（`' " \``）与反斜杠转义内的分隔符不处理，单个 `&`（后台任务）不处理；保留原始换行与行首缩进、折叠首尾空行。仅用于**展示**（不加续行符，不保证可直接粘贴执行；执行请用「复制命令」复制的原始命令）。

**`MergedToolCallsCard.tsx`**：连续同工具调用的合并卡片（合并组只含成功调用，因此不存在 running 态，不渲染 spinner） —— 头部 chevron + 工具名 + `×N`（`data-testid="merged-tool-header"` / `merged-tool-count`），点击展开/收起整组；展开后每组一个 `ToolCallBody`（`data-testid="merged-tool-entry"`，组间 `border-t` + `mt-1` 形成分割间隙）。合并组只含成功调用 → 恒为 `ok` 配色。分组由 `collectMergedToolCallGroups(messages)` 给出（跳过**属于当前工具**的结果消息；遇到其它工具/普通消息或不可合并调用即断开）。

**`ToolCallBody.tsx`**：从 ToolCallCard 抽出的「展开区主体」（执行参数 + 结果两个子项，含 bash 表格/高亮/复制与结果复制），由 ToolCallCard 与 MergedToolCallsCard 共用；子项折叠态由组件内部维护，调用方通过**条件挂载**在重新展开时恢复默认。

**`lib/tool-call-scheme.ts`**：状态配色表（`TOOL_CALL_SCHEMES`）抽出，供 ToolCallCard / ToolCallBody / MergedToolCallsCard 共用（原分散在 ToolCallCard 内）。

**`ToolResultView.tsx`**：通用工具结果文本（统一截断 200 行 + 滚动、截断提示在滚动容器外、失败 rose / 成功中性色、空输出占位）。

**独立结果卡片仅保留三类**：`ask_question` 的结构化答案卡片（AskQuestionCard）、`spawn_session` / `send_message_to_session` 的紫色摘要卡片（Markdown 渲染）、以及孤立结果（调用不在当前视图内）的降级结果卡片。

**结果承载判定**：`collectCoveredToolResultIds(messages)` 收集「已由工具卡片承载」的结果 id（文件类 → 聚合卡片；普通工具 → 「结果」子项），排除 `STANDALONE_RESULT_TOOLS`（ask_question / spawn_session / send_message_to_session）；命中集合的结果不再渲染独立卡片，未命中（孤立结果 / 例外工具）继续走独立卡片。

**「结果」子项细节**：头部在失败时附「失败」徽标（折叠态可见）；子项标题提供复制按钮（`navigator.clipboard`，剪贴板不可用时静默忽略，卸载时清理复位定时器）。

**`ReadResultView.tsx`**：read 展开内容（等宽字体 `whitespace-pre`、`max-h-96` 滚动、超 200 行在滚动容器外提示、pi 尾部续读提示单独一行、失败文本 rose 样式、空内容占位）。

### 3. 改造 `apps/web/src/components/DiffViewer.tsx`

移除内部摘要栏与折叠按钮（摘要下移到卡片头部下方的摘要行），保留 diff 行渲染与截断提示；`viewType` 与 `+N/-N` 统计逻辑保留（截断提示仍需要 raw 行数）。

### 4. 改造 `apps/web/src/components/TabChat.tsx`

- 渲染前调用 `buildFileToolGroups(messages)`：命中 `memberIds` 的消息交由 `FileToolGroupCard` 渲染（仅组内首条位置），其余走原有分支（非文件类 tool_call → `ToolCallCard`）
- `expandedToolIds` 语义：已展开的调用 id（文件行独立展开与单卡片展开共用）；新增 `toggleAllToolFiles(ids, expand)` 供聚合卡片总控
- 预先计算 `runningToolIds`（聚合卡片与单卡片共用同一判定），避免逐卡片重算

## 边界与降级

- args JSON 解析失败：不渲染摘要行，展开区回退原始 args 文本
- 缺少 path：摘要行显示 `(未提供路径)`，增减行数照常展示
- edit 的 details 缺失（旧会话、未落盘）：回退 args 行级 diff 计算
- write 的 `-N` 不显示（数据不存在）
- read 结果未落盘（流式中/被中断）：该行展开区回退展示 args JSON
- 工具结果超长（read 与普通工具统一）：截断到 200 行并提示「仅显示前 200 行（共 N 行）」，容器 `max-h-96` 可滚动，提示在滚动容器外
- read 行号是请求范围而非实际内容范围（offset 超出文件尾时会偏大），与已确认决策一致
- 超长路径：单行 `truncate`，hover 显示完整路径
- 消息 id 不含 `-tool-N` 后缀（非 pi 历史来源）时每条自成一组，行为与单文件卡片一致
- 分页边界：同一条 assistant 消息的调用被页边界切开时，仅对当前已加载页内的调用聚合；若结果所在页没有对应调用（孤立结果，文件类或普通工具均适用），则不进入 `collectCoveredToolResultIds`，**降级渲染原结果卡片**，避免失败反馈彻底不可见
- 失败判定：result 文本以 `Error` 开头（大小写不敏感，统一用 `isToolErrorMessage`）；结果未回（运行中/被中断/未落盘）归为 **pending**（琥珀色），不宣称为成功
- 部分失败：同组内可能部分成功部分失败（并行调用），整卡按“有任一失败即红色”（失败优先于 pending）着色，失败行单独标红
- 独立结果卡片与工具卡片的失败配色统一为 rose（TabChat 原 red 已对齐）；`ToolResultView` 截断提示边框用中性 slate，避免绿/红卡内出现琥珀线
- 状态徽标（失败/成功标签）统一 700 档（rose-700 / emerald-700），图标保持 600 档
- 分组计算在 TabChat 中以 `useMemo([messages])` 缓存（不依赖每次渲染新建的 `displayMessages`）；消息量继续增大时可进一步建「结果索引」把 O(n²) 扫描降为 O(n)
- 已知技术债：状态调色板中 `ToolCallCard` / `ToolCallBody` / `MergedToolCallsCard` 已共用 `lib/tool-call-scheme.ts`；`FileToolGroupCard` 与 `TabChat` 仍各有自己的配色表（色值已统一）；`hasResult` 口径在文件卡片（结果消息存在）与工具卡片（`content_text` 非 null）略有差异
- 失败行默认展开；点「收起全部」（或单文件组的头部）会把失败行一并收起，再点「展开全部」恢复
- 键盘可达性：文件行与头部均带 `role="button"` + `tabIndex=0`，支持 Enter/Space 切换（单文件组无按钮时同样可用）
- 已知启发式限制：pi 的 `isError` 在 pi-client 侧被转为 `Error: ` 前缀，前端据此判定；若成功 read 的文件正文以 `Error` 开头会被误判为失败（罕见），彻底修复需在 pi-client/shared 透传 `is_error`

## 测试

- `apps/web/src/lib/tool-summary.test.ts`：write 行数（普通/空/末尾换行）、edit 的 details.diff 解析与 args 回退、行号范围 4 种情形、result 匹配（含 toolCallId 精确配对与序数回退）、`isFileToolCall` / `buildFileToolGroups` / `parseToolArgsJson` / `splitReadContent`
- `apps/web/src/lib/tool-summary.test.ts`（合并分组）：连续同工具成功 → 1 组、跨 assistant 消息合并、其它工具/普通消息断开、失败与运行中不参与、文件类与例外工具不参与
- `apps/web/src/components/MergedToolCallsCard.test.tsx`：头部 ×N、默认收起、展开为 N 组（参数收起/结果展开）、组间分割与间隙、每组参数独立展开、重新展开恢复默认、键盘可达、running spinner
- `apps/web/src/lib/diff.test.ts`：行级 diff 的末尾换行口径与 truncateDiff 截断边界
- `apps/web/src/components/FileToolGroupCard.test.tsx`（happy-dom + React 19，参照 `AskQuestionCard.test.tsx`）：
  1. 多行文件列表 + 卡片级**只有一个**总控按钮（计数断言）；单文件组不显示按钮、点行/头部仍可展开
  2. 默认收起不渲染明细；点击单行只展开该行；总控按钮/头部展开全部再收起
  3. 单文件组、混合工具组标签（`write + edit + read × 3`）、路径 `title`、running spinner
  4. 状态着色与失败展开：全部成功绿色卡片；结果未回琥珀色（pending，不宣称成功）；失败红色卡片（优先级高于运行中）+ 失败行默认展开错误原因 + 点击可收起；部分失败时仅失败行标红；全部收起/展开与失败行联动；失败的 edit/read 不渲染 diff 或 read 内容（只显示错误原因）
  5. read 行：行号范围 chip、独立展开内容、无结果回退 args；edit 行：details.diff 精确 ±、diff 明细渲染
- `apps/web/src/components/ToolCallCard.test.tsx`：普通工具两个子项（执行参数默认收起 / 结果默认展开、成功/失败/运行中标识、子项可收起、重新展开恢复默认）、args 非法与无参数降级、折叠态失败徽标、复制按钮；例外保持（spawn 表格 + 角色后缀、ask_question JSON args、args 为空/非法时不出现子项）、spinner
- `apps/web/src/lib/format-bash-command.test.ts`：`&&`/`||`/`|`/`;` 断行缩进、引号与转义内不处理、`$'...'`（ANSI-C quoting）、`;;`/`;&`/`;;&` 保留、单个 `&` 不处理、原始多行保留、空命令与空行折叠
- `apps/web/src/components/ToolCallCard.test.tsx`（bash 部分）：参数表格（command/timeout 行）、命令断行缩进、hljs 语法高亮 token、复制命令按钮（spy 断言写入原始命令）、缺 command 字段、非 bash 工具仍为 JSON
- `apps/web/src/components/ToolResultView.test.tsx`：内容渲染、空输出占位、失败样式、200 行截断（提示位置）、恰好 200 行不截断
- `apps/web/src/components/ReadResultView.test.tsx`：正文渲染、空内容、失败样式、pi 续读提示口径、200 行截断
- `apps/web/src/components/DiffViewer.test.tsx`：write/edit 明细渲染、>150 行截断提示、无折叠控件

## 验证

- `apps/web`：`bun run lint` + `bun test --isolate`（261 用例，改动范围，遵循仓库 AGENTS.md 的 scoped 检查纪律）

注：`ReadResultView` 仍保留 `isError` 样式分支（防御层）；当前生产路径下失败 read 由 `FileRow` 的错误分支直接渲染错误原因，不会传入 `ReadResultView`。

注：基线存在偶发 flaky（happy-dom 全局在并发测试文件间互踩，表现为 `createThrottledFlusher` 失败或 ws-provider 的 `window.event` 报错）；`test:web` 已改用 `bun test --isolate`（每个文件独立全局对象），实测 8/8 稳定通过且耗时无退化。
