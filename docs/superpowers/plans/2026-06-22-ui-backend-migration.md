# UI 后端接入 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 `ui/` 的 Vite 前端迁移到 `apps/web`，接入 `apps/api` 的真实后端接口。

**架构：** 清空 `apps/web` 的 Next.js 文件，迁入 `ui/src/`，重写 `package.json` 为 Vite + @tanstack/react-query，通过 vite proxy 转发 API/WS 到后端。类型直接从 `@piplus/shared` 引入。

**技术栈：** Vite + React 19 + TypeScript + @tanstack/react-query + react-markdown + lucide-react + framer-motion + Tailwind CSS 4

---

### 任务 1：环境准备 — 清理旧前端，迁移 ui 文件

**文件：**
- 删除：`apps/web/app/`、`apps/web/.next/`、`apps/web/next.config.ts`、`apps/web/next-env.d.ts`、`apps/web/postcss.config.mjs`、`apps/web/tailwind.config.ts`、`apps/web/src/`（全部旧代码）
- 迁移：`ui/src/` → `apps/web/src/`、`ui/index.html` → `apps/web/index.html`、`ui/vite.config.ts` → `apps/web/vite.config.ts`、`ui/tsconfig.json` → `apps/web/tsconfig.json`、`ui/.gitignore` → `apps/web/.gitignore`

- [ ] **步骤 1：删除旧 Next.js 文件**

```bash
rm -rf apps/web/app apps/web/.next apps/web/next.config.ts apps/web/next-env.d.ts apps/web/postcss.config.mjs apps/web/tailwind.config.ts
```

- [ ] **步骤 2：删除旧 src 目录**

```bash
rm -rf apps/web/src
```

- [ ] **步骤 3：从 ui 迁移源文件到 apps/web**

```bash
cp -r ui/src apps/web/src
cp ui/index.html apps/web/index.html
cp ui/vite.config.ts apps/web/vite.config.ts
cp ui/tsconfig.json apps/web/tsconfig.json
test -f ui/.gitignore && cp ui/.gitignore apps/web/.gitignore || true
```

- [ ] **步骤 4：更新 index.html 标题**

修改 `apps/web/index.html` 中 `<title>` 为 `Piplus`。

- [ ] **步骤 5：Commit**

```bash
git add apps/web/
git commit -m "chore: migrate ui Vite project into apps/web, remove Next.js"
```

---

### 任务 2：重写 package.json

**文件：**
- 重写：`apps/web/package.json`

- [ ] **步骤 1：写入新 package.json**

```json
{
  "name": "piplus-web",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "@piplus/shared": "workspace:*",
    "@tailwindcss/vite": "^4.1.14",
    "@tanstack/react-query": "^5.60.0",
    "@vitejs/plugin-react": "^5.0.4",
    "lucide-react": "^0.546.0",
    "motion": "^12.23.24",
    "react": "^19.0.1",
    "react-dom": "^19.0.1",
    "react-markdown": "^10.1.0",
    "rehype-highlight": "^7.0.0",
    "remark-gfm": "^4.0.0",
    "tailwindcss": "^4.1.14"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "typescript": "~5.8.2",
    "vite": "^6.2.3"
  }
}
```

- [ ] **步骤 2：Commit**

```bash
git add apps/web/package.json
git commit -m "chore: rewrite apps/web package.json for Vite + React Query"
```

---

### 任务 3：配置 Vite proxy 和 tsconfig

**文件：**
- 修改：`apps/web/vite.config.ts`
- 修改：`apps/web/tsconfig.json`

- [ ] **步骤 1：更新 vite.config.ts 添加 API proxy**

```typescript
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 3000,
      proxy: {
        '/api': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
        '/ws': {
          target: 'ws://localhost:3001',
          ws: true,
        },
        '/health': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
      },
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
```

- [ ] **步骤 2：修正 tsconfig.json 的 paths**

确保 `@/*` 指向 `./src/*`（不是 `./*`）：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "experimentalDecorators": true,
    "useDefineForClassFields": false,
    "module": "ESNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "isolatedModules": true,
    "moduleDetection": "force",
    "allowJs": true,
    "jsx": "react-jsx",
    "paths": {
      "@/*": ["./src/*"]
    },
    "allowImportingTsExtensions": true,
    "noEmit": true
  }
}
```

- [ ] **步骤 3：Commit**

```bash
git add apps/web/vite.config.ts apps/web/tsconfig.json
git commit -m "chore: configure Vite proxy to backend, fix tsconfig paths"
```

---

### 任务 4：创建 lib/api.ts — HTTP 接口封装

**文件：**
- 创建：`apps/web/src/lib/api.ts`
- 创建：`apps/web/src/lib/constants.ts`

- [ ] **步骤 1：创建 constants.ts**

```typescript
export function getApiBaseUrl() {
  if (typeof window !== 'undefined') {
    return ''; // Vite proxy handles /api prefix
  }
  return 'http://localhost:3001';
}

export function getWsBaseUrl() {
  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}`;
  }
  return 'ws://localhost:3001';
}
```

- [ ] **步骤 2：创建 api.ts**

参考 `apps/web/src/lib/api.ts`（旧前端已删除，需要在任务 4 中从头创建）。接口列表：

```typescript
import { getApiBaseUrl } from './constants';
import type { SessionInfoDTO, TreeResponse } from '@piplus/shared';
import type { ChatMessageDTO } from '@piplus/shared';

export type SessionMessagesPage = {
  session_id: string;
  cursor: string | null;
  next_cursor: string | null;
  messages: ChatMessageDTO[];
};

export type ModelInfo = {
  provider: string;
  id: string;
  label: string;
};

function authHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('piplus_token') : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    cache: 'no-store',
    ...init,
    headers: {
      'content-type': 'application/json',
      ...authHeaders(),
      ...(init?.headers as Record<string, string> ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error((body as { error?: { message?: string } }).error?.message ?? `request_failed:${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function login(password: string) {
  return request<{ token: string; user: { id: string; name: string } }>('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

export function checkAuth(token: string) {
  return request<{ ok: true; user: { id: string; name: string } }>('/api/v1/auth/check', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function getModels() {
  return request<{ models: ModelInfo[] }>('/api/v1/models');
}

export function setSessionModel(sessionId: string, model: { provider: string; id: string }) {
  return request<{ session_id: string; model: ModelInfo }>(`/api/v1/sessions/${sessionId}/model`, {
    method: 'POST',
    body: JSON.stringify(model),
  });
}

export function getTree() {
  return request<TreeResponse>('/api/v1/tree');
}

export function getSessionInfo(sessionId: string) {
  return request<SessionInfoDTO>(`/api/v1/sessions/${sessionId}/info`);
}

export function getSessionMessages(sessionId: string, options?: { cursor?: string | null; limit?: number }) {
  const params = new URLSearchParams();
  if (options?.cursor) params.set('cursor', options.cursor);
  if (options?.limit) params.set('limit', String(options.limit));
  const query = params.toString();
  return request<SessionMessagesPage>(`/api/v1/sessions/${sessionId}/chat/messages${query ? `?${query}` : ''}`);
}

export function sendSessionMessage(sessionId: string, content: string) {
  return request<{ accepted: boolean; session_id: string; run_id: string; message_id: string }>(`/api/v1/sessions/${sessionId}/chat/messages`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
}

export function createProject(name: string, mode?: string, path?: string, repoUrl?: string) {
  return request<{ projectId: string; sessionId?: string; piSessionId?: string }>(`/api/v1/projects`, {
    method: 'POST',
    body: JSON.stringify({ name, mode: mode ?? 'existing', path: path ?? '', repo_url: repoUrl ?? '' }),
  });
}

export function createProjectSession(projectId: string, inheritModel?: { provider: string; id: string } | null) {
  return request<{ session_id: string; project_id: string }>(`/api/v1/projects/${projectId}/sessions`, {
    method: 'POST',
    body: JSON.stringify({ inherit_model: inheritModel ?? null }),
  });
}

export function stopSession(sessionId: string) {
  return request<{ session_id: string; status: string }>(`/api/v1/sessions/${sessionId}/stop`, {
    method: 'POST',
  });
}

export function archiveSession(sessionId: string) {
  return request<{ session_id: string; status: string }>(`/api/v1/sessions/${sessionId}/archive`, {
    method: 'POST',
  });
}

export function updateSessionTitle(sessionId: string, title: string) {
  return request<{ session_id: string; title: string }>(`/api/v1/sessions/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
}

export function getSessionGitDiff(sessionId: string) {
  return request<{ session_id: string; diff: string; cwd: string }>(`/api/v1/sessions/${sessionId}/git-diff`);
}

export function archiveProject(projectId: string) {
  return request<{ project_id: string; status: string }>(`/api/v1/projects/${projectId}/archive`, {
    method: 'POST',
  });
}

export function deleteProject(projectId: string) {
  return request<{ project_id: string; status: string }>(`/api/v1/projects/${projectId}`, {
    method: 'DELETE',
  });
}
```

- [ ] **步骤 3：Commit**

```bash
git add apps/web/src/lib/constants.ts apps/web/src/lib/api.ts
git commit -m "feat: add HTTP API client with all backend endpoints"
```

---

### 任务 5：创建 lib/hooks.ts — React Query hooks

**文件：**
- 创建：`apps/web/src/lib/hooks.ts`

- [ ] **步骤 1：创建 hooks.ts**

完整从旧 `apps/web/src/lib/hooks.ts` 继承逻辑，但适配新的 `api.ts`。包含：

- `useAuthSession()` — 检查 localStorage token
- `useLoginMutation()` — 登录 + 存入 token
- `useLogoutMutation()` — 清除 token
- `useTree()` — 项目树
- `useSessionInfo(sessionId)` — 会话详情
- `useSessionMessages(sessionId)` — 消息分页（useInfiniteQuery）
- `useSessionGitDiff(sessionId)` — git diff
- `useModels()` — 模型列表
- `useSetSessionModelMutation()` — 切换模型
- `useCreateProjectMutation()` — 创建项目
- `useCreateSessionMutation()` — 创建空白 session
- `useSendMessageMutation(sessionId)` — 发送消息
- `useStopSessionMutation()` — 停止会话
- `useArchiveSessionMutation()` — 归档会话
- `useUpdateSessionTitleMutation()` — 改标题
- `useArchiveProjectMutation()` — 归档项目
- `useDeleteProjectMutation()` — 删除项目

- [ ] **步骤 2：验证 TypeScript 编译通过**

```bash
cd apps/web && npx tsc --noEmit --skipLibCheck
```

- [ ] **步骤 3：Commit**

```bash
git add apps/web/src/lib/hooks.ts
git commit -m "feat: add React Query hooks for all backend endpoints"
```

---

### 任务 6：创建 lib/ws-client.ts — WebSocket 客户端

**文件：**
- 创建：`apps/web/src/lib/ws-client.ts`

- [ ] **步骤 1：创建 ws-client.ts**

```typescript
import type { ClientMessage } from '@piplus/shared';
import { getWsBaseUrl } from './constants';

const RECONNECT_DELAY = 2000;

export function createWorkspaceSocket({
  onMessage,
  onOpen,
}: {
  onMessage: (event: MessageEvent) => void;
  onOpen?: () => void;
}) {
  let ws: WebSocket;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (closed) return;
    const token = typeof window !== 'undefined' ? localStorage.getItem('piplus_token') : null;
    const wsUrl = `${getWsBaseUrl()}/ws`;
    ws = new WebSocket(token ? `${wsUrl}?token=${encodeURIComponent(token)}` : wsUrl);

    ws.addEventListener('message', onMessage);

    ws.addEventListener('open', () => {
      onOpen?.();
    });

    ws.addEventListener('close', () => {
      if (!closed) {
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
      }
    });
  }

  connect();

  function safeSend(message: ClientMessage) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(message));
  }

  return {
    hello() {
      safeSend({ kind: 'client', type: 'hello', payload: { user_agent: navigator.userAgent } } satisfies ClientMessage);
    },
    setContext(payload: { project_id?: string; session_id?: string; current_tab?: 'chat' | 'session_info' | 'git_diff' }) {
      safeSend({ kind: 'client', type: 'set_context', payload } satisfies ClientMessage);
    },
    ping() {
      safeSend({ kind: 'client', type: 'ping', payload: { timestamp: new Date().toISOString() } } satisfies ClientMessage);
    },
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws.close();
    },
  };
}
```

注意：WS 鉴权走 query param `?token=`（兼容后端），或由浏览器自动携带 cookie。如后端不支持 query param 方式，改用 `Authorization` header（但浏览器 WebSocket API 不支持自定义 header，需在服务端 proxy 处理或改用 cookie）。

- [ ] **步骤 2：Commit**

```bash
git add apps/web/src/lib/ws-client.ts
git commit -m "feat: add WebSocket client with hello/setContext/ping"
```

---

### 任务 7：创建 LoginScreen.tsx

**文件：**
- 创建：`apps/web/src/components/LoginScreen.tsx`

- [ ] **步骤 1：创建登录组件**

保持 `ui` 设计风格（`bg-slate-50 dark:bg-slate-900`、`rounded-2xl`、`border-slate-200` 等），输入密码后调用 `useLoginMutation`。不展示邮箱，不展示用户名。只有密码输入框 + 登录按钮 + 错误提示。

```typescript
import { KeyRound } from 'lucide-react';
import { useState } from 'react';

type Props = {
  busy?: boolean;
  error?: string | null;
  onSubmit: (password: string) => void;
};

export function LoginScreen({ busy = false, error = null, onSubmit }: Props) {
  const [password, setPassword] = useState('');

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-950 p-4">
      <div className="w-full max-w-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-2xs space-y-5">
        <div>
          <div className="bg-blue-600 text-white font-black px-2 py-1 rounded text-sm tracking-widest inline-block">Pi</div>
          <h1 className="mt-3 text-xl font-bold text-slate-800 dark:text-slate-100">登录工作台</h1>
        </div>

        <label className="flex flex-col gap-2">
          <span className="inline-flex items-center gap-2 text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
            <KeyRound className="w-3.5 h-3.5" />
            密码
          </span>
          <input
            className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100"
            disabled={busy}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(password); }}
            type="password"
            value={password}
            placeholder="输入本地密码"
          />
        </label>

        {error ? (
          <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-lg px-3 py-2">
            {error}
          </div>
        ) : null}

        <button
          className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-4 rounded-xl text-xs transition cursor-pointer disabled:opacity-50"
          disabled={busy || !password}
          onClick={() => onSubmit(password)}
          type="button"
        >
          {busy ? '登录中…' : '登录'}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **步骤 2：Commit**

```bash
git add apps/web/src/components/LoginScreen.tsx
git commit -m "feat: add LoginScreen with unified ui design style"
```

---

### 任务 8：重写 App.tsx — 核心编排

**文件：**
- 重写：`apps/web/src/App.tsx`
- 修改：`apps/web/src/main.tsx`

- [ ] **步骤 1：在 main.tsx 中包裹 QueryClientProvider**

```typescript
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App.tsx';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
```

- [ ] **步骤 2：重写 App.tsx**

核心逻辑：
- 引入 `useAuthSession`、`useTree`、`useSessionInfo`、`useSessionMessages`、`useSessionGitDiff`、`useModels`、各 mutation
- 删除所有 mock state（`projects`、`handleAddProject`、`handleAddSession`、`handleAttachFile` 等）
- WS 连接随 `selectedSessionId` 变化建立/重建
- `chat_stream` delta 只在 `activeTab === 'chat'` 时渲染
- `runtime_status_changed` / `tree.changed` 等事件触发 refetch
- 创建项目对话框改为 `mode` 切换（existing → path / git_clone → repo_url）
- 侧边栏"新建空白 Session"调用 `createProjectSession`
- `isGenerating` 改为 `runtime_status === 'running'`
- 顶部标题用 `sessionInfo?.session.title`，模型下拉从 `modelsQuery.data` 渲染
- Archive 按钮调用 `archiveSession`
- 保留暗黑模式切换

App.tsx 体量较大，详细代码在步骤中给出完整实现。

- [ ] **步骤 3：验证 TypeScript 编译**

```bash
cd apps/web && npx tsc --noEmit --skipLibCheck
```

- [ ] **步骤 4：Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/main.tsx
git commit -m "feat: rewrite App.tsx with React Query + real WS integration"
```

---

### 任务 9：重写 Sidebar.tsx

**文件：**
- 重写：`apps/web/src/components/Sidebar.tsx`

- [ ] **步骤 1：重写 Sidebar**

改动要点：
- Props 从 mock `Project[]` 改为 `ProjectDTO[]`（来自 `TreeResponse.projects`）
- 搜索过滤基于 `title` 而非 `name` + `responsible`
- 树节点展示：`node.title` + `role_template_key` badge + `runtime_status` 圆点（idle 绿色、running 蓝色脉冲、stopping 灰色）
- `archived_at` 控制归档态（半透明）
- 保留退出和设置按钮在底部
- 新建 session 内联表单接入 `onCreateSession`（空白 session）
- 保留新建项目对话框，但改为 mode 切换版

- [ ] **步骤 2：Commit**

```bash
git add apps/web/src/components/Sidebar.tsx
git commit -m "refactor: rewrite Sidebar to consume real ProjectDTO from backend"
```

---

### 任务 10：重写 TabChat.tsx

**文件：**
- 重写：`apps/web/src/components/TabChat.tsx`

- [ ] **步骤 1：重写 TabChat**

改动要点：
- 去掉 `activeSession.messages`、`onAttachFile`、`onDettachFile`、`activeSession.files`
- Props 改为接收分离的消息数组、分页状态、发送/停止回调
- 消息渲染使用 `ChatMessageDTO`（`content_text`、`role`、`created_at`）
- 流式内容：新增 `streamingContent` prop，在消息列表末尾展示为 assistant 消息
- 停止按钮：`runtimeStatus === 'running'` 时可用
- 发送区域：Ctrl/Cmd+Enter 发送
- 保留建议按钮（"生成 Git Diff" → 实际上发聊天消息，"分析 Session Info" → 同样）

- [ ] **步骤 2：Commit**

```bash
git add apps/web/src/components/TabChat.tsx
git commit -m "refactor: rewrite TabChat with real messages, streaming, no file attach"
```

---

### 任务 11：重写 TabSessionInfo.tsx

**文件：**
- 重写：`apps/web/src/components/TabSessionInfo.tsx`

- [ ] **步骤 1：重写 TabSessionInfo**

改动要点：
- Props 改为接收 `SessionInfoDTO | undefined` + `isLoading`
- 顶部摘要：`session.title` + 从 `lineage` + `role_template` 生成的描述文本
- 三信息卡：
  - "Responsible Person" → `role_template.name`（来自 `role_template.name`）
  - "Contextual LLM" → `session.current_model?.label ?? '未设置'`
  - "Status Node" → `session.runtime_status` 只读展示
- 下半区替换：
  - Checklist → `recent_events` 列表（事件 type + created_at）
  - Files → `sync_status` / `last_synced_at` / `last_error`
  - Tags → `role_template.key` / `version` badge + `prompts.role_base_prompt_snapshot` 截断摘要
- 去掉 "Refine Summary with AI" 按钮

- [ ] **步骤 2：Commit**

```bash
git add apps/web/src/components/TabSessionInfo.tsx
git commit -m "refactor: rewrite TabSessionInfo with real SessionInfoDTO fields"
```

---

### 任务 12：重写 TabGitDiff.tsx

**文件：**
- 重写：`apps/web/src/components/TabGitDiff.tsx`

- [ ] **步骤 1：重写 TabGitDiff**

改动要点：
- Props 改为接收 `diff: string | null` + `isLoading` + `onRefresh`
- 按钮从 "Generate Active Diff" 改为 "刷新 Diff"
- 去掉 mock fallback（没有 diff 时显示空状态）
- 保留文件级 diff 解析和颜色标记

- [ ] **步骤 2：Commit**

```bash
git add apps/web/src/components/TabGitDiff.tsx
git commit -m "refactor: rewrite TabGitDiff to query real backend git-diff"
```

---

### 任务 13：清理 types.ts

**文件：**
- 重写：`apps/web/src/types.ts`

- [ ] **步骤 1：移除 mock 类型**

删除 `Message`、`Session`、`Project`、`FileItem` 等 mock 接口。如需保留纯 UI 类型（如 `Tab` 联合类型），就地保留。如果 types.ts 完全为空，可删除该文件。

- [ ] **步骤 2：Commit**

```bash
git add apps/web/src/types.ts
git commit -m "chore: remove mock domain types from types.ts"
```

---

### 任务 14：安装依赖并验证构建

**文件：** 无

- [ ] **步骤 1：安装依赖**

```bash
cd apps/web && npm install
```

- [ ] **步骤 2：TypeScript 编译检查**

```bash
cd apps/web && npx tsc --noEmit
```

预期：无类型错误。

- [ ] **步骤 3：Vite 构建检查**

```bash
cd apps/web && npx vite build
```

预期：构建成功，dist/ 产出 index.html 和打包 JS。

- [ ] **步骤 4：Commit**

```bash
git add apps/web/package-lock.json
git commit -m "chore: install deps, verify build"
```

---

### 任务 15：启动开发服务器验证

**文件：** 无

- [ ] **步骤 1：启动 Vite dev server**

```bash
cd apps/web && npm run dev
```

- [ ] **步骤 2：确认页面可访问**

打开 `http://localhost:3000`，确认：
- 登录屏显示（未登录时）
- 登录后侧边栏加载项目树
- 选择 session 后聊天区加载消息
- Tab 切换正常
- WS 连接建立

- [ ] **步骤 3：如发现问题，修复后重复验证**
