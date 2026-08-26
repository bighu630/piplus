# WS 会话定向投递（订阅模型）设计

日期：2026-08-23
状态：已确认（方案 A）
分支：`feature/ws-session-subscription`

## 背景与问题

piplus 聊天实时流链路：`sessions/:id/run` → pi-client AgentSession → `pi-stream-bridge` 映射 → WS socketHub **全量广播**（`shouldDeliver` 恒 true），完全依赖前端按 `session_id` 过滤。会话数量多时，高频 `chat_stream` delta 帧会广播到所有连接，存在性能浪费。此前一轮改造已被用户整体回滚，本设计以回滚后的仓库状态（4b6676b）为基准重新实现。

## 调研结论：前端消息依赖清单

| 消息 | scope/payload 定位 | 前端用途 | 投递策略 |
|---|---|---|---|
| `chat_stream` | `scope.session_id` | 流式快照累积 + 当前会话渲染（高频） | **定向**：仅订阅者 |
| `session.compaction_start/end` | `scope.session_id` | context-usage 失效 | **定向**：仅订阅者 |
| `runtime.restored` | `scope.session_id` | 当前会话 commands/info 失效 | **定向**：仅订阅者 |
| `terminal_output/exit` | `payload.sessionId` | 终端渲染（App.tsx 已按选中会话过滤） | **定向**：仅订阅者 |
| `session.runtime_status_changed` | `scope.session_id` | **所有会话**的侧边栏运行状态灯、后台完成时的 query 失效 | **保持全局广播**（低频） |
| `tree.changed` / `project.created` / `session.created` / `session.archived` / `session.updated` | 无 session scope 或全局语义 | 侧边栏树刷新 | 保持全局广播 |
| `connection.opened/hello/pong/context.updated` | 连接级 | 连接状态 | 直发不变 |

## 设计

### 1. 协议（packages/shared/src/ws.ts）

新增两类 ClientMessage，前后端同仓同步升级，不设兼容层（desktop 不使用 WS）：

```ts
export type ClientSubscribeSession = {
  kind: 'client';
  type: 'subscribe_session';
  payload: { session_id: string };
};
export type ClientUnsubscribeSession = {
  kind: 'client';
  type: 'unsubscribe_session';
  payload: { session_id: string };
};
```

加入 `ClientMessage` 联合类型与 `isClientMessage` 判定。

### 2. 服务端 hub（apps/api/src/ws/session.ts）

- 每连接维护 `subscribedSessions: Set<string>`（初始为空）。
- `handleClientMessage` 处理 `subscribe_session` / `unsubscribe_session`，增删集合。
- **投递规则统一按消息内容判定**（单一通路，`sendToSession` 保留签名但委托同一逻辑，忽略 sessionId 参数——保证 sessions.ts 现有调用点零改动）：

```
kind === 'event':
  - 无 scope.session_id                          → 广播（全局事件）
  - type ∈ GLOBAL_EVENT_TYPES（控制面白名单：
    session.runtime_status_changed / tree.changed / project.created /
    session.created / session.archived / session.updated，即使带
    scope.session_id 也保持广播——前端依赖它们全局刷新侧边栏树）
                                                   → 广播
  - 其余                                          → subscribed.has(scope.session_id)
kind === 'chat_stream':   subscribed.has(scope.session_id)
kind === 'terminal':      subscribed.has(payload.sessionId)
```

- `set_context` 不再隐式参与过滤（context 仅存档）；订阅完全由显式消息管理。
- ⚠️ 与并行「认证安全加固」会话的交叉点：`apps/api/src/ws/server.ts` 握手处 import 了 `../auth/token` 的 `verifyToken/isAuthEnabled`。**本次只读不改该文件中的鉴权行**；其余对 server.ts 的改动为零（hub 逻辑全部在 session.ts）。若 auth 会话改动 token 接口，冲突由用户协调。

### 3. 前端（apps/web/src/lib/）

- `ws-client.ts`：新增 `subscribeSession(sessionId)` / `unsubscribeSession(sessionId)` 方法。
- `ws-provider.tsx` 的 `setSessionContext`：
  - 切换会话时 `unsubscribeSession(旧)` → `subscribeSession(新)`；
  - 用 ref 记录上一个会话 id；
  - 订阅新会话的同时 `invalidateQueries(['session','messages',sessionId])`，弥补定向期间错过的流式中间内容；
  - `onOpen` 重连后对当前会话补一次 subscribe。
- 快照累积逻辑（`streamSnapshotsRef`）、通知、query 失效逻辑均不动。

### 行为变化（已知且接受）

后台流式中途切走的会话不再收到后续 delta；切回时流式区短暂空白，由订阅时主动拉取的消息列表 + `idle` 事件的兜底失效补齐。

## 测试

- 重写 `apps/api/src/ws/session.test.ts`：全局事件穿透、runtime_status_changed 全局、chat_stream/terminal 定向、subscribe/unsubscribe 生效、sendToSession 内容判定。
- 全量验证：`bun run test`（基线已有 1 个存量失败：`createApp docker serving > does not allow a non-matching cors origin...`，与本改动无关，不在范围内修复）、`bun run typecheck`。

## 严禁改动

任何 package.json / bun.lock / auth 相关代码 / sessions 路由业务逻辑。
