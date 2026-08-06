# Chat 前端结构与交互优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 优化 Chat 前端：流式渲染性能（节流+编译缓存）、MarkdownRenderer 去重、死代码清理、消息复制、WS 重连退避+断线提示、乐观消息闪白修复、流式状态提升到全局（切 tab/会话不断流）。

**Architecture:** 分两个阶段并行执行。Phase 1 三任务并行（ws-provider 流式快照、MarkdownRenderer 抽取、WS 退避）；Phase 2 两任务并行（TabChat 状态迁移+闪白修复、App 断线 banner）。T1 采用增量式改动保证中间态可编译。

**Tech Stack:** React 19 + TypeScript + TanStack Query + react-markdown 10 + remark-gfm + rehype-highlight + Tailwind 4 + bun:test。

**Worktree:** `/home/ivhu/.config/piplus/projects/piplus/.worktrees/chat-optimize`（分支 `feature/chat-optimize`）。所有命令在该目录下执行。

**验证命令（每个任务完成时运行）：**
```bash
cd apps/web && bun test        # 期望：全部通过（基线 6 个测试）
cd apps/web && bunx tsc --noEmit  # 期望：无类型错误
```

---

## Phase 1（并行）

### Task 1: WS 流式快照 + useChatStream hook（#11 核心）

**Files:**
- Create: `apps/web/src/lib/chat-stream-state.ts`
- Create: `apps/web/src/lib/chat-stream-state.test.ts`
- Modify: `apps/web/src/lib/ws-provider.tsx`

**设计契约（后续 Task 4 依赖此接口，必须严格一致）：**

`chat-stream-state.ts` 内容（纯函数，无 React 依赖）：

```ts
export type StreamPhase = 'idle' | 'streaming' | 'complete' | 'error';

export interface StreamRuntimeError { runId: string; error: string; }

export interface ChatStreamSnapshot {
  phase: StreamPhase;
  streamingContent: string;
  streamNote: string;
  runtimeErrors: StreamRuntimeError[];
}

export const INITIAL_CHAT_STREAM_SNAPSHOT: ChatStreamSnapshot = {
  phase: 'idle',
  streamingContent: '',
  streamNote: '',
  runtimeErrors: [],
};

export type ChatStreamEvent =
  | { type: 'start'; delta: string }
  | { type: 'delta'; delta: string }
  | { type: 'complete' }
  | { type: 'error'; error: string; runId: string }
  | { type: 'runtime_idle' };

export function reduceChatStreamSnapshot(
  snap: ChatStreamSnapshot,
  event: ChatStreamEvent,
): ChatStreamSnapshot;
```

reducer 语义（与现有 TabChat 行为一一对应，见 TabChat.tsx 的 WS 订阅 effect）：
- `start` → `{ phase: 'streaming', streamingContent: '', streamNote: delta ? 'start · streaming' : 'start', runtimeErrors: [] }`
- `delta` → 追加 `streamingContent`，phase='streaming'，其余字段不变
- `complete` → 仅 `phase: 'complete'`，**保留 streamingContent**（Task 4 的桥接依赖它）
- `error` → `phase: 'error'`，`streamingContent: ''`，`runtimeErrors: [{ runId, error }]`
- `runtime_idle` → 返回 `INITIAL_CHAT_STREAM_SNAPSHOT`（全清）

`chat-stream-state.test.ts`（bun:test，参照 `runtime-config.test.ts` 风格）：5 个事件各自的行为 + 连续 delta 累积 + complete 保留内容 + error 清空内容 + idle 全清，共 8 个 test。

**`ws-provider.tsx` 修改（增量式，不破坏现有接口）：**

1. import `reduceChatStreamSnapshot` / `INITIAL_CHAT_STREAM_SNAPSHOT` / 类型。
2. 新增 ref：`const streamSnapshotsRef = useRef<Record<string, ChatStreamSnapshot>>({});`
3. **chat_stream 分支**（现在约第 112 行 `if (message.kind === 'chat_stream' && message.scope?.session_id === currentSessionId)`）改为：先把事件 reduce 进 `streamSnapshotsRef`（**所有 session，不做 currentSessionId 过滤**），再执行现有的 `currentSessionId` 过滤转发逻辑。事件映射：
   - `phase==='start'` → `{ type: 'start', delta: message.payload?.delta ?? '' }`
   - `phase==='delta'` → `{ type: 'delta', delta: message.payload?.delta ?? '' }`
   - `phase==='complete'` → `{ type: 'complete' }`
   - `phase==='error'` → `{ type: 'error', error: message.payload?.error ?? 'Unknown agent loop error', runId: message.payload?.stream_id ?? 'unknown' }`
   - 注意 `message.payload` 可能是 undefined，用可选链。
4. **session.runtime_status_changed → idle 分支**：在现有逻辑之前，把该 session 的快照 reduce 一个事件：若 `(message.payload as any)?.error` 为 string 且非空 → `{ type: 'error', error: 该字符串, runId: 'runtime-status' }`；否则 `{ type: 'runtime_idle' }`。（现有代码中 idleError 提取逻辑在下方，保持不动，仅新增快照更新。）
5. 新增 hook `useChatStream`（导出）：

```ts
export function useChatStream(sessionId: string | null): ChatStreamSnapshot;
```

实现要求：
- `useState` 初始值：`streamSnapshotsRef.current[sessionId ?? ''] ?? INITIAL_CHAT_STREAM_SNAPSHOT`（注意：hook 定义在 WebSocketProvider 组件内部，通过闭包访问 ref）。
- `useEffect` 订阅 `subscribeToStream`（复用现有 listener 机制即可，回调签名保持 `(msg: any) => void`，从 msg 中读 `msg.sessionId`/`msg.snapshot` 需要先改通知格式——**替代方案（推荐）**：不改现有通知格式，在 provider 的 chat_stream 分支里，快照更新后额外把快照写入一个 `useSyncExternalStore` 风格的订阅，或在现有 `streamListenersRef` 通知时附带快照）。

  具体实现（推荐）：把 `streamListenersRef` 的通知回调签名从 `(msg: any) => void` 改为 `(msg: { sessionId: string; snapshot: ChatStreamSnapshot }) => void`。检查代码库中 `subscribeToStream` 的全部调用方——目前只有 TabChat.tsx 一处，且 Task 4 会改掉它；但 **Task 1 完成时 TabChat 必须仍然可编译**，所以 TabChat 里的旧回调需要兼容：TabChat 回调解构 `{ sessionId, snapshot }` 并按需使用（Task 1 期间 TabChat 的旧订阅 effect 若不再需要 delta 内容，可直接让回调体为空或仅保留结构）。
- **节流（Task 1 的关键性能部分）**：hook 内部对快照同步做 80ms 节流——回调里把最新快照存入 ref，若没有 pending 定时器则 `setTimeout(80ms)` 后合并 setState（trailing flush，保证最终内容完整不丢）。`sessionId` 变化时立即同步（跳过节流），并重置定时器。组件卸载时清理定时器。
- 返回快照对象本身（从 state 读）。

6. 新增 context value 字段：`chatStreamSnapshotsRef` 不需要暴露，`useChatStream` 在 provider 组件内部定义并随 context 分发：`const chatStreamSnapshotBySession = ...`——**更简单的做法**：`useChatStream` 作为 WebSocketProvider 内定义的函数，通过 `WebSocketContext.Provider value` 里新增一个字段 `useChatStream` 暴露，或直接把 hook 定义在 provider 内并 export 一个 wrapper。**实现约束：`useChatStream` 必须使用 `useWebSocket()` 获取内部能力，最终以 `export function useChatStream(sessionId)` 的形式从模块导出**（这样 TabChat 直接 `import { useChatStream } from '../lib/ws-provider'`）。

**验收：**
- `bun test` 全过（新增 8 个测试）。
- `bunx tsc --noEmit` 无错误（TabChat 旧订阅逻辑保留或已兼容新回调签名）。
- 提交：`git add -A && git commit -m "feat(web): ws-provider 流式快照 + useChatStream hook（80ms 节流）"`

---

### Task 2: MarkdownRenderer 共享组件 + TabChat 替换 + 死代码清理 + 单条消息复制

**Files:**
- Create: `apps/web/src/components/MarkdownRenderer.tsx`
- Modify: `apps/web/src/components/TabChat.tsx`
- Modify: `apps/web/src/App.tsx`（仅删 sessionTitle 传参）

**Part A — MarkdownRenderer 组件**

从 TabChat.tsx 现有 4 处 ReactMarkdown 配置抽取（spawn summary / user 气泡 / assistant / streaming），合并为一个组件 + 3 个主题变体。

```tsx
interface MarkdownRendererProps {
  content: string;
  variant: 'user' | 'assistant' | 'compact';
  /** 代码块复制按钮的 blockId 前缀（assistant/compact 变体需要）；不传则不启用复制按钮 */
  blockIdPrefix?: string;
  /** 外层容器额外 className（透传到 markdown-body 容器） */
  className?: string;
}
export default function MarkdownRenderer({ content, variant, blockIdPrefix, className }: MarkdownRendererProps): JSX.Element;
```

实现要点：
1. **components 映射必须是模块级常量**（`USER_COMPONENTS` / `ASSISTANT_COMPONENTS` / `COMPACT_COMPONENTS`），每个变体一份，绝不内联在渲染内创建——这是性能修复的核心（现有代码每次渲染重建匿名函数导致整棵 markdown 树重渲染）。
2. `extractCodeText` helper 从 TabChat.tsx 移入本文件（导出或内部使用）。
3. `handleCopyCode` + `copiedId` state 移入组件内部（每实例独立）。复制逻辑照搬 TabChat 现有实现（navigator.clipboard 优先，fallback textarea + execCommand）。blockId 格式保持 `blockIdPrefix-language-codeText`。
4. **类名逐一对齐**（视觉回归零容忍，从 TabChat.tsx 复制现有 className，不得自行改动设计）：
   - `assistant` 变体 = TabChat 中 assistant 消息块 + streaming 块的配置合并（两者除 blockId 前缀外完全相同；`assistant` 变体在 blockIdPrefix 缺省时不渲染复制按钮 header 的 Copy 按钮但保留语言标签头——**实际上两处都有复制按钮**，streaming 用 `stream-` 前缀、assistant 用 `${msg.id}-` 前缀，统一为 blockIdPrefix prop）。
   - `user` 变体 = 用户蓝色气泡配置（无复制按钮，无 table 的版本——**对照源文件**：user 变体有 table/thead/tbody/tr/th/td 配置，全部保留）。
   - `compact` 变体 = spawn summary 配置（p/ul/ol/code/pre/blockquote/h1/h2/h3/a/hr，无 table）。
   - 组件容器：外层 `markdown-body` div 由调用方负责或组件内渲染——**统一在组件内渲染** `<div className="markdown-body">`（现有 4 处都有此包装）。
5. 组件返回 `<ReactMarkdown remarkPlugins={...} rehypePlugins={[[rehypeHighlight, { detect: false }]]} components={variant === 'user' ? USER_COMPONENTS : ...}>{content}</ReactMarkdown>`。user 变体 remarkPlugins 含 `remarkBreaks`，其他两个不含（照搬现有）。

**Part B — TabChat.tsx 替换与清理**

1. 4 处 ReactMarkdown 替换为 `<MarkdownRenderer>`：
   - spawn summary 块 → `variant="compact"`（无 blockIdPrefix）
   - user 气泡 → `variant="user"`
   - assistant 消息块 → `variant="assistant" blockIdPrefix={msg.id}`
   - streaming 块 → `variant="assistant" blockIdPrefix="stream"`（此块后续 Task 4 还会动 state 来源，渲染部分不动）
   - 删除迁移后的 import（ReactMarkdown/remarkGfm/remarkBreaks/rehypeHighlight 若 TabChat 中不再使用则移除；`extractCodeText`、`handleCopyCode`、`copiedId` state 移走后删除）。
2. **死代码清理**：
   - 删除 `{false && allMessages.length > 0 && !isRunning && (...)}` 建议按钮块（约 15 行）。
   - 删除 `sessionTitle?: string` prop（TabChatProps 接口 + 函数解构参数 + App.tsx 传参——先 grep App.tsx 确认传参位置再删）。
   - 删除 `prevSessionIdRef`（声明 + 所有引用；grep 确认无其他用途——调查显示声明后未使用）。
3. **单条消息复制（#5）**：用户气泡和 assistant 普通消息 hover 时显示复制按钮，复制 `msg.content_text`：
   - 消息行容器加 `group` 类；按钮 `opacity-0 group-hover:opacity-100 transition`，位于消息下方/右上角（与时间戳同行或时间戳旁）。
   - 复用 TabChat 现有的 `copiedId`/`setCopiedId` 机制？——**注意 copiedId 已移入 MarkdownRenderer 内部**，消息复制按钮需要自己的 state：新增 `copiedMessageId` state（TabChat 内），成功显示 Check 图标 2 秒。
   - 仅当 `msg.content_text` 非空时显示；tool call / tool result 卡片不显示。
   - 复制函数：把现有 `handleCopyCode` 的复制逻辑抽为 TabChat 内部共用的 `copyText(text: string)` helper（MarkdownRenderer 内部保留自己的实现，两处不强制共享）。

**Part C — App.tsx**

- 仅删除 `sessionTitle={...}` 传参（若有）。不做其他改动（banner 是 Task 5 的）。

**验收：**
- `bunx tsc --noEmit` 无错误。
- 无未使用 import（tsc 不报 unused 但手动清理）。
- 视觉类名与源文件逐项一致（自查清单：assistant 变体含 code-block/pre/表格/引用/标题/链接/分割线；user 含蓝色系全部；compact 含 indigo 系全部）。
- `git add -A && git commit -m "refactor(web): 抽取 MarkdownRenderer 组件，清理死代码，新增消息复制"`

---

### Task 3: WS 重连指数退避

**Files:**
- Modify: `apps/web/src/lib/ws-client.ts`
- Modify: `apps/web/src/lib/ws-client.test.ts`

1. `ws-client.ts` 第 4 行 `const RECONNECT_DELAY = 2000;` 替换为：

```ts
export function nextReconnectDelay(attempt: number): number {
  return Math.min(2000 * 2 ** attempt, 30000);
}
```

2. 重连逻辑改造：`let reconnectAttempt = 0;`（模块级或 connect 闭包外）；close 分支 `reconnectTimer = setTimeout(connect, nextReconnectDelay(reconnectAttempt++))`；`open` 事件处理器里 `reconnectAttempt = 0;`。保持现有 `closed` 标志、`close()` 清理逻辑不变。检查是否有其他使用 RECONNECT_DELAY 的位置（grep），一并处理。
3. `ws-client.test.ts` 新增 describe 块（bun:test）：

```ts
describe('nextReconnectDelay', () => {
  test('exponential backoff with cap', () => {
    expect(nextReconnectDelay(0)).toBe(2000);
    expect(nextReconnectDelay(1)).toBe(4000);
    expect(nextReconnectDelay(2)).toBe(8000);
    expect(nextReconnectDelay(3)).toBe(16000);
    expect(nextReconnectDelay(4)).toBe(30000); // 32000 → capped
    expect(nextReconnectDelay(10)).toBe(30000);
  });
});
```

4. 现有 3 个 createWorkspaceSocket 测试必须继续通过（不依赖具体 delay 值——若依赖，用 fake timers 或只断言 reconnect 未发生）。

**验收：**
- `bun test` 全过。
- `bunx tsc --noEmit` 无错误。
- 提交：`git add -A && git commit -m "fix(web): WS 重连指数退避（2s→30s 上限）"`

---

## Phase 2（在 Phase 1 全部完成后启动，两任务并行）

### Task 4: TabChat streaming 状态迁移 + 乐观消息闪白修复

**Files:**
- Modify: `apps/web/src/components/TabChat.tsx`

依赖：Task 1 的 `useChatStream` 接口、Task 2 已完成的 MarkdownRenderer 替换。

**Part A — streaming 状态迁移（#11）**

1. 删除 TabChat 内：
   - `streamNote`、`streamingContent` state + `streamingContentRef`
   - `runtimeErrors` state
   - `subscribeToStream` 订阅 effect（整个）
   - `subscribeToRuntimeErrors` 订阅 effect（整个）
   - `selectedSessionId` 变化时清空 streaming 的 effect（整个——hook 按 sessionId 自动切换）
2. 新增：`const { phase, streamingContent, streamNote, runtimeErrors } = useChatStream(selectedSessionId ?? null);`（从 `../lib/ws-provider` import）。
3. `pendingAssistantContent` 状态化逻辑改为快照推导：
   - 删除 `pendingAssistantContent` state + 相关 setState 调用（complete 处理、runtime idle 清理中的）。
   - 新增推导：`const pendingAssistantContent = phase === 'complete' && streamingContent ? streamingContent : null;`
   - `pendingAssistantConfirmed` useMemo 保留（逻辑不变）。
   - 移除 `useEffect(() => { if (pendingAssistantConfirmed) setPendingAssistantContent(null); }, [pendingAssistantConfirmed])`（无 state 可清）。
   - 移除 prevRuntimeStatus effect 中的 `setPendingAssistantContent(null)` 行（保留 `setPendingUserMessages([])`、`setStreamNote('')`——streamNote 已不在本地，该 effect 只留 pendingUserMessages 清理）。
4. 渲染处：`{streamingContent && (...)}` streaming 块、`{streamNote && ...}` 顶部 note、runtimeErrors 错误卡片的**渲染代码保持不动**（变量来源已切换为 hook 返回值）。
5. `{isRunning && !streamingContent && (...)}` 打字指示器：保持不变。

**Part B — 乐观用户消息闪白修复（#2）**

1. `handleSendInternal`：`await onSend(content, attachments)` 成功分支**删除** `setPendingUserMessages((prev) => prev.filter(...))`（不再立即移除）。失败分支（catch）保持立即移除。
2. 新增超时兜底 effect（防止消息永久残留）：

```tsx
// 兜底：乐观消息 60s 未被真实消息确认则强制移除（正常情况下 refetch/轮询会确认）
useEffect(() => {
  if (pendingUserMessages.length === 0) return;
  const timers = pendingUserMessages.map((pm) =>
    setTimeout(() => {
      setPendingUserMessages((prev) => prev.filter((m) => m.id !== pm.id));
    }, 60_000),
  );
  return () => timers.forEach((t) => clearTimeout(t));
}, [pendingUserMessages]);
```

3. 确认机制依赖现有 reconcile（`hasConfirmedMatch` 按文本+图片签名+时间窗匹配，running 期间 messages query 1.5s 轮询会拉到真实消息）——**不需要改 reconcile 逻辑本身**。

**验收：**
- `bunx tsc --noEmit` 无错误。
- grep TabChat.tsx：无 `subscribeToStream`、无 `streamingContentRef`、无 `setPendingAssistantContent`、无 `setStreamingContent` 残留。
- `bun test` 全过。
- 提交：`git add -A && git commit -m "feat(web): 流式状态迁移到 ws-provider 快照 + 乐观消息闪白修复"`

---

### Task 5: App 全局断线 banner

**Files:**
- Modify: `apps/web/src/App.tsx`（Task 2 完成后才能动此文件）

1. 确认 `useWebSocketConnected` 已从 `../lib/ws-provider` 导出（已存在）。
2. 在 App 组件内：`const wsConnected = useWebSocketConnected();`（注意 hook 调用位置必须在 App 的 hooks 区域内、login guard 之前——参照 App.test.ts 的 hook 顺序约束：guard 之前不调用 hooks？**读 App.test.ts 后决定**：若测试要求 guard 前无 hook，则 banner 逻辑放在登录后的 JSX 分支内使用现有 hook 值——检查 App 是否已 import `useWebSocket`/`useWebSocketConnected`，若无则新增，并放在现有 hook 调用区）。
3. JSX：在 content 区域顶部（tab bar 之上或消息区之上，全局可见）加：

```tsx
{!wsConnected && (
  <div className="shrink-0 bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-800 px-4 py-1.5 text-center text-[11px] font-medium text-amber-700 dark:text-amber-300">
    连接已断开，正在重连…
  </div>
)}
```

位置选择：登录后的主布局最外层容器顶部（即 TabChat/TabSessionInfo 等切换区域之上）。样式可微调但保持 amber 警告语义。

**验收：**
- `bunx tsc --noEmit` 无错误。
- `bun test` 全过（App.test.ts 的 hook 顺序测试必须通过——若失败，调整 hook 位置）。
- 提交：`git add -A && git commit -m "feat(web): 全局断线提示 banner"`

---

## 最终验收（全部任务完成后由 lead 执行）

```bash
cd /home/ivhu/.config/piplus/projects/piplus/.worktrees/chat-optimize
cd apps/web && bun test && bunx tsc --noEmit && bun run build
```

检查清单：
- [ ] TabChat.tsx 行数显著下降（预期 <1000）
- [ ] 无 4 份重复 ReactMarkdown 配置
- [ ] 无 `{false && ...}` / 未使用 props
- [ ] ws-provider 快照按 sessionId 隔离
- [ ] 视觉类名与改动前一致（对照 git diff）
