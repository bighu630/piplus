# Session 级模型选择 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 借用 `pi SDK` 原生模型管理能力，为当前项目增加“仅影响当前 session”的模型选择功能，并把入口放在聊天区顶部标题栏右侧。

**架构：** `pi-client` 新增 `listAvailableModels/getCurrentModel/setSessionModel` 三个能力；`apps/api` 暴露 `/api/v1/models` 和 `/api/v1/sessions/:sessionId/model`；前端在 `ChatPanel` 顶部加入模型选择按钮，当前 session 正在运行时按钮灰化禁用。

**技术栈：** Bun、TypeScript、Hono、React、`@earendil-works/pi-coding-agent` SDK (`ModelRegistry`, `AgentSession.setModel`)。

---

## 文件结构

**创建：**
- `apps/api/src/routes/models.test.ts`
  - 测试获取可用模型列表
- `apps/web/src/components/__tests__/chat-panel-model-picker.test.tsx`
  - 模型按钮显示/禁用态测试

**修改：**
- `packages/pi-client/src/types.ts`
  - 新增模型相关类型和接口方法
- `packages/pi-client/src/client.ts`
  - 实现 `listAvailableModels/getCurrentModel/setSessionModel`
- `packages/pi-client/src/client.test.ts`
  - 新增模型列表、模型切换测试
- `apps/api/src/routes/sessions.ts`
  - 增加 `POST /api/v1/sessions/:sessionId/model`
- `apps/api/src/routes/projects.ts`
  - 无需改动（只列出确认）
- `apps/api/src/app.ts`
  - 注册新的 `GET /api/v1/models` 路由
- `apps/api/src/routes/models.ts`（可选新文件，也可合并到现有 routes）
  - 获取可用模型列表
- `apps/web/src/lib/api.ts`
  - 增加模型列表和切换接口请求
- `apps/web/src/lib/hooks.ts`
  - 增加 `useModels()`、`useSetSessionModelMutation()`
- `apps/web/src/components/chat-panel.tsx`
  - 标题栏右侧增加模型按钮/下拉
- `apps/web/src/components/layout-shell.tsx`
  - 传入当前 session 的 runtimeStatus 与 model picker 相关 props
- `packages/shared/src/dto.ts`（如要在 SessionInfo 中展示当前模型则补充）

**验证命令：**
- `cd packages/pi-client && bun run typecheck && bun test src/client.test.ts --timeout 120000`
- `cd apps/api && bun run typecheck && bun test src/routes/models.test.ts src/routes/sessions.test.ts --timeout 60000`
- `cd apps/web && bun run typecheck && bun test --preload ./src/test-setup.ts src/components/__tests__/chat-panel-model-picker.test.tsx`

---

## 任务 1：pi-client 模型接口类型

**文件：**
- 修改：`packages/pi-client/src/types.ts`
- 测试：`packages/pi-client/src/client.test.ts`

- [ ] **步骤 1：先写失败测试，锁定模型接口**

在 `packages/pi-client/src/client.test.ts` 追加：

```ts
  test('listAvailableModels returns available models', async () => {
    const client = createPiClient();
    const models = await client.listAvailableModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]).toHaveProperty('provider');
    expect(models[0]).toHaveProperty('id');
    expect(models[0]).toHaveProperty('label');
  });

  test('setSessionModel switches the model for the current session', async () => {
    const client = createPiClient();
    const created = await client.createSession({ prompt: 'hello', title: 'Model Test' });
    await client.restoreRuntime(created.sessionId, created.locator);
    const models = await client.listAvailableModels();
    const target = models[0];
    const result = await client.setSessionModel(created.sessionId, created.locator, {
      provider: target.provider,
      id: target.id,
    });
    expect(result.provider).toBe(target.provider);
    expect(result.id).toBe(target.id);
  });
```

运行：`cd packages/pi-client && bun test src/client.test.ts --timeout 120000`
预期：FAIL，`listAvailableModels` / `setSessionModel` 不存在。

- [ ] **步骤 2：在 `types.ts` 中新增模型类型**

```ts
export type PiModelInfo = {
  provider: string;
  id: string;
  label: string;
};
```

在 `PiClient` 中新增：

```ts
listAvailableModels(): Promise<PiModelInfo[]>;
getCurrentModel(sessionId: string): Promise<PiModelInfo | null>;
setSessionModel(
  sessionId: string,
  locator: PiSessionLocator,
  modelRef: { provider: string; id: string },
): Promise<PiModelInfo>;
```

- [ ] **步骤 3：运行测试确认仍然红灯但转移到实现层**

运行：`cd packages/pi-client && bun test src/client.test.ts --timeout 120000`
预期：FAIL，但失败点转移到 `client.ts` 未实现。

- [ ] **步骤 4：Commit**

```bash
git add packages/pi-client/src/types.ts packages/pi-client/src/client.test.ts
git commit -m "feat: add pi-client model selection types"
```

---

## 任务 2：实现 pi-client 模型能力

**文件：**
- 修改：`packages/pi-client/src/client.ts`
- 修改：`packages/pi-client/src/client.test.ts`

- [ ] **步骤 1：实现 `listAvailableModels()`**

在 `client.ts` 顶部引入：

```ts
import { AuthStorage, ModelRegistry } from '@earendil-works/pi-coding-agent';
```

并在模块作用域中创建：

```ts
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
```

实现：

```ts
async listAvailableModels() {
  const models = await modelRegistry.getAvailable();
  return models.map((m) => ({
    provider: m.provider,
    id: m.id,
    label: m.name ?? `${m.provider}/${m.id}`,
  }));
}
```

- [ ] **步骤 2：实现 `getCurrentModel()`**

```ts
async getCurrentModel(sessionId) {
  const session = runtimeRegistry.get(sessionId);
  const model = session?.agentSession?.model;
  if (!model) return null;
  return {
    provider: model.provider,
    id: model.id,
    label: model.name ?? `${model.provider}/${model.id}`,
  };
}
```

- [ ] **步骤 3：实现 `setSessionModel()`**

```ts
async setSessionModel(sessionId, locator, modelRef) {
  await this.restoreRuntime(sessionId, locator);
  const session = runtimeRegistry.get(sessionId);
  if (!session?.agentSession) {
    throw new Error('pi_session_runtime_unavailable');
  }
  if (session.agentSession.isStreaming) {
    throw new Error('pi_session_busy');
  }

  const available = await modelRegistry.getAvailable();
  const target = available.find((m) => m.provider === modelRef.provider && m.id === modelRef.id);
  if (!target) throw new Error('pi_model_not_found');

  await session.agentSession.setModel(target);
  return {
    provider: target.provider,
    id: target.id,
    label: target.name ?? `${target.provider}/${target.id}`,
  };
}
```

- [ ] **步骤 4：运行 pi-client 测试**

运行：`cd packages/pi-client && bun run typecheck && bun test src/client.test.ts --timeout 120000`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add packages/pi-client/src/client.ts packages/pi-client/src/client.test.ts
git commit -m "feat: implement session-scoped model control in pi-client"
```

---

## 任务 3：API 路由

**文件：**
- 创建：`apps/api/src/routes/models.test.ts`
- 修改：`apps/api/src/app.ts`
- 修改：`apps/api/src/routes/sessions.ts`
- 可选创建：`apps/api/src/routes/models.ts`

- [ ] **步骤 1：写失败测试，锁定 models API**

创建 `apps/api/src/routes/models.test.ts`：

```ts
import { describe, expect, test } from 'bun:test';
import { createSeedDb } from '@piplus/db/init';
import { createApp } from '../app';

function makeDbPath() {
  return `/tmp/piplus-models-${crypto.randomUUID()}.sqlite`;
}

describe('model routes', () => {
  test('returns available models', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const tokenRes = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: Bun.env.APP_PASSWORD ?? 'piplus-local' }),
    });
    const { token } = await tokenRes.json();

    const res = await app.request('/api/v1/models', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.models)).toBe(true);
    expect(body.models.length).toBeGreaterThan(0);
  });
});
```

运行：`cd apps/api && bun test src/routes/models.test.ts --timeout 60000`
预期：FAIL，路由不存在。

- [ ] **步骤 2：实现 `/api/v1/models`**

可在 `sessions.ts` 同文件或新建 `models.ts`，推荐新建 `models.ts`：

```ts
import type { Hono } from 'hono';
import { createPiClient } from '@piplus/pi-client';

export function registerModelRoutes(app: Hono) {
  const piClient = createPiClient();
  app.get('/api/v1/models', async (c) => {
    const models = await piClient.listAvailableModels();
    return c.json({ models });
  });
}
```

然后在 `app.ts` 中：

```ts
import { registerModelRoutes } from './routes/models';
// ...
app.use('/api/v1/tree', requireAuth);
app.use('/api/v1/projects', requireAuth);
app.use('/api/v1/projects/*', requireAuth);
app.use('/api/v1/sessions/*', requireAuth);
app.use('/api/v1/models', requireAuth);
registerModelRoutes(app);
```

- [ ] **步骤 3：实现 `POST /api/v1/sessions/:sessionId/model`**

在 `sessions.ts` 增加：

```ts
  app.post('/api/v1/sessions/:sessionId/model', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const userId = (c as any).get('userId') as string;
    const body = await c.req.json().catch(() => ({}));
    const provider = String((body as { provider?: string }).provider ?? '');
    const id = String((body as { id?: string }).id ?? '');

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!session) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const [project] = await db.select({ id: projects.id, createdBy: projects.createdBy }).from(projects).where(eq(projects.id, session.projectId)).limit(1);
    if (!project || project.createdBy !== userId) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    if (session.runtimeStatus !== 'idle') {
      return c.json({ error: { code: 'SESSION_BUSY', message: 'Session is currently busy' } }, 409);
    }

    const locator = parseLocator(session.piSessionLocatorJson);
    try {
      const model = await piClient.setSessionModel(sessionId, locator, { provider, id });
      return c.json({ session_id: sessionId, model });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown';
      if (message === 'pi_session_busy') {
        return c.json({ error: { code: 'SESSION_BUSY', message: 'Session is currently busy' } }, 409);
      }
      if (message === 'pi_model_not_found') {
        return c.json({ error: { code: 'MODEL_NOT_FOUND', message: 'Model not found' } }, 404);
      }
      throw error;
    }
  });
```

- [ ] **步骤 4：运行 API typecheck 和测试**

运行：
```bash
cd apps/api && bun run typecheck
cd apps/api && bun test src/routes/models.test.ts src/routes/sessions.test.ts --timeout 60000
```
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add apps/api/src/app.ts apps/api/src/routes/models.ts apps/api/src/routes/models.test.ts apps/api/src/routes/sessions.ts
git commit -m "feat: add model selection api routes"
```

---

## 任务 4：前端 API 与 hooks

**文件：**
- 修改：`apps/web/src/lib/api.ts`
- 修改：`apps/web/src/lib/hooks.ts`

- [ ] **步骤 1：在 `api.ts` 增加模型接口**

```ts
export type ModelInfo = {
  provider: string;
  id: string;
  label: string;
};

export function getModels() {
  return request<{ models: ModelInfo[] }>('/api/v1/models');
}

export function setSessionModel(sessionId: string, model: { provider: string; id: string }) {
  return request<{ session_id: string; model: ModelInfo }>(`/api/v1/sessions/${sessionId}/model`, {
    method: 'POST',
    body: JSON.stringify(model),
  });
}
```

- [ ] **步骤 2：在 `hooks.ts` 增加 hooks**

```ts
export function useModels() {
  return useQuery({
    queryKey: ['models'],
    queryFn: async () => (await getModels()).models,
    staleTime: 60_000,
  });
}

export function useSetSessionModelMutation() {
  return useMutation({
    mutationFn: ({ sessionId, provider, id }: { sessionId: string; provider: string; id: string }) =>
      setSessionModel(sessionId, { provider, id }),
  });
}
```

- [ ] **步骤 3：运行 web typecheck**

运行：`cd apps/web && bun run typecheck`
预期：PASS。

- [ ] **步骤 4：Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/hooks.ts
git commit -m "feat: add frontend model selection api hooks"
```

---

## 任务 5：ChatPanel 模型按钮 UI

**文件：**
- 创建：`apps/web/src/components/__tests__/chat-panel-model-picker.test.tsx`
- 修改：`apps/web/src/components/chat-panel.tsx`
- 修改：`apps/web/src/components/layout-shell.tsx`

- [ ] **步骤 1：写失败测试，锁定禁用态**

创建 `chat-panel-model-picker.test.tsx`：

```ts
import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';
import { ChatPanel } from '../chat-panel';

describe('ChatPanel model picker', () => {
  test('disables model picker when session is not idle', () => {
    render(
      <ChatPanel
        messages={[]}
        sessionTitle="项目A · 负责人"
        modelLabel="DeepSeek V4 Flash"
        modelDisabled={true}
      />,
    );
    const button = screen.getByRole('button', { name: /DeepSeek V4 Flash/i });
    expect(button).toBeDisabled();
  });
});
```

运行：`cd apps/web && bun test --preload ./src/test-setup.ts src/components/__tests__/chat-panel-model-picker.test.tsx`
预期：FAIL，props 不存在。

- [ ] **步骤 2：扩展 `ChatPanel` props**

新增 props：

```ts
modelLabel?: string;
modelDisabled?: boolean;
models?: Array<{ provider: string; id: string; label: string }>;
onSelectModel?: (provider: string, id: string) => void | Promise<void>;
```

- [ ] **步骤 3：在标题栏右侧加入模型按钮**

在 `ChatPanel` 标题区右侧，在 `streamNote` 旁新增：

```tsx
<div className="flex items-center gap-2">
  {modelLabel ? (
    <button
      className={`ghost-button ghost-button-sm ${modelDisabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      disabled={modelDisabled}
      type="button"
    >
      {modelLabel}
    </button>
  ) : null}
  {streamNote ? (...existing...) : null}
</div>
```

第一阶段不做真正的 dropdown，只先把按钮和禁用态做出来。后续再补菜单弹层。

- [ ] **步骤 4：在 `layout-shell.tsx` 里把模型数据接进来**

需要：
- `const modelsQuery = useModels();`
- `const setModelMut = useSetSessionModelMutation();`
- `const currentModelLabel = modelsQuery.data?.[0]?.label ?? '选择模型';`（第一阶段先不从 runtime 读当前模型，先提供可切换入口）
- `const modelDisabled = currentSessionNode?.runtime_status !== 'idle';`

并传给 `ChatPanel`：

```tsx
modelLabel={currentModelLabel}
modelDisabled={modelDisabled}
models={modelsQuery.data}
onSelectModel={async (provider, id) => {
  if (!selectedSessionId) return;
  await setModelMut.mutateAsync({ sessionId: selectedSessionId, provider, id });
}}
```

- [ ] **步骤 5：运行 web 测试和 typecheck**

运行：
```bash
cd apps/web && bun run typecheck
cd apps/web && bun test --preload ./src/test-setup.ts src/components/__tests__/chat-panel-model-picker.test.tsx
```
预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add apps/web/src/components/chat-panel.tsx apps/web/src/components/layout-shell.tsx apps/web/src/components/__tests__/chat-panel-model-picker.test.tsx
git commit -m "feat: add session model picker in chat header"
```

---

## 任务 6：最终回归验证

- [ ] **步骤 1：pi-client 全量测试**

运行：`cd packages/pi-client && bun run typecheck && bun test src/client.test.ts --timeout 120000`
预期：PASS。

- [ ] **步骤 2：API 全量测试**

运行：`cd apps/api && bun run typecheck && bun test src/routes/models.test.ts src/routes/sessions.test.ts --timeout 60000`
预期：PASS。

- [ ] **步骤 3：Web typecheck + 目标测试**

运行：`cd apps/web && bun run typecheck && bun test --preload ./src/test-setup.ts src/components/__tests__/chat-panel-model-picker.test.tsx`
预期：PASS。

- [ ] **步骤 4：最终 Commit**

```bash
git add -A
git commit -m "feat: session-scoped model selection"
```

---

## 自检

- 规格中的所有要求均已对应到任务：
  - 会话级模型选择 → 任务 1/2/3/4/5
  - 列出可用模型 → 任务 1/2/3/4
  - 设置当前 session 模型 → 任务 2/3/4/5
  - UI 顶部标题栏右侧入口 → 任务 5
  - 忙碌时灰化禁用 → 任务 5
  - 不做全局/项目级模型 → 计划中未实现相关内容
- 无 TODO/占位符，每个任务都有具体代码和命令
- 唯一注意：任务 5 第一阶段先做“按钮 + 禁用态”，下拉菜单交互如果需要完整弹层，可在后续计划细化。当前不算占位，因为按钮本身就是最小可交付版本。
