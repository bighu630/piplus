# Pi SDK 报错透传设计方案

> **日期：** 2026-06-26
> **状态：** 已批准

## 目标

在全链路（pi-client → API → WS → 前端 UI）中透传 Pi SDK 报错，在前端聊天界面中以红色可折叠卡片展示，并在 Session Info 的最近事件中持久化记录。

## 范围

- **覆盖的错误：** `sendMessage` 过程中的错误（如模型 API 超时、速率限制）以及 Agent 循环中途的错误（如 `auto_retry_end` 标识的全部重试耗尽）。不包含 `restoreRuntime` / `setSessionModel` / `bindToolRuntime` 等基础操作错误。
- **前端展示：** 仅展示最新一条错误，与最后一条用户消息关联，新消息发送后自动隐藏。
- **错误替换：** 当错误发生时，立即替换正在流式输出的内容（Option A）。

## 当前架构与差距

### 现有错误流向（断裂）

```
Pi SDK AgentSession 错误
  → pi-client mapAgentSessionEvent 返回 null（auto_retry_* 事件被丢弃）
  → domain/runtime.ts sendPromise.catch → doCleanup(error)
  → DB: lastRuntimeError 已存储 ✓
  → onStreamEvent 未收到 error 事件 ← 差距
  → onRuntimeStatusChange 的 error 字段被忽略 ← 差距
  → WS: 无 chat_stream error 帧，status 事件无 error ← 差距
  → 前端: streamNote = 'error' 但无可见错误消息 ← 差距
```

### Pi SDK 事件类型

`AgentSessionEvent` 提供以下与错误相关的事件：

- `auto_retry_start` — 自动重试开始，携带 `errorMessage`
- `auto_retry_end` — 自动重试结束，`success: false` 且携带 `finalError`

## 设计

### 数据流（修复后）

```
Pi SDK AgentSession
  → auto_retry_end {success:false, finalError}      ─┐
  → prompt() 在 sendMessage 时抛出                    ─┤
    ↓                                                  ↓
  pi-client: subscribeSession listener / sendMessage 错误发送
  → PiSessionStreamEvent {type:'error', error:'...'}
    ↓
  pi-stream-bridge → WS chat_stream {phase:'error', payload:{error}}
    ↓
  domain/runtime.ts doCleanup(error)
  → 插入 sessionEvents type='chat_runtime_error'
  → onRuntimeStatusChange(error) 通过 WS 转发
    ↓
  前端 App.tsx WS 处理器:
  → chat_stream error: 追加到 runtimeErrs[] 状态
  → runtime_status idle: 重启消息获取
  → 发送新消息时: 清除 runtimeErrs
    ↓
  TabChat 渲染 runtimeErrs 为红色可折叠卡片
  TabSessionInfo 在 recent_events 显示错误
```

### 组件变更

#### 1. `packages/pi-client/src/client.ts`

- 在 `mapAgentSessionEvent` 中，将 `auto_retry_end`（`success === false`）映射为 `PiSessionStreamEvent.error`
- 在 `sendMessage` 中，捕获 `agentSession.prompt()` 的错误，先向所有监听器发送 error 事件，再重新抛出

#### 2. `packages/domain/src/session/runtime.ts`

- 在 `doCleanup(error)` 中，向 `sessionEvents` 表插入一行 `type: 'chat_runtime_error'`

#### 3. `apps/api/src/routes/sessions.ts`

- 在 `onRuntimeStatusChange` 回调中，将 `error` 字段转发到 WS 事件的 payload

#### 4. `apps/web/src/App.tsx`

- 新增 `runtimeErrs` 状态数组
- 收到 `chat_stream phase: 'error'` 时，将错误追加到 `runtimeErrs`
- 切换 session 时或发送新消息时清除 `runtimeErrs`
- 将 `runtimeErrs` 传递给 TabChat

#### 5. `apps/web/src/components/TabChat.tsx`

- 新增 `runtimeErrors` prop
- 在消息列表末尾（streaming 内容之后）渲染最新一条错误
- 红色可折叠卡片，标注 "Agent Loop Error"（中文）
- 支持展开/收起长错误文本

#### 6. Error 数量约束

- 仅展示最新一条错误（`runtimeErrors` 保持最多 1 条）
- 新的 `chat_stream start` 事件自动清除旧错误

### 前端错误卡片设计

```
┌───────────────────────────────────────┐
│ 🔴 Agent Loop Error                   │ ← 深红背景
├───────────────────────────────────────┤
│ 429 Too Many Requests. Provider       │
│ "openai" is rate limited. Please     │ ← 错误文本
│ retry after 30 seconds.              │    （长文本可折叠）
└───────────────────────────────────────┘
```

- 配色: `bg-red-50 dark:bg-red-950/30 border-red-300 dark:border-red-800`
- 图标: 红色圆圈 + 感叹号或者 OctagonX
- 可折叠: 与 tool call 卡片相同的展开/收起交互
- 标注: "Agent Loop Error" / "Agent 循环错误"

### 数据持久化

- `sessionEvents` 表插入 `type: 'chat_runtime_error'` 记录
- `GET /sessions/:id/info` 已在 `recent_events` 中返回 sessionEvents（无需改动）
- `sessions.lastRuntimeError` 字段已在 doCleanup 中更新（无需改动）

### 不变更的部分

- `packages/shared/` — PiSessionStreamEvent 已有 `error` 类型
- `packages/shared/ws.ts` — ChatStreamMessage 已有 `phase: 'error'` 和 `payload.error`
- `packages/db/schema.ts` — sessionEvents 表无需变更
- `packages/pi-client/types.ts` — PiSessionStreamEvent 已有 `error` 变体
- `apps/api/src/ws/protocol.ts` — 协议已支持 error phase
- `apps/api/src/lib/pi-stream-bridge.ts` — 已映射 error 事件到 chat_stream

## 测试策略

- **单元测试：** `packages/pi-client/src/client.test.ts` — 验证 sendMessage 失败时发出 error 事件
- **单元测试：** `packages/domain/src/session/runtime.test.ts` — 验证运行错误时插入 sessionEvents
- **集成测试：** ws-client.test.ts / sessions.test.ts — 验证 WS 协议转发错误
