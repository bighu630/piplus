# WS 会话定向投递 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 WS 全量广播改造为服务端按会话订阅定向投递（chat_stream / terminal / 会话私有事件只发订阅者，全局事件与 runtime_status_changed 保持广播）。

**Architecture:** shared 协议新增 subscribe/unsubscribe 消息；api socketHub 按消息内容 + 每连接订阅集合做单一通路过滤（sendToSession 委托同逻辑）；web 前端在 setSessionContext 切换会话时显式订阅/退订并补拉消息。

**Tech Stack:** Bun + TypeScript, Hono (bun ws), React context。

**工作目录：** `/home/bighu/server/piplus/.worktrees/ws-session-subscription`（分支 `feature/ws-session-subscription`）

---

### Task 1: shared 协议类型

**Files:**
- Modify: `packages/shared/src/ws.ts`

- [x] **Step 1: 新增消息类型**

在 `ClientPing` 定义之后加入：

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

- [x] **Step 2: 更新联合类型与守卫**

```ts
export type ClientMessage = ClientHello | ClientSetContext | ClientPing | ClientSubscribeSession | ClientUnsubscribeSession | ClientTerminalStart | ClientTerminalInput | ClientTerminalResize | ClientTerminalStop;
```

`isClientMessage` 中 `t === 'ping' ||` 后追加：

```ts
    t === 'subscribe_session' || t === 'unsubscribe_session' ||
```

- [x] **Step 3: 验证**

Run: `cd packages/shared && bun run typecheck`
Expected: 无错误

### Task 2: api hub 定向投递（TDD）

**Files:**
- Modify: `apps/api/src/ws/session.ts`
- Rewrite: `apps/api/src/ws/session.test.ts`

- [x] **Step 1: 重写测试（先失败）**

完整替换 `apps/api/src/ws/session.test.ts`：

```ts
import { describe, expect, test } from 'bun:test';
import { registerSocket } from './session';
import { createChatStreamFrame, createEvent } from './protocol';

function createMockSocket() {
  return {
    sent: [] as string[],
    send(data: string) {
      this.sent.push(data);
    },
  };
}

describe('ws session hub', () => {
  test('delivers global events to all sockets regardless of subscription', () => {
    const hub = registerSocket();
    const a = createMockSocket();
    const b = createMockSocket();
    hub.attach(a);
    hub.attach(b);

    hub.broadcast(createEvent('tree.changed', { project_id: 'p1' }, { project_id: 'p1' }));
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
  });

  test('broadcasts session.runtime_status_changed to all sockets by design', () => {
    const hub = registerSocket();
    const subscribed = createMockSocket();
    const unsubscribed = createMockSocket();
    hub.attach(subscribed);
    hub.attach(unsubscribed);
    hub.handleClientMessage(subscribed, { kind: 'client', type: 'subscribe_session', payload: { session_id: 's1' } });

    hub.sendToSession('s1', createEvent('session.runtime_status_changed', { runtime_status: 'running' }, { session_id: 's1' }));
    expect(subscribed.sent).toHaveLength(1);
    expect(unsubscribed.sent).toHaveLength(1); // 全局：侧边栏需要所有会话状态
  });

  test('delivers chat_stream only to sockets subscribed to the session', () => {
    const hub = registerSocket();
    const subscriber = createMockSocket();
    const other = createMockSocket();
    hub.attach(subscriber);
    hub.attach(other);
    hub.handleClientMessage(subscriber, { kind: 'client', type: 'subscribe_session', payload: { session_id: 's1' } });

    hub.sendToSession('s1', createChatStreamFrame('s1', 'delta', 'stream_1', 'msg_1', 'hello'));
    expect(subscriber.sent).toHaveLength(1);
    expect(other.sent).toHaveLength(0);
  });

  test('stops delivering chat_stream after unsubscribe', () => {
    const hub = registerSocket();
    const socket = createMockSocket();
    hub.attach(socket);
    hub.handleClientMessage(socket, { kind: 'client', type: 'subscribe_session', payload: { session_id: 's1' } });
    hub.handleClientMessage(socket, { kind: 'client', type: 'unsubscribe_session', payload: { session_id: 's1' } });

    hub.sendToSession('s1', createChatStreamFrame('s1', 'delta', 'stream_1', 'msg_1', 'hello'));
    expect(socket.sent).toHaveLength(0);
  });

  test('delivers session-scoped events only to subscribers', () => {
    const hub = registerSocket();
    const subscriber = createMockSocket();
    const other = createMockSocket();
    hub.attach(subscriber);
    hub.attach(other);
    hub.handleClientMessage(subscriber, { kind: 'client', type: 'subscribe_session', payload: { session_id: 's1' } });

    hub.broadcast(createEvent('runtime.restored', {}, { project_id: 'p1', session_id: 's1' }));
    expect(subscriber.sent).toHaveLength(1);
    expect(other.sent).toHaveLength(0);
  });

  test('delivers terminal messages only to sockets subscribed to the terminal session', () => {
    const hub = registerSocket();
    const subscriber = createMockSocket();
    const other = createMockSocket();
    hub.attach(subscriber);
    hub.attach(other);
    hub.handleClientMessage(subscriber, { kind: 'client', type: 'subscribe_session', payload: { session_id: 'term-1' } });

    hub.broadcast({ kind: 'terminal', type: 'terminal_output', payload: { sessionId: 'term-1', data: 'out' } });
    expect(subscriber.sent).toHaveLength(1);
    expect(other.sent).toHaveLength(0);
  });

  test('sendToSession ignores the sessionId argument and filters by message content', () => {
    const hub = registerSocket();
    const socket = createMockSocket();
    hub.attach(socket);

    // 未订阅 → chat_stream 不投递（即使 sessionId 参数匹配）
    hub.sendToSession('s9', createChatStreamFrame('s9', 'complete', 'stream_9', 'msg_9'));
    expect(socket.sent).toHaveLength(0);
  });

  test('detach removes socket and its subscriptions', () => {
    const hub = registerSocket();
    const socket = createMockSocket();
    hub.attach(socket);
    hub.detach(socket);
    // detach 后 broadcast 不应抛错也不应投递
    hub.sendToSession('s1', createChatStreamFrame('s1', 'delta', 'stream_1', 'msg_1', 'x'));
    expect(socket.sent).toHaveLength(0);
  });
});
```

- [x] **Step 2: 运行确认失败**

Run: `cd apps/api && bun test src/ws/session.test.ts`
Expected: FAIL（现实现恒广播）

- [x] **Step 3: 重写 session.ts**

完整替换 `apps/api/src/ws/session.ts`：

```ts
import type { ClientMessage, ServerMessage } from '@piplus/shared/ws';

type AttachedSocket = {
  send(data: string): void;
};

const sockets = new Set<AttachedSocket>();
const subscriptions = new WeakMap<AttachedSocket, Set<string>>();

function isSubscribed(ws: AttachedSocket, sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  return subscriptions.get(ws)?.has(sessionId) ?? false;
}

/**
 * 服务端按会话定向过滤：
 * - 全局事件（无 scope.session_id）与 session.runtime_status_changed 广播给所有连接
 *   （侧边栏需要所有会话的运行状态）
 * - chat_stream、terminal 及其余会话私有事件仅投递给已订阅该会话的连接
 */
function shouldDeliver(message: ServerMessage, ws: AttachedSocket): boolean {
  if (message.kind === 'event') {
    if (!message.scope?.session_id) return true;
    if (message.type === 'session.runtime_status_changed') return true;
    return isSubscribed(ws, message.scope.session_id);
  }
  if (message.kind === 'chat_stream') {
    return isSubscribed(ws, message.scope.session_id);
  }
  if (message.kind === 'terminal') {
    return isSubscribed(ws, message.payload.sessionId);
  }
  return true;
}

function deliver(message: ServerMessage) {
  const payload = JSON.stringify(message);
  for (const ws of sockets) {
    if (!shouldDeliver(message, ws)) continue;
    try {
      ws.send(payload);
    } catch (err) {
      console.warn('[ws-session] send failed, removing socket', err);
      sockets.delete(ws);
      subscriptions.delete(ws);
    }
  }
}

export function registerSocket() {
  const hub = {
    attach(ws: AttachedSocket) {
      sockets.add(ws);
      subscriptions.set(ws, new Set());
    },
    detach(ws: AttachedSocket) {
      sockets.delete(ws);
      subscriptions.delete(ws);
    },
    handleClientMessage(ws: AttachedSocket, message: ClientMessage) {
      if (message.type === 'subscribe_session') {
        subscriptions.get(ws)?.add(message.payload.session_id);
      } else if (message.type === 'unsubscribe_session') {
        subscriptions.get(ws)?.delete(message.payload.session_id);
      }
    },
    broadcast(message: ServerMessage) {
      deliver(message);
    },
    /**
     * 兼容保留：投递完全由消息内容（scope/payload.session_id）+ 各连接订阅集合决定，
     * sessionId 参数仅为兼容既有调用点而保留，不参与过滤。
     */
    sendToSession(_sessionId: string, message: ServerMessage) {
      deliver(message);
    },
  };
  return hub;
}
```

注意：原文件的 `setContext` 方法被移除——检查 `apps/api/src/ws/server.ts` 中 `socketHub.setContext(ws, parsed.payload)` 的调用点并同步删除该调用及其上方的 `ws.send(context.updated)` 之外的引用（`context.updated` 回执事件保留不动）。`server.ts` 中不得改动任何 auth 相关代码行。

- [x] **Step 4: 运行测试通过**

Run: `cd apps/api && bun test src/ws/session.test.ts`
Expected: 8 pass

- [x] **Step 5: api 全量回归**

Run: `cd apps/api && bun test`
Expected: 仅存量 1 fail（createApp cors origin 测试），新增用例全过

### Task 3: web 前端订阅

**Files:**
- Modify: `apps/web/src/lib/ws-client.ts`
- Modify: `apps/web/src/lib/ws-provider.tsx`

- [x] **Step 1: ws-client.ts 新增方法**

在返回对象 `ping()` 之后追加：

```ts
    subscribeSession(sessionId: string) {
      safeSend({
        kind: 'client',
        type: 'subscribe_session',
        payload: { session_id: sessionId },
      } satisfies ClientMessage);
    },
    unsubscribeSession(sessionId: string) {
      safeSend({
        kind: 'client',
        type: 'unsubscribe_session',
        payload: { session_id: sessionId },
      } satisfies ClientMessage);
    },
```

- [x] **Step 2: ws-provider.tsx setSessionContext 订阅切换**

在 `activeTabRef` 声明后加：

```ts
  const prevSubscribedSessionRef = useRef<string | null>(null);
```

重写 `setSessionContext` 开头部分（原有 ref 赋值与 setContext 调用保留）：

```ts
  const setSessionContext = useCallback((sessionId: string | null, projectId: string | null, activeTab: string) => {
    selectedSessionIdRef.current = sessionId;
    selectedProjectIdRef.current = projectId;
    activeTabRef.current = activeTab;
    // 服务端定向投递：切会话时退订旧会话、订阅新会话，并补拉消息
    // 弥补定向期间错过的流式中间内容
    const prev = prevSubscribedSessionRef.current;
    if (prev && prev !== sessionId) {
      socketRef.current?.unsubscribeSession(prev);
    }
    if (sessionId && sessionId !== prev) {
      socketRef.current?.subscribeSession(sessionId);
      queryClient.invalidateQueries({ queryKey: ['session', 'messages', sessionId] });
    }
    prevSubscribedSessionRef.current = sessionId;
    socketRef.current?.setContext({ /* …原有 payload 不变… */ });
  }, []);
```

- [x] **Step 3: onOpen 重连补订阅**

`onOpen` 回调中 `socket.ping();` 之后追加：

```ts
        if (selectedSessionIdRef.current) {
          socket.subscribeSession(selectedSessionIdRef.current);
          prevSubscribedSessionRef.current = selectedSessionIdRef.current;
        }
```

- [x] **Step 4: 验证**

Run: `cd apps/web && bun run lint && bun test`
Expected: 全过

### Task 4: 全量验证与提交

- [x] Run: `bun run test` → 与基线一致（仅存量 1 fail）
- [x] Run: `bun run typecheck` → 无错误
- [x] Commit（由 feature_lead 统一提交）
