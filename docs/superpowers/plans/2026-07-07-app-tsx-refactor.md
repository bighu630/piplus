# App.tsx 重构实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 2269 行的 App.tsx 拆分为可维护模块，消除不必要的整页刷新和重渲染

**架构：**
- Phase 1：在原有结构中修性能问题（删 tree invalidation、加 React.memo、useMemo、下沉 streaming state）
- Phase 2：将 3 个内联 Modal 抽取为独立组件，WS 连接抽取为 Context+hook，tab-scoped query 下沉

**技术栈：** React 19, @tanstack/react-query, TypeScript, Vite, Bun

---

## 文件清单

### 创建的文件
- `apps/web/src/components/CreateProjectModal.tsx`
- `apps/web/src/components/ProviderModal.tsx`
- `apps/web/src/components/ProjectSettingsModal.tsx`
- `apps/web/src/lib/ws-provider.tsx`

### 修改的文件
- `apps/web/src/App.tsx` — 大幅缩小
- `apps/web/src/components/TabChat.tsx` — 加 React.memo，接管 streamingContent/streamNote/pendingUserMessages/runtimeErrors
- `apps/web/src/components/Sidebar.tsx` — 加 React.memo
- `apps/web/src/components/TabGitDiff.tsx` — 加 React.memo，接管 query hooks
- `apps/web/src/components/TabSessionInfo.tsx` — 加 React.memo，接管 query hooks
- `apps/web/src/components/TabFiles.tsx` — 加 React.memo，接管 query hooks

### 不修改的文件
- `apps/web/src/lib/api.ts`
- `apps/web/src/lib/hooks.ts`
- `apps/web/src/lib/ws-client.ts`
- `apps/web/src/main.tsx`
- `apps/web/src/App.test.ts`

---

## 任务 1：P0 性能修复 — 删除 tree 刷新 + setQueryData 局部更新

**文件：** `apps/web/src/App.tsx`

**目标：** 删除 `chat_stream.complete` 和 `runtime_status_changed(idle)` 中的 `invalidateQueries(['tree'])`，用 `setQueryData` 局部更新 runtime 状态

- [ ] **步骤 1：chat_stream.complete 移除 tree invalidation**

在 `message.phase === 'complete'` 分支，从 `Promise.all` 数组中删除 `queryClient.invalidateQueries({ queryKey: ['tree'] })`

```tsx
// 修改前：
Promise.all([
  queryClient.refetchQueries({ queryKey: ['session', 'messages', selectedSessionId] }),
  queryClient.invalidateQueries({ queryKey: ['session', 'commands', selectedSessionId] }),
  queryClient.invalidateQueries({ queryKey: ['tree'] }),
  queryClient.invalidateQueries({ queryKey: ['session', 'info', selectedSessionId] }),
  queryClient.invalidateQueries({ queryKey: ['session', 'context-usage', selectedSessionId] }),
])

// 修改后：
Promise.all([
  queryClient.refetchQueries({ queryKey: ['session', 'messages', selectedSessionId] }),
  queryClient.invalidateQueries({ queryKey: ['session', 'commands', selectedSessionId] }),
  queryClient.invalidateQueries({ queryKey: ['session', 'info', selectedSessionId] }),
  queryClient.invalidateQueries({ queryKey: ['session', 'context-usage', selectedSessionId] }),
])
```

- [ ] **步骤 2：runtime_status_changed(idle) 用 setQueryData 替代 tree invalidation**

在 `status === 'idle'` 分支中，找到：
```tsx
Promise.all([
  queryClient.invalidateQueries({ queryKey: ['session', 'info', selectedSessionId] }),
  queryClient.invalidateQueries({ queryKey: ['session', 'messages', selectedSessionId] }),
  queryClient.invalidateQueries({ queryKey: ['tree'] }),
])
```

改为：
```tsx
// 局部更新 tree 中的 runtime_status
queryClient.setQueryData(['tree'], (old: { projects: ProjectDTO[] } | undefined) => {
  if (!old) return old;
  return {
    ...old,
    projects: old.projects.map(project => ({
      ...project,
      sessions: updateNodeRuntimeStatus(project.sessions, selectedSessionId!, 'idle'),
    })),
  };
});
Promise.all([
  queryClient.invalidateQueries({ queryKey: ['session', 'info', selectedSessionId] }),
  queryClient.invalidateQueries({ queryKey: ['session', 'messages', selectedSessionId] }),
])
```

另外，在文件顶部（或合适位置）添加辅助函数：
```tsx
function updateNodeRuntimeStatus(
  sessions: SessionTreeNodeDTO[],
  targetId: string,
  status: string
): SessionTreeNodeDTO[] {
  return sessions.map(node => {
    if (node.id === targetId) {
      return { ...node, runtime_status: status };
    }
    if (node.children?.length) {
      return { ...node, children: updateNodeRuntimeStatus(node.children, targetId, status) };
    }
    return node;
  });
}
```

需要确认 `SessionTreeNodeDTO` 有 `runtime_status` 字段。从 App.tsx 的使用来看（`currentSessionNode?.runtime_status`），确实有。

- [ ] **步骤 3：运行类型检查和测试**

```bash
cd /data/code/piplus && bun run typecheck
cd /data/code/piplus/apps/web && bun test
```

- [ ] **步骤 4：Commit**

```bash
git add apps/web/src/App.tsx
git commit -m "perf: remove unnecessary tree invalidation in chat_stream complete and runtime_status_changed"
```

---

## 任务 2：P0 性能修复 — React.memo + useMemo

**文件：** `apps/web/src/App.tsx`，`apps/web/src/components/*.tsx`

**目标：** 给大组件加 React.memo，messages sort 用 useMemo

- [ ] **步骤 1：TabChat.tsx 加 React.memo**

文件末尾：
```tsx
export default React.memo(TabChat);
```

需要导出方式改为先定义再导出。

- [ ] **步骤 2：Sidebar.tsx 加 React.memo**

文件末尾：
```tsx
export default React.memo(Sidebar);
```

- [ ] **步骤 3：TabGitDiff.tsx 加 React.memo**

文件末尾：
```tsx
export default React.memo(TabGitDiff);
```

- [ ] **步骤 4：TabSessionInfo.tsx 加 React.memo**

文件末尾：
```tsx
export default React.memo(TabSessionInfo);
```

- [ ] **步骤 5：TabFiles.tsx 加 React.memo**

文件末尾：
```tsx
export default React.memo(TabFiles);
```

- [ ] **步骤 6：messages sort 加 useMemo**

在 App.tsx 中找到：
```tsx
const messages = messagesQuery.data?.pages.flatMap((p) => p.messages).sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) ?? [];
```

改为：
```tsx
const messages = useMemo(
  () => messagesQuery.data?.pages.flatMap((p) => p.messages).sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) ?? [],
  [messagesQuery.data]
);
```

- [ ] **步骤 7：运行类型检查和测试**

```bash
cd /data/code/piplus && bun run typecheck
cd /data/code/piplus/apps/web && bun test
```

- [ ] **步骤 8：Commit**

```bash
git add apps/web/src/components/TabChat.tsx apps/web/src/components/Sidebar.tsx apps/web/src/components/TabGitDiff.tsx apps/web/src/components/TabSessionInfo.tsx apps/web/src/components/TabFiles.tsx apps/web/src/App.tsx
git commit -m "perf: add React.memo to large components and useMemo for messages sort"
```

---

## 任务 3：P0 性能修复 — streamingContent 下沉 TabChat

**文件：** `apps/web/src/App.tsx`，`apps/web/src/components/TabChat.tsx`

**目标：** streamingContent/streamNote/pendingUserMessages/runtimeErrors 从 App 下沉到 TabChat 内部管理

- [ ] **步骤 1：TabChat 内部接管 streaming state**

TabChat 内部添加：
```tsx
const [streamNote, setStreamNote] = useState('');
const [streamingContent, setStreamingContent] = useState('');
const [pendingUserMessages, setPendingUserMessages] = useState<ChatMessageDTO[]>([]);
const [runtimeErrors, setRuntimeErrors] = useState<Array<{runId: string; error: string}>>([]);
```

然后组件内部自行使用这些 state，替换原来通过 props 接收的值。

- [ ] **步骤 2：更新 TabChatProps — 移除这些 props**

```tsx
interface TabChatProps {
  messages: ChatMessageDTO[];
  pendingUserMessages: ChatMessageDTO[];  // ← 移除
  // ...
  streamNote: string;  // ← 移除
  streamingContent: string;  // ← 移除
  runtimeErrors: Array<{runId: string; error: string}>;  // ← 移除
  wsConnected?: boolean;  // ← 暂时保留，之后由 WS Provider 提供
  // ...
}
```

- [ ] **步骤 3：更新 App.tsx — 移除这些 state 和 props**

从 App 中移除：
```tsx
const [streamNote, setStreamNote] = useState('');
const [streamingContent, setStreamingContent] = useState('');
const [pendingUserMessages, setPendingUserMessages] = useState<ChatMessageDTO[]>([]);
const [runtimeErrors, setRuntimeErrors] = useState<Array<{runId: string; error: string}>>([]);
```

以及 WS handler 中对这些 state 的引用（`setStreamNote(...)`、`setStreamingContent(...)`、`setPendingUserMessages(...)`、`setRuntimeErrors(...)`）——这些需要在 TabChat 内部通过 WS 事件处理。

等等——这有一个依赖问题：WS handler 目前在 App.tsx 中，而下沉 streaming state 到 TabChat 需要 WS 事件能到达 TabChat。这意味著我们需要先做 WS Provider（任务 6），或者采用中间方案：

**过渡方案：** 先将 WS handler 中涉及 streaming state 的部分移到 TabChat 内部。但 TabChat 无法直接访问 WS socket。

更务实的做法是：**保留 WS 代码在 App 中，但 App 不再通过 props 传这些 state 给 TabChat，而是通过 Context 或 ref 回调。**

**重新设计方案**：在 Task 3 中，我们创建一个简单的 `StreamingContext` 作为过渡：

```tsx
// 在 App.tsx 中创建 Context
const StreamingContext = React.createContext<{
  streamNote: string;
  streamingContent: string;
  pendingUserMessages: ChatMessageDTO[];
  runtimeErrors: Array<{runId: string; error: string}>;
  setStreamNote: (v: string) => void;
  setStreamingContent: (v: string | ((prev: string) => string)) => void;
  setPendingUserMessages: (v: ChatMessageDTO[] | ((prev: ChatMessageDTO[]) => ChatMessageDTO[])) => void;
  setRuntimeErrors: (v: Array<{runId: string; error: string}>) => void;
}>(null!);
```

然后 App 提供 Context，TabChat 消费。但这违背了"不引入新依赖"原则，而且会增加复杂度。

**更好的方案：** 延迟 Task 3 到 Task 6（WS Provider）之后。先做 WS Provider，然后 TabChat 直接通过 `useWebSocket` 订阅事件。

所以调整顺序：Task 3 → 先做 WS Provider（原 Task 6），然后 TabChat 下沉 streaming state。

**新任务顺序：**
- Task 1: 删除 tree 刷新
- Task 2: React.memo + useMemo
- Task 3: WS Provider
- Task 4: streamingContent 下沉（基于 WS Provider）
- Task 5: CreateProjectModal
- Task 6: ProviderModal
- Task 7: ProjectSettingsModal
- Task 8: Tab-scoped query 下沉

- [ ] **步骤 4：调整计划后，Commit 计划**

```bash
git add docs/superpowers/plans/2026-07-07-app-tsx-refactor.md
git commit -m "docs: update plan with reordered tasks"
```

---

## 任务 3（调整后）：WS Provider — `lib/ws-provider.tsx`

**创建：** `apps/web/src/lib/ws-provider.tsx`

**修改：** `apps/web/src/App.tsx`

这是一个核心任务。创建 WebSocket Context + Provider + hooks。

- [ ] **步骤 1：创建 ws-provider.tsx**

```tsx
import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import type { ServerMessage } from '@piplus/shared';
import { createWorkspaceSocket } from './ws-client';
import { useQueryClient } from '@tanstack/react-query';
import type { ProjectDTO, SessionTreeNodeDTO } from '@piplus/shared';

// --- types ---
type RuntimeStatus = 'running' | 'idle';

interface WebSocketContextValue {
  connected: boolean;
  localRuntimeStatusBySession: Record<string, RuntimeStatus>;
  setRuntimeStatus: (sessionId: string, status: RuntimeStatus) => void;
  clearRuntimeStatus: (sessionId: string) => void;
  resetRuntimeStatuses: () => void;
}

const WebSocketContext = createContext<WebSocketContextValue | null>(null);

// --- helper ---
function updateNodeRuntimeStatus(
  sessions: SessionTreeNodeDTO[],
  targetId: string,
  status: string
): SessionTreeNodeDTO[] {
  return sessions.map(node => {
    if (node.id === targetId) {
      return { ...node, runtime_status: status };
    }
    if (node.children?.length) {
      return { ...node, children: updateNodeRuntimeStatus(node.children, targetId, status) };
    }
    return node;
  });
}

// --- Provider ---
export function WebSocketProvider({
  children,
  selectedSessionId,
  selectedProjectId,
  activeTab,
  onSelectSession,
}: {
  children: React.ReactNode;
  selectedSessionId: string | null;
  selectedProjectId: string | null;
  activeTab: string;
  onSelectSession: (projectId: string, sessionId: string) => void;
}) {
  const [connected, setConnected] = useState(false);
  const [localRuntimeStatusBySession, setLocalRuntimeStatusBySession] = useState<Record<string, RuntimeStatus>>({});
  const queryClient = useQueryClient();

  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const selectedProjectIdRef = useRef(selectedProjectId);
  selectedProjectIdRef.current = selectedProjectId;
  const selectedSessionIdRef = useRef(selectedSessionId);
  selectedSessionIdRef.current = selectedSessionId;
  const onSelectSessionRef = useRef(onSelectSession);
  onSelectSessionRef.current = onSelectSession;

  // System notification refs
  const notifiedRef = useRef<Set<string>>(new Set());
  const NOTIFIABLE_ROLE_KEYS = useRef(new Set(['planner', 'feature_lead', 'bugfix_lead']));
  const NOTIFICATION_ROLE_LABELS: Record<string, string> = {
    planner: 'Planner',
    feature_lead: 'Feature Lead',
    bugfix_lead: 'Bugfix Lead',
  };

  function notifyChatStreamError(message: any) {
    if (!message.scope?.session_id) return;
    const sessionId = message.scope.session_id;
    const errorText = message.payload?.error ?? 'Unknown agent loop error';
    const treeData = queryClient.getQueryData<{ projects: ProjectDTO[] }>(['tree']);
    if (!treeData) return;
    const node = findSessionNode(treeData.projects, sessionId);
    if (!node || !NOTIFIABLE_ROLE_KEYS.current.has(node.role_template_key)) return;
    const errorKey = `error:${sessionId}:${errorText}`;
    if (notifiedRef.current.has(errorKey)) return;
    notifiedRef.current.add(errorKey);
    const label = NOTIFICATION_ROLE_LABELS[node.role_template_key] ?? node.role_template_key;
    // sendSystemNotification would need to be imported
  }

  function notifyRuntimeStatusChanged(message: any) {
    if (!message.scope?.session_id) return;
    // Similar notification logic
  }

  useEffect(() => {
    if (!selectedSessionId) return;

    const socket = createWorkspaceSocket({
      onMessage(event) {
        try {
          const message = JSON.parse(event.data as string) as ServerMessage;
          
          // Chat stream events
          if (message.kind === 'chat_stream' && message.scope?.session_id === selectedSessionId) {
            const msg = message as any;
            if (msg.phase === 'complete') {
              Promise.all([
                queryClient.refetchQueries({ queryKey: ['session', 'messages', selectedSessionId] }),
                queryClient.invalidateQueries({ queryKey: ['session', 'commands', selectedSessionId] }),
                queryClient.invalidateQueries({ queryKey: ['session', 'info', selectedSessionId] }),
                queryClient.invalidateQueries({ queryKey: ['session', 'context-usage', selectedSessionId] }),
              ]);
            }
            if (msg.phase === 'error') {
              // System notification
              if (NOTIFIABLE_ROLE_KEYS.current) {
                notifyChatStreamError(msg);
              }
            }
          }

          // Runtime status changed
          if (message.kind === 'event' && message.type === 'session.runtime_status_changed') {
            const eventSessionId = message.scope?.session_id as string | undefined;
            const status = message.payload?.runtime_status as RuntimeStatus | undefined;

            if (eventSessionId && status) {
              setLocalRuntimeStatusBySession(prev => ({ ...prev, [eventSessionId]: status }));
            }

            // Refetch tree sidebar badge
            queryClient.refetchQueries({ queryKey: ['tree'] });

            if (status === 'running') {
              if (eventSessionId === selectedSessionId) {
                queryClient.invalidateQueries({ queryKey: ['session', 'messages', selectedSessionId] });
              }
              if (eventSessionId) {
                notifiedRef.current.delete(`done:${eventSessionId}`);
              }
            }

            if (status === 'idle') {
              if (eventSessionId === selectedSessionId) {
                Promise.all([
                  queryClient.invalidateQueries({ queryKey: ['session', 'info', selectedSessionId] }),
                  queryClient.invalidateQueries({ queryKey: ['session', 'messages', selectedSessionId] }),
                ]);
                // Clear the local override
                setLocalRuntimeStatusBySession(prev => {
                  const { [selectedSessionId!]: _, ...rest } = prev;
                  return rest;
                });
              } else {
                if (eventSessionId) {
                  queryClient.invalidateQueries({ queryKey: ['session', 'info', eventSessionId] });
                  queryClient.invalidateQueries({ queryKey: ['session', 'messages', eventSessionId] });
                }
                setLocalRuntimeStatusBySession(prev => {
                  const { [eventSessionId!]: _, ...rest } = prev;
                  return rest;
                });
              }

              // Local tree update for sidebar
              if (eventSessionId) {
                queryClient.setQueryData(['tree'], (old: { projects: ProjectDTO[] } | undefined) => {
                  if (!old) return old;
                  return {
                    ...old,
                    projects: old.projects.map(project => ({
                      ...project,
                      sessions: updateNodeRuntimeStatus(project.sessions, eventSessionId!, 'idle'),
                    })),
                  };
                });
              }

              if (NOTIFIABLE_ROLE_KEYS.current) {
                notifyRuntimeStatusChanged(message);
              }
            }
          }

          // Tree/session events
          if (message.kind === 'event' && (
            message.type === 'tree.changed' ||
            message.type === 'project.created' ||
            message.type === 'session.created' ||
            message.type === 'session.archived'
          )) {
            queryClient.refetchQueries({ queryKey: ['tree'] });
          }

          if (message.kind === 'event' && message.type === 'runtime.restored') {
            if (selectedSessionId) {
              queryClient.invalidateQueries({ queryKey: ['session', 'commands', selectedSessionId] });
              queryClient.invalidateQueries({ queryKey: ['session', 'info', selectedSessionId] });
            }
          }

          if (message.kind === 'event' && (
            message.type === 'session.compaction_end' ||
            message.type === 'session.compacted'
          )) {
            const eventSessionId = (message.payload as Record<string, unknown>)?.session_id ?? selectedSessionId;
            if (typeof eventSessionId === 'string' && eventSessionId) {
              queryClient.invalidateQueries({ queryKey: ['session', 'context-usage', eventSessionId] });
            }
          }
        } catch {}
      },
      onOpen() {
        setConnected(true);
        setLocalRuntimeStatusBySession({});
        socket.hello();
        socket.setContext({
          project_id: selectedProjectIdRef.current ?? undefined,
          session_id: selectedSessionId,
          current_tab: activeTabRef.current === 'info' ? 'session_info'
            : activeTabRef.current === 'diff' ? 'git_diff'
            : activeTabRef.current === 'files' || activeTabRef.current === 'doce' ? 'files'
            : 'chat',
        });
        socket.ping();
        queryClient.refetchQueries({ queryKey: ['tree'] });
        if (selectedSessionId) {
          queryClient.invalidateQueries({ queryKey: ['session', 'info', selectedSessionId] });
          queryClient.invalidateQueries({ queryKey: ['session', 'messages', selectedSessionId] });
        }
      },
      onClose() {
        setConnected(false);
      },
    });

    return () => {
      socket.close();
    };
  }, [selectedSessionId, queryClient]);

  // Update context when active tab changes
  useEffect(() => {
    if (!selectedSessionId) return;
    // Would need socket ref - store socket in a ref
  }, [activeTab, selectedProjectId, selectedSessionId]);

  const setRuntimeStatus = useCallback((sessionId: string, status: RuntimeStatus) => {
    setLocalRuntimeStatusBySession(prev => ({ ...prev, [sessionId]: status }));
  }, []);

  const clearRuntimeStatus = useCallback((sessionId: string) => {
    setLocalRuntimeStatusBySession(prev => {
      const { [sessionId]: _, ...rest } = prev;
      return rest;
    });
  }, []);

  const resetRuntimeStatuses = useCallback(() => {
    setLocalRuntimeStatusBySession({});
  }, []);

  return (
    <WebSocketContext.Provider value={{
      connected,
      localRuntimeStatusBySession,
      setRuntimeStatus,
      clearRuntimeStatus,
      resetRuntimeStatuses,
    }}>
      {children}
    </WebSocketContext.Provider>
  );
}

// --- hooks ---
export function useWebSocket() {
  const ctx = useContext(WebSocketContext);
  if (!ctx) throw new Error('useWebSocket must be used within WebSocketProvider');
  return ctx;
}

export function useWebSocketConnected() {
  return useWebSocket().connected;
}

export function useRuntimeStatus(sessionId: string | null): RuntimeStatus {
  const { localRuntimeStatusBySession } = useWebSocket();
  // This will be combined with actual tree data in App
  return localRuntimeStatusBySession[sessionId ?? ''] ?? 'idle';
}

// findSessionNode helper (moved from App.tsx)
function findSessionNode(projects: ProjectDTO[], sessionId: string): SessionTreeNodeDTO | null {
  for (const project of projects) {
    const stack = [...project.sessions];
    while (stack.length > 0) {
      const node = stack.shift()!;
      if (node.id === sessionId) return node;
      stack.push(...node.children);
    }
  }
  return null;
}
```

- [ ] **步骤 2：在 App.tsx 中使用 WebSocketProvider**

包裹返回的 JSX：
```tsx
<WebSocketProvider
  selectedSessionId={selectedSessionId}
  selectedProjectId={selectedProjectId}
  activeTab={activeTab}
  onSelectSession={handleSelectSession}
>
  {/* existing JSX */}
</WebSocketProvider>
```

移除 App 中的：
- `wsConnected` state
- `localRuntimeStatusBySession` state
- socketRef
- WS connection useEffect
- WS setContext useEffect
- WS handler logic

改为使用：
```tsx
const { connected: wsConnected, localRuntimeStatusBySession } = useWebSocket();
```

- [ ] **步骤 3：运行类型检查和测试**

```bash
cd /data/code/piplus && bun run typecheck
cd /data/code/piplus/apps/web && bun test
```

- [ ] **步骤 4：Commit**

```bash
git add apps/web/src/lib/ws-provider.tsx apps/web/src/App.tsx
git commit -m "feat: extract WebSocket logic into WebSocketProvider context + hooks"
```

---

## 任务 4：Streaming state 下沉到 TabChat（基于 WS Provider）

**文件：** `apps/web/src/components/TabChat.tsx`，`apps/web/src/App.tsx`

- [ ] **步骤 1：TabChat 内部通过 ref 接收 WS 消息**

由于 WS 由 Provider 管理，TabChat 需要监听 chat_stream 事件。方案：在 TabChat 中创建一个独立的 WS 消息监听机制。

最简单的方式：用 `useEffect` 结合一个全局事件系统，或者通过 Provider 暴露消息流。

更实际的方式：在 App.tsx 中，WS 消息仍由 Provider 处理，但 streaming 事件通过回调或 ref 传递给 TabChat。

**最佳实际方案**：TabChat 通过 props 接收 `onStreamEvent` 回调的注册能力。WS Provider 在收到 `chat_stream` 事件时调用这些回调。

**简化方案**（不增加复杂度）：直接在 App 中用 ref 保持 streaming state，传递给 TabChat。这在 WS Provider 分离后仍是最干净的方式——因为 WS 逻辑虽然移至 Provider，但 streaming state 是 TabChat 相关的 UI state。

**结论**：我们用一个 `StreamEventBus` 模式——Provider 在收到消息时发出事件，TabChat 通过 props 注册 listener。

```tsx
// ws-provider.tsx 中添加
const streamEventCallbacksRef = useRef<Set<(msg: any) => void>>(new Set());

// Provider 添加方法
const onStreamEvent = useCallback((cb: (msg: any) => void) => {
  streamEventCallbacksRef.current.add(cb);
  return () => { streamEventCallbacksRef.current.delete(cb); };
}, []);

// 在 chat_stream handler 中
if (message.kind === 'chat_stream' && message.scope?.session_id === selectedSessionId) {
  streamEventCallbacksRef.current.forEach(cb => cb(message));
}
```

TabChat 通过 props 接收 `onStreamEvent` 注册函数或直接用 `useWebSocket().onStreamEvent`。

**但我注意到这个方案过于复杂。** 更简单的方式：TabChat 用 `useEffect` + 一个 ref，App 在渲染时把 streaming state 作为 props 传入。WS Provider 管理连接和 runtime 状态，但聊天流的 UI state 仍从 App 下传。

**更务实的选择：** 不把 WS 中所有的 chat_stream 逻辑移出 App，只移出管理性的 WS 逻辑（连接、重连、context 设置、tree/event 处理）。chat_stream 相关逻辑仍留在 App 中，但 streaming state 本身传给 TabChat——或者我们保留 streaming state 在 App 但用 `React.memo` 保证只有 streamingContent 变化时 TabChat 才重渲染。

实际上，由于我们已经加了 `React.memo(TabChat)`，TabChat 只会在相关 props 变化时重渲染。如果 streamingContent 变化了，TabChat 确实需要重渲染。所以 state 在 App 还是 TabChat 里其实差异不大。

**结论：跳过 Task 4 的 streamingContent 下沉**，因为 React.memo 已经解决了过度重渲染问题。streamingContent 本身就有变化频率高的特性，它在哪都差不多。

或者我们可以把 streaming 逻辑放到 TabChat 内部，通过一个简单的全局事件总线。

让我重新思考... 当前 App.tsx 中的 streaming state 被 WS handler 更新。如果 WS handler 移到了 Provider，我们需要一种方式让 streaming state 能被 TabChat 访问。

**最终方案：在 ws-provider.tsx 中添加一个流事件总线**

Provider 中：
```tsx
const streamListenersRef = useRef<Set<(msg: any) => void>>(new Set());

const subscribeToStream = useCallback((cb: (msg: any) => void) => {
  streamListenersRef.current.add(cb);
  return () => { streamListenersRef.current.delete(cb); };
}, []);
```

在 WS onMessage 中，当收到 `chat_stream` 消息时调用 listeners。

App.tsx 中 TabChat 接收：
```tsx
<TabChat
  subscribeToStream={subscribeToStream}
  ...
/>
```

TabChat 内部：
```tsx
useEffect(() => {
  return subscribeToStream((msg) => {
    // handle delta, start, complete, error phases
  });
}, [subscribeToStream]);
```

这样就不需要 App 管理层 streaming state 了。

好的，我确定这个方案，更新 Task 4。

- [ ] **步骤 1：ws-provider.tsx 添加 subscribeToStream**

在 Context value 中添加 `subscribeToStream` 方法。

- [ ] **步骤 2：TabChat.tsx 内部管理 streaming state**

添加 state：
```tsx
const [streamNote, setStreamNote] = useState('');
const [streamingContent, setStreamingContent] = useState('');
const [pendingUserMessages, setPendingUserMessages] = useState<ChatMessageDTO[]>([]);
const [runtimeErrors, setRuntimeErrors] = useState<Array<{runId: string; error: string}>>([]);
```

通过 `subscribeToStream` 订阅 chat_stream 事件：
```tsx
useEffect(() => {
  return subscribeToStream((message) => {
    const msg = message as any;
    if (msg.phase === 'start') {
      setStreamingContent('');
      setRuntimeErrors([]);
      setStreamNote(`${msg.phase} · streaming`);
    } else if (msg.phase === 'delta') {
      setStreamingContent((prev) => prev + (msg.payload?.delta ?? ''));
    } else if (msg.phase === 'complete') {
      setStreamNote('');
      setPendingUserMessages([]);
      // Delay clearing streamingContent to allow render
      setTimeout(() => setStreamingContent(''), 0);
    } else if (msg.phase === 'error') {
      setRuntimeErrors([{ runId: msg.payload?.stream_id ?? 'unknown', error: msg.payload?.error ?? 'Unknown error' }]);
      setStreamingContent('');
    }
  });
}, [subscribeToStream]);
```

同时处理 send 时的 optimistic message：
```tsx
const handleSend = async (content: string, attachments: any[]) => {
  const optimisticId = `optimistic_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const optimisticMessage: ChatMessageDTO = {
    id: optimisticId,
    role: 'user',
    message_kind: 'normal',
    source_session_id: null,
    content_text: content,
    content_blocks: [{ type: 'text', text: content }],
    created_at: new Date().toISOString(),
  };
  setPendingUserMessages((prev) => [...prev, optimisticMessage]);
  try {
    await onSend(content, attachments);
    queryClient.invalidateQueries({ queryKey: ['session', 'messages', selectedSessionId] });
  } catch {
    setPendingUserMessages((prev) => prev.filter((m) => m.id !== optimisticId));
  }
};
```

- [ ] **步骤 3：从 App.tsx 移除 streaming state**

移除：
- `streamNote` state
- `streamingContent` state
- `pendingUserMessages` state
- `runtimeErrors` state

以及 WS handler 中对它们的引用（"WS handler 在 Task 3 已移到 Provider，所以这些引用已在 Task 3 移除"）

所以 Task 4 主要是修改 TabChat 的 props 和相关逻辑。

从 App.tsx 移除的 props：
- `pendingUserMessages={pendingUserMessages}`
- `streamNote={streamNote}`
- `streamingContent={streamingContent}`
- `runtimeErrors={runtimeErrors}`

新增 props：
- `subscribeToStream={subscribeToStream}`

- [ ] **步骤 4：运行类型检查和测试**

```bash
cd /data/code/piplus && bun run typecheck
cd /data/code/piplus/apps/web && bun test
```

- [ ] **步骤 5：Commit**

```bash
git add apps/web/src/lib/ws-provider.tsx apps/web/src/components/TabChat.tsx apps/web/src/App.tsx
git commit -m "perf: sink streaming state into TabChat via subscribeToStream"
```

---

## 任务 5：CreateProjectModal

**创建：** `apps/web/src/components/CreateProjectModal.tsx`

**修改：** `apps/web/src/App.tsx`

- [ ] **步骤 1：创建 CreateProjectModal.tsx**

```tsx
import React, { useState } from 'react';
import Modal from './Modal';
import Select from './Select';
import { PlusCircle } from 'lucide-react';
import { useModels, useCreateProjectMutation, useSetProjectRoleModelsMutation } from '../lib/hooks';

const ROLE_CONFIG_KEYS = [
  { key: 'planner', label: '负责人' },
  { key: 'worker', label: '执行者' },
  { key: 'reviewer', label: '审查者' },
  { key: 'feature_lead', label: '需求负责人' },
  { key: 'bugfix_lead', label: 'Bug负责人' },
  { key: 'blank', label: '空白' },
];

const CONFIGURABLE_ROLE_KEYS = ROLE_CONFIG_KEYS.filter((r) => r.key !== 'planner');

const THINKING_LABELS: Record<string, string> = {
  off: '思考：关',
  minimal: '思考：最低',
  low: '思考：低',
  medium: '思考：中',
  high: '思考：高',
  xhigh: '思考：最高',
};

interface CreateProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (projectId: string, sessionId: string) => void;
}

export default function CreateProjectModal({ isOpen, onClose, onCreated }: CreateProjectModalProps) {
  const [createName, setCreateName] = useState('');
  const [createMode, setCreateMode] = useState<'existing' | 'git_clone'>('existing');
  const [createPath, setCreatePath] = useState('');
  const [createRepoUrl, setCreateRepoUrl] = useState('');
  const [createProjectModelKey, setCreateProjectModelKey] = useState('');
  const [createPlannerThinkingLevel, setCreatePlannerThinkingLevel] = useState('');
  const [createProjectRoleModels, setCreateProjectRoleModels] = useState<Record<string, Array<{ provider: string; id: string; thinkingLevel?: string | null }>>>({});

  const modelsQuery = useModels();
  const createProjectMut = useCreateProjectMutation();
  const setProjectRoleModelsMut = useSetProjectRoleModelsMutation();

  const getModelThinkingLevels = (modelKey: string): string[] => {
    if (!modelKey || !modelsQuery.data) return [];
    const [provider, id] = modelKey.split('/');
    if (!provider || !id) return [];
    const model = modelsQuery.data.find((m) => m.provider === provider && m.id === id);
    if (!model?.thinkingLevelMap) return [];
    return Object.keys(model.thinkingLevelMap);
  };

  const thinkingLevelOptionsForSelect = (levels: string[]) =>
    levels.map((level) => ({
      value: level,
      label: THINKING_LABELS[level] ?? level,
    }));

  const handleCreateProjectRoleModelChange = (roleKey: string, index: number, value: string) => {
    setCreateProjectRoleModels((prev) => {
      const models = [...(prev[roleKey] ?? [])];
      while (models.length <= index) {
        models.push({ provider: '', id: '', thinkingLevel: null });
      }
      if (!value) {
        models[index] = { ...models[index], provider: '', id: '' };
      } else {
        const [provider, id] = value.split('/');
        models[index] = { ...models[index], provider, id };
      }
      return { ...prev, [roleKey]: models };
    });
  };

  const handleCreateProjectRoleThinkingLevelChange = (roleKey: string, index: number, level: string) => {
    setCreateProjectRoleModels((prev) => {
      const models = [...(prev[roleKey] ?? [])];
      if (index < models.length) {
        models[index] = { ...models[index], thinkingLevel: level || null };
      }
      return { ...prev, [roleKey]: models };
    });
  };

  const handleCreateProjectAddCandidate = (roleKey: string) => {
    setCreateProjectRoleModels((prev) => {
      const models = [...(prev[roleKey] ?? [])];
      models.push({ provider: '', id: '', thinkingLevel: null });
      return { ...prev, [roleKey]: models };
    });
  };

  const handleCreateProjectRemoveCandidate = (roleKey: string, index: number) => {
    setCreateProjectRoleModels((prev) => {
      const models = [...(prev[roleKey] ?? [])];
      if (index > 0 && index < models.length) {
        models.splice(index, 1);
      }
      return { ...prev, [roleKey]: models };
    });
  };

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createName.trim()) return;
    try {
      const result = await createProjectMut.mutateAsync({
        name: createName.trim(),
        mode: createMode,
        path: createMode === 'existing' ? createPath : undefined,
        repoUrl: createMode === 'git_clone' ? createRepoUrl : undefined,
        model: createProjectModelKey ? (() => {
          const [provider, id] = createProjectModelKey.split('/');
          return provider && id
            ? {
                provider,
                id,
                label: createProjectModelKey,
                ...(createPlannerThinkingLevel ? { thinkingLevel: createPlannerThinkingLevel } : {}),
              }
            : null;
        })() : null,
      });
      const mergedRoleDefaults: Record<string, any> = {};
      for (const [roleKey, models] of Object.entries(createProjectRoleModels)) {
        if (models.length > 0 && models[0].provider && models[0].id) {
          const entry: any = {
            provider: models[0].provider,
            id: models[0].id,
          };
          if (models[0].thinkingLevel) entry.thinkingLevel = models[0].thinkingLevel;
          if (models.length > 1) {
            entry.candidateModels = models.slice(1).map(m => ({
              provider: m.provider,
              id: m.id,
              ...(m.thinkingLevel ? { thinkingLevel: m.thinkingLevel } : {}),
            }));
          }
          mergedRoleDefaults[roleKey] = entry;
        }
      }
      if (Object.keys(mergedRoleDefaults).length > 0) {
        try {
          await setProjectRoleModelsMut.mutateAsync({ projectId: result.projectId, models: mergedRoleDefaults });
        } catch { /* non-critical */ }
      }
      setCreateName('');
      setCreatePath('');
      setCreateRepoUrl('');
      setCreateProjectModelKey('');
      setCreatePlannerThinkingLevel('');
      setCreateProjectRoleModels({});
      onCreated(result.projectId, result.sessionId);
    } catch {}
  };

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={() => { onClose(); setCreateProjectRoleModels({}); setCreatePlannerThinkingLevel(''); }} title="新建项目" icon={<PlusCircle className="w-4 h-4 text-blue-600 dark:text-blue-400" />}>
      <form onSubmit={handleCreateProject} className="space-y-4">
        {/* 以下 JSX 从 App.tsx 复制，所有 state 引用替换为内部 state */}
        <div>
          <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">项目名称 <span className="text-red-500">*</span></label>
          <input required autoFocus type="text" placeholder="请输入项目名称..." value={createName} onChange={(e) => setCreateName(e.target.value)} className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 transition placeholder:text-slate-400" />
        </div>
        {/* ... 完整 JSX 从 App.tsx 的 CreateProject Modal 部分复制 ... */}
      </form>
    </Modal>
  );
}
```

由于 JSX 太长，这里用注释表示。实际实现时从 App.tsx 完整复制 CreateProject Modal 的 JSX。

- [ ] **步骤 2：App.tsx 中替换**

移除：
- `createName`, `createMode`, `createPath`, `createRepoUrl`, `createProjectModelKey`, `createPlannerThinkingLevel`, `createProjectRoleModels`, `showCreateProject` state
- `handleCreateProject`, `handleCreateProjectRoleModelChange`, `handleCreateProjectRoleThinkingLevelChange`, `handleCreateProjectAddCandidate`, `handleCreateProjectRemoveCandidate`
- `getModelThinkingLevels`, `thinkingLevelOptionsForSelect`（如果不再需要）

添加：
```tsx
import CreateProjectModal from './components/CreateProjectModal';
```

在 render 中替换：
```tsx
<CreateProjectModal
  isOpen={showCreateProject}
  onClose={() => setShowCreateProject(false)}
  onCreated={(projectId, sessionId) => {
    setShowCreateProject(false);
    setSelectedProjectId(projectId);
    setSelectedSessionId(sessionId);
    treeQuery.refetch();
  }}
/>
```

- [ ] **步骤 3：运行类型检查和测试**

```bash
cd /data/code/piplus && bun run typecheck
cd /data/code/piplus/apps/web && bun test
```

- [ ] **步骤 4：Commit**

```bash
git add apps/web/src/components/CreateProjectModal.tsx apps/web/src/App.tsx
git commit -m "refactor: extract CreateProjectModal from App.tsx"
```

---

## 任务 6：ProviderModal

**创建：** `apps/web/src/components/ProviderModal.tsx`

**修改：** `apps/web/src/App.tsx`

与 Task 5 类似，提取 Modal JSX + state + handlers。

- [ ] **步骤 1：创建 ProviderModal.tsx**

与 CreateProjectModal 相同的模式——复制 Provider Modal 的 JSX、state、handlers 到新组件。

**Props：** `isOpen, onClose`

**内部 hooks：** `useModels`, `useNativeModelProviders`, `useTestModelProviderMutation`, `useCreateModelProviderMutation`, `useSetNativeProviderApiKeyMutation`, `useQueryClient`

- [ ] **步骤 2：App.tsx 中替换**

移除 Provider 相关 state 和 handlers。

```tsx
import ProviderModal from './components/ProviderModal';
```

替换 `handleOpenProviderModal` 和 `handleCloseProviderModal` 为：
```tsx
const [showProviderModal, setShowProviderModal] = useState(false);
```

render 中替换 inline Modal 为：
```tsx
<ProviderModal
  isOpen={showProviderModal}
  onClose={() => setShowProviderModal(false)}
/>
```

- [ ] **步骤 3：运行类型检查和测试**

```bash
cd /data/code/piplus && bun run typecheck
cd /data/code/piplus/apps/web && bun test
```

- [ ] **步骤 4：Commit**

```bash
git add apps/web/src/components/ProviderModal.tsx apps/web/src/App.tsx
git commit -m "refactor: extract ProviderModal from App.tsx"
```

---

## 任务 7：ProjectSettingsModal

**创建：** `apps/web/src/components/ProjectSettingsModal.tsx`

**修改：** `apps/web/src/App.tsx`

- [ ] **步骤 1：创建 ProjectSettingsModal.tsx**

与 Task 5/6 相同。

**Props：** `isOpen, onClose, projectId: string | null`

**内部 hooks：** `useModels`, `useProjectRoleModels`, `useSetProjectRoleModelsMutation`, `usePackages`, `usePackageUpdates`, `useInstallPackageMutation`, `useRemovePackageMutation`, `useUpdatePackagesMutation`, `useTogglePackageMutation`, `useQueryClient`

- [ ] **步骤 2：App.tsx 中替换**

```tsx
import ProjectSettingsModal from './components/ProjectSettingsModal';
```

替换 inline Modal 为：
```tsx
<ProjectSettingsModal
  isOpen={showProjectSettings}
  onClose={() => setShowProjectSettings(false)}
  projectId={selectedProjectId}
/>
```

- [ ] **步骤 3：运行类型检查和测试**

```bash
cd /data/code/piplus && bun run typecheck
cd /data/code/piplus/apps/web && bun test
```

- [ ] **步骤 4：Commit**

```bash
git add apps/web/src/components/ProjectSettingsModal.tsx apps/web/src/App.tsx
git commit -m "refactor: extract ProjectSettingsModal from App.tsx"
```

---

## 任务 8：Tab-scoped query 下沉

**修改：** `apps/web/src/components/TabGitDiff.tsx`, `apps/web/src/components/TabFiles.tsx`, `apps/web/src/components/TabSessionInfo.tsx`, `apps/web/src/App.tsx`

- [ ] **步骤 1：TabGitDiff 内部使用 hooks**

当前 App.tsx 中：
```tsx
const gitDiffQuery = useSessionGitDiff(activeTab === 'diff' ? selectedSessionId : null);
const gitBranchesQuery = useGitBranches(activeTab === 'diff' ? selectedSessionId : null);
const gitCommitsQuery = useGitCommits(activeTab === 'diff' ? selectedSessionId : null, 50);
const gitShowQuery = useGitShow(...);
```

改为 TabGitDiff 内部调用这些 hooks，通过 props 接收 `selectedSessionId`。

```tsx
// TabGitDiff.tsx
import { useSessionGitDiff, useGitBranches, useGitCommits, useGitShow } from '../lib/hooks';

interface TabGitDiffProps {
  selectedSessionId: string | null;
  // 不再需要 diff/isLoading/onRefresh/branches/commits 等 props
  onPull: () => void;
  onPush: () => void;
  onCommit: (message: string) => void;
  // ...
}
```

- [ ] **步骤 2：TabFiles 内部使用 hooks**

类似地，`useSessionFileTree`、`useSessionFileContent` 移到 TabFiles 内部。

- [ ] **步骤 3：TabSessionInfo 内部使用 hooks**

`useSessionInfo` 移到 TabSessionInfo 内部。

- [ ] **步骤 4：精简 App.tsx 的 props passing**

移除已下沉的 query props，只传递必要的 ID。

- [ ] **步骤 5：运行类型检查和测试**

```bash
cd /data/code/piplus && bun run typecheck
cd /data/code/piplus/apps/web && bun test
```

- [ ] **步骤 6：Commit**

```bash
git add apps/web/src/components/TabGitDiff.tsx apps/web/src/components/TabFiles.tsx apps/web/src/components/TabSessionInfo.tsx apps/web/src/App.tsx
git commit -m "refactor: sink tab-scoped queries into respective components"
```

---

## 最终验证

```bash
cd /data/code/piplus && bun run typecheck
cd /data/code/piplus/apps/web && bun test
```
