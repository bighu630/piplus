# App.tsx 重构设计方案

## 背景

App.tsx 当前 2269 行，包含 40+ useState、25+ useCallback、10+ useEffect 以及 3 个内联 Modal。所有状态集中在顶层，一个状态变化就触发整个 App 重渲染。目标是拆分模块、消除不必要的整页刷新。

## 范围

- 只改 `apps/web/src/` 目录
- 不改任何样式（className、CSS、布局）
- 不引入新的第三方依赖
- 新增文件：组件/hooks/context

## Phase 1：P0 性能修复

### 1.1 删除 `chat_stream.complete` 中的 tree 刷新

**位置**：App.tsx WS onMessage handler，`message.phase === 'complete'` 分支

**改动**：从 `invalidateQueries` 数组中移除 `['tree']`

**原因**：消息完成不改变树结构。仅保留 messages、commands、info、context-usage 的 invalidation。

### 1.2 `runtime_status_changed(idle)` 使用 `setQueryData` 局部更新

**位置**：App.tsx WS onMessage handler，`status === 'idle'` 分支

**改动**：将 `invalidateQueries(['tree'])` 替换为 `setQueryData` 局部更新，更新当前 session 节点的 `runtime_status`

**原因**：runtime 状态变化只影响 sidebar 高亮圆点。全量刷新导致不必要的请求链。用 `setQueryData` 更新缓存数据后，sidebar 仍能实时反映状态变化。

### 1.3 React.memo 包裹大组件

**组件列表**：
- TabChat
- Sidebar
- TabGitDiff
- TabSessionInfo
- TabFiles

**原因**：这些组件接收大量 props，顶层任何 state 变化都会触发它们重渲染。React.memo 确保只有相关 props 变化时才重渲染。

### 1.4 messages sort 用 useMemo

**位置**：`const messages = messagesQuery.data?.pages.flatMap(...).sort(...)`

**改动**：包裹在 `useMemo` 中，依赖 `messagesQuery.data`

**原因**：避免每次 App 重渲染都全量排序消息列表

### 1.5 streamingContent 等下沉到 TabChat

**状态变量**：
- `streamingContent`
- `streamNote`
- `pendingUserMessages`
- `runtimeErrors`

**改动**：从 App 中移除这些 state 和相关的 props passing。TabChat 内部通过 `useWebSocket()` hook 订阅 `chat_stream` 事件自行管理。

**原因**：这些状态只影响 TabChat 的渲染，不应在 App 顶层管理。

## Phase 2：模块拆分

### 2.1 CreateProjectModal → `components/CreateProjectModal.tsx`

**接管的状态**：
- `createName, createMode, createPath, createRepoUrl, createProjectModelKey, createPlannerThinkingLevel`
- `createProjectRoleModels`
- `showCreateProject`

**接管的 handler**：
- `handleCreateProject`
- `handleCreateProjectRoleModelChange / handleCreateProjectRoleThinkingLevelChange`
- `handleCreateProjectAddCandidate / handleCreateProjectRemoveCandidate`

**Props**：`isOpen, onClose, onCreated: (projectId, sessionId) => void`

**内部调用 hooks**：
- `useModels()`
- `useCreateProjectMutation()`
- `useSetProjectRoleModelsMutation()`

### 2.2 ProviderModal → `components/ProviderModal.tsx`

**接管的状态**（~15 个）：
- `providerKey, providerBaseUrl, providerApiKey, providerAuthHeader`
- `supportsDeveloperRole, supportsReasoningEffort`
- `providerApi, providerHeaders, providerCompatJson`
- `providerTab, nativeProvider, nativeApiKey`
- `providerModels, providerError, providerTestResult, providerTestModels`

**接管的 handler**：
- `resetProviderForm`
- `handleTestProvider, handleSaveProvider`
- `handleAddProviderModel, handleRemoveProviderModel, updateProviderModel`
- `buildProviderPayload, validateProviderPayload`

**Props**：`isOpen, onClose`

### 2.3 ProjectSettingsModal → `components/ProjectSettingsModal.tsx`

**接管的状态**：
- `projectSettingsTab`
- `editRoleModelsList`
- `projectPackageSource, projectPackageError, projectPackageSuccess`

**接管的 handler**：
- `handleSaveProjectRoleModels`
- `handleEditRoleModelChange / handleEditRoleThinkingLevelChange`
- `handleEditAddCandidate / handleEditRemoveCandidate`
- 扩展管理相关 handler

**Props**：`isOpen, onClose, projectId: string | null`

### 2.4 WebSocket Provider → `lib/ws-provider.tsx`

**实现方式**：React Context + Provider + `useWebSocket()` hook

**提供的 hook**：
```ts
// 订阅特定事件
useWebSocketEvent(type: string, handler: (msg: EventMessage) => void)
// 获取连接状态
useWebSocketConnected(): boolean
// 完整消息流（用于 TabChat 内部订阅 chat_stream）
useWebSocketStream(): ServerMessage | null
```

**App.tsx 中的替换**：
- 移除内联 WS useEffect
- 移除 `wsConnected` state
- 移除 socketRef
- 用 `<WebSocketProvider>` 包裹

**TabChat 中的使用**：
- `useWebSocketEvent('chat_stream', ...)` 处理 streaming
- `useWebSocketConnected()` 获取连接状态

### 2.5 Tab-scoped query 下沉

**改动**：让各 Tab 组件内部调用自己的 hooks，不再通过 App 传递数据

| 组件 | 当前 hooks 在 App | 新位置 |
|------|------------------|--------|
| TabGitDiff | `useSessionGitDiff`, `useGitBranches`, `useGitCommits`, `useGitShow` | 组件内部 |
| TabFiles | `useSessionFileTree`, `useSessionFileContent` | 组件内部 |
| TabSessionInfo | `useSessionInfo` | 组件内部 |
| TabChat | `useSessionMessages` | 组件内部 |

**App.tsx 效果**：大幅减少 hooks、state、props 传递

## 不做的范围

- 不改任何样式
- 不引入新的第三方依赖
- 不修改 API 层（api.ts、hooks.ts）
- 不改测试（除非测试因重构而失效）

## 验证方法

每个 Phase/Step 完成后：
```bash
cd /data/code/piplus && bun run typecheck
cd /data/code/piplus/apps/web && bun test
```
