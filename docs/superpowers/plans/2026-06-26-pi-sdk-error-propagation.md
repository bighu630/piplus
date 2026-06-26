# Pi SDK 报错透传 — 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在全链路（pi-client → API → WS → 前端 UI）中透传 Pi SDK 报错，在前端聊天界面中以红色可折叠卡片展示，并在 Session Info 的最近事件中持久化记录。

**架构：** 5 层变更 — ① pi-client 发出 `PiSessionStreamEvent.error`；② domain/runtime 将错误持久化到 `sessionEvents` 表；③ API sessions.ts 将错误字段转发到 WS 事件；④ App.tsx WS 处理器捕获错误并管理显示状态；⑤ TabChat 渲染红色可折叠错误卡片。

**技术栈：** TypeScript, Bun, Hono, TanStack Query, React, WebSocket

---

## 文件变更清单

### 修改的文件

| 文件 | 职责 |
|------|------|
| `packages/pi-client/src/client.ts` | 映射 `auto_retry_end` 为 error 事件；sendMessage 失败时发出 error 事件 |
| `packages/domain/src/session/runtime.ts` | 在 doCleanup 中将错误持久化到 sessionEvents 表 |
| `apps/api/src/routes/sessions.ts` | 在 onRuntimeStatusChange 中将 error 字段转发到 WS 事件 |
| `apps/web/src/App.tsx` | 管理 runtimeErrs 状态；WS 处理器捕获错误并管理生命周期 |
| `apps/web/src/components/TabChat.tsx` | 渲染红色可折叠错误卡片 |

### 修改的测试文件

| 文件 | 职责 |
|------|------|
| `packages/pi-client/src/client.test.ts` | 测试 sendMessage 失败时发出 error 事件 |
| `packages/domain/src/session/runtime.test.ts` | 测试运行错误时插入 sessionEvents |

---

## 任务明细

### 任务 1：pi-client — 映射 auto_retry_end 并发送 sendMessage 错误

**文件：** `packages/pi-client/src/client.ts`

- [ ] **步骤 1：在 mapAgentSessionEvent 中映射 auto_retry_end（失败）为 error 事件**

找到 `mapAgentSessionEvent` 函数，添加 auto_retry_end 映射：

```typescript
if (event.type === 'auto_retry_end' && !event.success && event.finalError) {
  return {
    type: 'error' as const,
    sessionId,
    runId: `auto_retry_${crypto.randomUUID().slice(0, 10)}`,
    error: event.finalError,
  };
}
```

插入到 `return null` 之前（在 compaction_end 映射之后）。

- [ ] **步骤 2：在 sendMessage 中捕获 prompt() 错误并发送 error 事件到监听器**

找到 `sendMessage` 函数中 `session.agentSession` 分支，将 `prompt()` 调用包裹在 try-catch 中：

```typescript
// 有实际内容时才发送用户消息；空内容（如 spawn_session 场景）略过
if (content) {
  try {
    console.log('[pi-client] sendMessage → agentSession.prompt', { sessionId, content: content.slice(0, 80) });
    await session.agentSession.prompt(content);
    console.log('[pi-client] sendMessage ← agentSession.prompt done', { sessionId });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('[pi-client] sendMessage ← agentSession.prompt error', { sessionId, error: errorMessage });
    const errorEvent: PiSessionStreamEvent = {
      type: 'error',
      sessionId,
      runId: `error_${crypto.randomUUID().slice(0, 10)}`,
      error: errorMessage,
    };
    for (const listener of session.listeners) {
      void listener(errorEvent);
    }
    throw err;
  }
} else {
  console.log('[pi-client] sendMessage → content is empty, nothing to send', { sessionId });
}
```

- [ ] **步骤 3：运行已有测试确认通过**

```bash
cd /home/ivhu/code/piplus && bun test packages/pi-client/src/client.test.ts
```

预期：全部 PASS

- [ ] **步骤 4：Commit**

```bash
cd /home/ivhu/code/piplus && git add packages/pi-client/src/client.ts && git commit -m "feat(pi-client): emit PiSessionStreamEvent.error for agent loop errors"
```

---

### 任务 2：domain/runtime — 将运行错误持久化到 sessionEvents

**文件：** `packages/domain/src/session/runtime.ts`

- [ ] **步骤 1：添加 sessionEvents 导入**

在文件顶部已有导入处，添加 `sessionEvents`：

```typescript
import { messages, projects, sessionEvents, sessions } from '@piplus/db/schema';
```

- [ ] **步骤 2：实现 persistRuntimeError 辅助函数**

在 `formatRuntimeError` 函数之后添加：

```typescript
async function persistRuntimeError(db: RoleManagerDb, sessionId: string, error: string) {
  try {
    await db.insert(sessionEvents).values({
      id: `event_runtime_err_${crypto.randomUUID().slice(0, 12)}`,
      sessionId,
      type: 'chat_runtime_error',
      payload: JSON.stringify({ error, timestamp: new Date().toISOString() }),
      parentMessageId: null,
      sequence: 1,
      createdAt: new Date(),
    } as any);
  } catch (insertErr) {
    console.error('[session-runtime] failed to persist runtime error event', { sessionId, error, insertErr });
  }
}
```

- [ ] **步骤 3：在 doCleanup 中调用 persistRuntimeError**

在 `doCleanup` 函数中，在 `const runtimeError = error ? formatRuntimeError(error) : null;` 之后添加：

```typescript
if (runtimeError) {
  await persistRuntimeError(input.db, input.sessionId, runtimeError);
}
```

- [ ] **步骤 4：运行已有测试确认通过**

```bash
cd /home/ivhu/code/piplus && bun test packages/domain/src/session/runtime.test.ts
```

预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
cd /home/ivhu/code/piplus && git add packages/domain/src/session/runtime.ts && git commit -m "feat(domain): persist runtime errors to sessionEvents table"
```

---

### 任务 3：API routes — 将错误字段转发到 WS 事件

**文件：** `apps/api/src/routes/sessions.ts`

- [ ] **步骤 1：在 onRuntimeStatusChange 回调中转发 error 字段**

找到 `app.post('/api/v1/sessions/:sessionId/chat/messages', ...)` 中的 `onRuntimeStatusChange` 回调。

当前代码：
```typescript
onRuntimeStatusChange: async ({ projectId, runtimeStatus }) => {
  socketHub.sendToSession(sessionId, createEvent('session.runtime_status_changed', { runtime_status: runtimeStatus }, { project_id: projectId, session_id: sessionId }));
},
```

修改为：
```typescript
onRuntimeStatusChange: async ({ projectId, runtimeStatus, error }) => {
  socketHub.sendToSession(sessionId, createEvent('session.runtime_status_changed', { runtime_status: runtimeStatus, error }, { project_id: projectId, session_id: sessionId }));
},
```

- [ ] **步骤 2：运行已有测试确认通过**

```bash
cd /home/ivhu/code/piplus && bun test apps/api/src/
```

预期：全部 PASS

- [ ] **步骤 3：Commit**

```bash
cd /home/ivhu/code/piplus && git add apps/api/src/routes/sessions.ts && git commit -m "feat(api): forward runtime error to WS session.runtime_status_changed event"
```

---

### 任务 4：前端 App.tsx — 管理 runtimeErrs 状态

**文件：** `apps/web/src/App.tsx`

- [ ] **步骤 1：添加 runtimeErrs 状态**

在现有 `useState` 声明附近添加：
```typescript
const [runtimeErrors, setRuntimeErrors] = useState<Array<{runId: string; error: string}>>([]);
```

- [ ] **步骤 2：在 WS 处理器中处理 chat_stream error 事件**

找到 `onMessage` 回调中的 `chat_stream` 处理逻辑。在 `if (message.phase === 'error') setStreamNote('error');` 处，替换为：

删除该行，改为：
```typescript
if (message.phase === 'error') {
  const errorText = message.payload?.error ?? 'Unknown agent loop error';
  setRuntimeErrors([{ runId: message.payload?.stream_id ?? 'unknown', error: errorText }]);
  setStreamingContent('');
}
```

- [ ] **步骤 3：在 chat_stream start 时清除旧错误**

在 `start` phase 处理中添加清除：
```typescript
if (message.phase === 'start') {
  setStreamingContent('');
  setRuntimeErrors([]);  // 清除旧错误
}
```

- [ ] **步骤 4：在 session 切换时清除错误**

在 `useEffect(() => { setPendingUserMessages([]); setStreamingContent(''); ... }, [selectedSessionId])` 中添加：
```typescript
setRuntimeErrors([]);
```

- [ ] **步骤 5：在 handleSend 中清除错误**

在 `handleSend` 函数中添加：
```typescript
setRuntimeErrors([]);
```

- [ ] **步骤 6：传递 runtimeErrors 到 TabChat**

找到 `<TabChat` 组件调用处，添加：
```tsx
runtimeErrors={runtimeErrors}
```

- [ ] **步骤 7：Commit**

```bash
cd /home/ivhu/code/piplus && git add apps/web/src/App.tsx && git commit -m "feat(web): manage runtimeErrors state for agent loop error display"
```

---

### 任务 5：前端 TabChat — 渲染红色可折叠错误卡片

**文件：** `apps/web/src/components/TabChat.tsx`

- [ ] **步骤 1：添加 runtimeErrors prop 类型**

在 `TabChatProps` 接口中添加：
```typescript
runtimeErrors?: Array<{runId: string; error: string}>;
```

- [ ] **步骤 2：解构 prop**

在函数参数中添加：
```typescript
runtimeErrors,
```

- [ ] **步骤 3：在返回的 JSX 中渲染错误卡片**

在流式内容渲染之后、typing indicator 之前，添加错误卡片渲染。放置在 `{streamingContent && (...)}` 块之后、`{isRunning && !streamingContent && (...)}` 之前：

```tsx
{/* Runtime errors */}
{!isRunning && !streamingContent && runtimeErrors && runtimeErrors.length > 0 && (() => {
  const err = runtimeErrors[runtimeErrors.length - 1];
  const [expanded, setExpanded] = useState(false);
  const isLong = err.error.length > 200;
  return (
    <div className="flex justify-start items-start w-full">
      <div className="flex flex-col items-start max-w-full flex-1 min-w-0">
        <div className="bg-red-50 dark:bg-red-950/30 border border-red-300 dark:border-red-800 rounded-xl overflow-hidden w-full">
          <div
            className="px-3 py-2 flex items-center gap-2 cursor-pointer select-none"
            onClick={() => isLong && setExpanded(!expanded)}
          >
            <OctagonX className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0" />
            <span className="text-xs font-semibold text-red-800 dark:text-red-300">
              Agent Loop Error / Agent 循环错误
            </span>
            {isLong && (
              expanded
                ? <ChevronDown className="w-3.5 h-3.5 text-red-400 shrink-0 ml-auto" />
                : <ChevronRight className="w-3.5 h-3.5 text-red-400 shrink-0 ml-auto" />
            )}
          </div>
          <div className={`border-t border-red-200 dark:border-red-800 px-3 py-2 ${!expanded && isLong ? 'max-h-20 overflow-hidden' : ''}`}>
            <pre className="text-[11px] text-red-900 dark:text-red-200 font-mono whitespace-pre-wrap overflow-x-auto leading-relaxed">
              {err.error}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
})()}
```

**注意：** 上述 JSX 中使用了 `useState`，但 TabChat 是一个函数组件，不能在其内部条件分支中使用 `useState` hook。正确做法是：

- 移除上述内联 `useState`
- 改用组件的 `expandedToolIds` 状态（或新增一个 `expandedErrorIds` 状态）

**修正方案：** 使用已有的 `expandedToolIds` 状态（类型为 `Set<string>`），将错误可折叠集成到同一机制：

- 不再新增独立状态，而是复用 `expandedToolIds`
- 错误卡片使用 `expandable-error-${err.runId}` 作为展开 ID

实际渲染代码：

```tsx
{/* Runtime error (agent loop) */}
{!isRunning && !streamingContent && runtimeErrors && runtimeErrors.length > 0 && (() => {
  const err = runtimeErrors[runtimeErrors.length - 1];
  const errId = `runtime-error-${err.runId}`;
  const isExpanded = expandedToolIds.has(errId);
  const isLong = err.error.length > 200;
  const toggleExpand = () => {
    setExpandedToolIds((prev) => {
      const next = new Set(prev);
      if (next.has(errId)) next.delete(errId);
      else next.add(errId);
      return next;
    });
  };
  return (
    <div key={errId} className="flex justify-start items-start w-full">
      <div className="flex flex-col items-start max-w-full flex-1 min-w-0">
        <div className="bg-red-50 dark:bg-red-950/30 border border-red-300 dark:border-red-800 rounded-xl overflow-hidden w-full">
          <div
            className="px-3 py-2 flex items-center gap-2 cursor-pointer select-none"
            onClick={isLong ? toggleExpand : undefined}
          >
            <OctagonX className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0" />
            <span className="text-xs font-semibold text-red-800 dark:text-red-300">
              Agent Loop Error / Agent 循环错误
            </span>
            {isLong && (
              isExpanded
                ? <ChevronDown className="w-3.5 h-3.5 text-red-400 shrink-0 ml-auto" />
                : <ChevronRight className="w-3.5 h-3.5 text-red-400 shrink-0 ml-auto" />
            )}
          </div>
          <div className={`border-t border-red-200 dark:border-red-800 px-3 py-2 ${!isExpanded && isLong ? 'max-h-20 overflow-hidden' : ''}`}>
            <pre className="text-[11px] text-red-900 dark:text-red-200 font-mono whitespace-pre-wrap overflow-x-auto leading-relaxed">
              {err.error}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
})()}
```

- [ ] **步骤 4：确保 OctagonX 和 ChevronDown/ChevronRight 已导入**

检查文件顶部导入，如果缺少则添加。`OctagonX` 已在文件中使用（在停止按钮中），`ChevronDown` 和 `ChevronRight` 也已在文件中使用。无需额外导入。

- [ ] **步骤 5：运行类型检查**

```bash
cd /home/ivhu/code/piplus && npx tsc --noEmit
```

预期：无类型错误

- [ ] **步骤 6：Commit**

```bash
cd /home/ivhu/code/piplus && git add apps/web/src/components/TabChat.tsx && git commit -m "feat(web): render agent loop errors as red collapsible cards in chat"
```

---

## 验证 Checklist

1. `bun test packages/pi-client/src/client.test.ts` — PASS
2. `bun test packages/domain/src/session/runtime.test.ts` — PASS
3. `bun test apps/api/src/` — PASS
4. `npx tsc --noEmit` — 无类型错误
5. 手动验证：运行时，触发 `sendMessage` 错误 → WS 发送 `chat_stream phase:error` → 前端展示红色错误卡片
6. Session Info 页面显示 `chat_runtime_error` 类型的 recent_events
