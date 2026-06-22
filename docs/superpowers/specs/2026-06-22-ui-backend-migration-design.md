# UI 后端接入设计

> 将 `ui/` 目录下的新前端（Vite SPA）迁移到 `apps/web`，从 mock 数据切换到真实后端接口，完整替换旧 Next.js 前端。

## 目标

以 `ui/` 的视觉和交互为基准，迁移到 `apps/web` 目录。去掉所有 mock 数据和 `ui/server.ts` demo 后端，接入 `apps/api` 的真实 HTTP + WebSocket 接口。`apps/web` 从 Next.js 切换为 Vite SPA 项目。类型直接引用 `@piplus/shared`，无需复制。

## 迁移策略

1. 清空 `apps/web/app/`、`.next/`、`next.config.ts` 等 Next.js 专属文件
2. 将 `ui/src/`、`ui/index.html`、`ui/vite.config.ts`、`ui/tsconfig.json`、`ui/index.css` 等迁入 `apps/web/`
3. 重写 `apps/web/package.json`：替换 Next.js 依赖为 Vite + @tanstack/react-query
4. `vite.config.ts` 添加 API proxy 指向后端（默认 `localhost:3001`）
5. `ui/` 目录保留不动，由用户自行决定是否删除

## 架构

- **数据层**：引入 `@tanstack/react-query`，HTTP 调用封装在 `apps/web/src/lib/api.ts`，React Query hooks 在 `apps/web/src/lib/hooks.ts`
- **WS 层**：`apps/web/src/lib/ws-client.ts` 封装 `createWorkspaceSocket()`，协议对齐 `@piplus/shared` 的 `ClientMessage` / `ServerMessage`
- **类型**：直接 `import` 自 `@piplus/shared`（`SessionTreeNodeDTO`、`SessionInfoDTO`、`ChatMessageDTO`、`TreeResponse`、`ClientMessage`、`ServerMessage` 等）
- **状态归属**：服务端状态 → React Query；UI 状态 → `useState`
- **登录态**：token 存 `localStorage`，通过 `useAuthSession()` 检查

## 技术栈

Vite + React + TypeScript + @tanstack/react-query + react-markdown + lucide-react + framer-motion

---

## 文件结构

```
apps/web/
  index.html
  vite.config.ts          # 修改：添加 API proxy
  tsconfig.json
  package.json            # 重写：Vite 依赖 + @tanstack/react-query
  src/
    lib/
      api.ts              # fetch 包装 + 全部 HTTP 接口
      hooks.ts            # React Query hooks
      ws-client.ts        # WebSocket 连接（hello / setContext / ping / close）
      constants.ts        # API Base URL 推导逻辑
    components/
      Sidebar.tsx         # 改动：props 从 mock 数组改为真实 DTO
      TabChat.tsx         # 改动：去掉文件附加，接入真实消息/流式
      TabSessionInfo.tsx  # 改动：mock 字段替换为 SessionInfoDTO
      TabGitDiff.tsx      # 改动：按钮改为"刷新 Diff"
      Modal.tsx           # 不变
      LoginScreen.tsx     # 新增：保持 ui 风格，密码登录
    App.tsx               # 核心重构：删除全部 mock state，接入 React Query + WS
    main.tsx
    index.css
```

删除：
- `apps/web/app/` — Next.js App Router
- `apps/web/.next/` — Next.js 构建产物
- `apps/web/next.config.ts`、`next-env.d.ts`、`postcss.config.mjs`、`tailwind.config.ts`
- `apps/web/src/` 下旧前端代码（`features/new-ui/`、`adapters/`、`providers/`、旧 `components/`、旧 `lib/`）
- `apps/web/src/types.ts` 中的 mock 领域模型，保留 UI 局部类型

---

## 数据类型映射

类型全部从 `@piplus/shared` 引入。

| ui mock 字段 | 后端真实字段 | 来源 |
|---|---|---|
| `Session.name` | `SessionTreeNodeDTO.title` | `GET /api/v1/tree` |
| `Session.responsible` | `SessionTreeNodeDTO.role_template_key` | `GET /api/v1/tree` |
| `Session.status` | `SessionTreeNodeDTO.runtime_status` / `archived_at` | `GET /api/v1/tree` |
| `Session.subSessions` | `SessionTreeNodeDTO.children` | `GET /api/v1/tree` |
| `Session.model` | `SessionInfoDTO.session.current_model.label` | `GET /api/v1/sessions/:id/info` |
| `Session.description` | 无对应 → 用 `lineage` + `role_template` 摘要展示 | `GET /api/v1/sessions/:id/info` |
| `Session.files` | 无对应 → 用 `sync` 状态展示 | `GET /api/v1/sessions/:id/info` |
| `Session.tags` | 无对应 → 用 `role_template` + `prompts` 信息展示 | `GET /api/v1/sessions/:id/info` |
| `Session.gitDiffText` | 不再存 session 内 | `GET /api/v1/sessions/:id/git-diff` |
| `Message.id` | `ChatMessageDTO.id` | `GET /api/v1/sessions/:id/chat/messages` |
| `Message.content` | `ChatMessageDTO.content_text` | 同上 |
| `Message.timestamp` | `ChatMessageDTO.created_at` | 同上 |
| `Message.role` | `ChatMessageDTO.role` | 同上 |

---

## WebSocket 协议

对齐 `@piplus/shared` 的 `ClientMessage` / `ServerMessage`。

**客户端消息**：`hello` → `set_context(project_id, session_id, current_tab)` → `ping`

**服务端消息**：
- `chat_stream`（`start` / `delta` / `complete` / `error`），带 `scope.session_id` + `payload.delta`
- `event`：`session.runtime_status_changed` → 树+消息 refetch；`tree.changed` / `project.created` / `session.created` / `session.archived` / `session.updated` → 树 refetch

**WS 集成策略**：
- `runtime_status_changed`：树 refetch + 消息 refetch，`idle` 时清 streaming 状态
- `tree.changed` 系列：树 refetch
- `chat_stream`：仅在 `activeTab === 'chat'` 且 `scope.session_id` 匹配时才渲染 delta
- 连接建立后立即 `hello()` + `setContext()` + `ping()`
- tab / session 切换时重新 `setContext()`

---

## 组件级改动要点

### App.tsx
- 删除全部 mock `projects` state 和递归 helper
- 引入 React Query `QueryClientProvider`
- `useAuthSession()` 检查 token，未登录渲染 `LoginScreen`
- 树来自 `useTree()`，session 详情来自 `useSessionInfo(selectedSessionId)`
- WS 连接随 `selectedSessionId` 变化重建
- `isGenerating` → `sessionInfo?.session.runtime_status === 'running'`
- 创建项目：`mode` 切换（existing / git_clone）

### Sidebar
- Props 改为接收 `ProjectDTO[]`
- 树节点：`title` + `role_template_key` badge + `runtime_status` 圆点
- `archived_at` 控制归档态
- 保留退出/设置入口在底部

### TabChat
- 去掉 `onAttachFile` / `onDettachFile`
- 消息列表来自 `useSessionMessages()` 分页数据
- 流式内容来自 WS `chat_stream` delta 累积
- 停止生成调用 `POST /api/v1/sessions/:id/stop`
- 模型选择器下拉从 `GET /api/v1/models` 列表渲染

### TabSessionInfo
- 保留三块版式，替换内容源：
  - Milestones Checklist → `recent_events`
  - Scope Files → `sync` 状态
  - Custom Tags → `role_template.key` / `version` / `name` + `prompts` 摘要
- 去掉 "Refine Summary with AI" 按钮

### TabGitDiff
- 按钮改为"刷新 Diff"
- 数据源从 mock 改为 `GET /api/v1/sessions/:id/git-diff`

### 顶部标签栏
- 标题用 `session.title`，模型下拉从后端列表渲染，保留 Archive 按钮

### 设置弹窗
- 只保留暗黑模式切换

### 登录屏
- 保持 `ui` 视觉风格，一个密码输入框 + 登录按钮 + 错误提示，不展示邮箱
