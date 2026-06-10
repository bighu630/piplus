# Pi Client Session Gateway 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将当前内存版 `packages/pi-client` 替换为基于 `pi SDK` 的完整会话网关，并把 `apps/api` 的会话历史、消息发送、停止和实时流桥接切换到真实 session 文件与 runtime。

**架构：** 业务主键继续使用数据库 `sessions.id`。数据库新增 `pi_session_locator_json` 存储 `pi` 会话定位信息；`packages/pi-client` 负责 `SessionManager`、runtime 恢复、流式订阅和 fork；`apps/api` 通过统一网关读取历史、触发运行并将 `pi` SDK 的流事件桥接到现有 websocket hub。

**技术栈：** Bun、TypeScript、Hono、Drizzle ORM、SQLite、`@earendil-works/pi-coding-agent` SDK、Bun test。

---

## 文件结构

**创建：**
- `packages/pi-client/src/locator.ts`
  - 定义 `PiSessionLocator`、locator 序列化/反序列化与校验函数。
- `packages/pi-client/src/history.ts`
  - 从 `SessionManager.open(sessionFile)` 读取消息历史并映射为 `PiMessagePage`。
- `packages/pi-client/src/runtime-manager.ts`
  - 维护 `Map<sessionId, ActiveSessionRuntime>`，负责恢复、订阅、发送、停止和关闭。
- `packages/pi-client/src/sdk-client.ts`
  - 使用 `pi SDK` 组装会话网关 facade。
- `packages/pi-client/src/client.test.ts`
  - 覆盖 locator、runtime 恢复、订阅、发送、stop、历史读取等核心行为。
- `apps/api/src/lib/pi-stream-bridge.ts`
  - 将 `pi-client` 的标准化流事件映射到当前 websocket `createChatStreamFrame()` / `createEvent()`。
- `apps/api/src/routes/sessions.history.test.ts`
  - 覆盖从 session 文件读取历史、断线后仍可读取历史、无效 locator 错误。
- `apps/api/src/routes/sessions.stream.test.ts`
  - 覆盖消息发送后 websocket 桥接的 `start/delta/complete/error` 事件。

**修改：**
- `packages/db/src/schema.ts`
  - 在 `sessions` 表新增 `piSessionLocatorJson` 字段，保留现有 `piSessionId` 以兼容第一阶段返回结构。
- `packages/db/migrations/0001_initial.sql`
  - 同步新增 `pi_session_locator_json` 列。
- `packages/db/src/init.ts`
  - 确保新列存在时仍能初始化旧数据库；必要时追加轻量 `ALTER TABLE` 兼容逻辑。
- `packages/pi-client/src/types.ts`
  - 用新的 facade 类型替换当前 stub 接口，增加 `subscribeSession()`、`sendMessage()` 返回 `runId`、`getHistory()`、`forkSession()` 等类型。
- `packages/pi-client/src/client.ts`
  - 改为导出真实 SDK facade，而不是内存 Map stub。
- `packages/domain/src/role-manager/service.ts`
  - 创建 session / spawn session 时保存 locator，并调整返回值与插入字段。
- `packages/domain/src/role-manager/service.test.ts`
  - 更新 stub client 和断言，校验 locator 被写入、返回值兼容。
- `packages/domain/src/extensions/registry.ts`
  - 继续返回 `pi_session_id`，但内部改为从 locator/result 读取；避免编译断裂。
- `packages/shared/src/dto.ts`
  - `SessionInfoDTO.session` 新增 `pi_session_locator_json`，保留 `pi_session_id` 兼容现有 UI。
- `apps/api/src/routes/projects.ts`
  - 创建项目/顶层 session 时走新 `pi-client` 接口。
- `apps/api/src/routes/sessions.ts`
  - 历史读取改为 `getHistory()`；发送改为 `sendMessage()` + 桥接订阅；stop 改为按业务 `sessionId` 调用；信息接口返回 locator。
- `apps/api/src/routes/projects.test.ts`
  - 更新创建项目后的断言，确保 locator 已持久化。
- `apps/api/src/routes/sessions.test.ts`
  - 用新的历史、发送、停止行为替换当前基于回声 stub 的断言。
- `apps/web/src/components/session-info-panel.tsx`
  - 如果当前面板展示 `pi_session_id`，补上对 locator 的容错展示或保留现状但适配 DTO。
- `apps/web/src/components/__tests__/session-info-panel.test.tsx`
  - 跟随 DTO 字段更新。
- `apps/web/src/lib/api.ts`
  - 如果 `GET /info` 返回新增 locator 字段，需要同步更新类型。

**测试与验证命令：**
- `bun --cwd packages/pi-client test`
- `bun --cwd apps/api test`
- `bun test packages/domain/src/role-manager/service.test.ts`
- `bun run typecheck`

## 任务 1：数据库与共享类型铺底

**文件：**
- 修改：`packages/db/src/schema.ts`
- 修改：`packages/db/migrations/0001_initial.sql`
- 修改：`packages/db/src/init.ts`
- 修改：`packages/shared/src/dto.ts`
- 测试：`apps/api/src/routes/projects.test.ts`

- [ ] **步骤 1：为会话表设计新增列并写出失败测试前的断言目标**

需要新增字段：

```ts
piSessionLocatorJson: text('pi_session_locator_json').notNull().default('{}')
```

API `session info` DTO 目标结构：

```ts
session: {
  id: string;
  pi_session_id: string;
  pi_session_locator_json: string;
}
```

在 `apps/api/src/routes/projects.test.ts` 后续断言中将检查：

```ts
expect(session?.piSessionLocatorJson).toContain('sessionFile');
```

- [ ] **步骤 2：先修改测试，制造失败**

在 `apps/api/src/routes/projects.test.ts` 的 `create project auto-creates a planner session` 末尾追加断言：

```ts
expect(session?.piSessionLocatorJson).toContain('sessionFile');
```

运行：`bun --cwd apps/api test apps/api/src/routes/projects.test.ts`
预期：FAIL，报错类似 `expected undefined to contain 'sessionFile'` 或 schema 缺字段。

- [ ] **步骤 3：修改 Drizzle schema 与初始 migration**

`packages/db/src/schema.ts` 中 `sessions` 表新增字段：

```ts
  piSessionLocatorJson: text('pi_session_locator_json').notNull().default('{}'),
```

`packages/db/migrations/0001_initial.sql` 中 `sessions` 建表语句新增列：

```sql
  pi_session_locator_json TEXT NOT NULL DEFAULT '{}',
```

- [ ] **步骤 4：为旧库初始化补兼容逻辑**

在 `packages/db/src/init.ts` 中，在 `ensureBuiltinRows(sqlite)` 前补一个辅助函数并调用：

```ts
function ensureSessionLocatorColumn(sqlite: Database) {
  const columns = sqlite.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  const hasColumn = columns.some((col) => col.name === 'pi_session_locator_json');
  if (!hasColumn) {
    sqlite.exec("ALTER TABLE sessions ADD COLUMN pi_session_locator_json TEXT NOT NULL DEFAULT '{}'");
  }
}
```

并在确认 `sessions` 表存在后执行：

```ts
  ensureSessionLocatorColumn(sqlite);
```

- [ ] **步骤 5：更新共享 DTO**

在 `packages/shared/src/dto.ts` 的 `SessionInfoDTO.session` 中新增：

```ts
    pi_session_locator_json: string;
```

保留已有：

```ts
    pi_session_id: string;
```

- [ ] **步骤 6：运行测试验证通过**

运行：`bun --cwd apps/api test apps/api/src/routes/projects.test.ts`
预期：PASS。

- [ ] **步骤 7：Commit**

```bash
git add packages/db/src/schema.ts packages/db/migrations/0001_initial.sql packages/db/src/init.ts packages/shared/src/dto.ts apps/api/src/routes/projects.test.ts
git commit -m "feat: add pi session locator storage"
```

## 任务 2：重塑 pi-client 类型边界

**文件：**
- 创建：`packages/pi-client/src/locator.ts`
- 修改：`packages/pi-client/src/types.ts`
- 测试：`packages/domain/src/role-manager/service.test.ts`

- [ ] **步骤 1：编写失败测试，锁定新接口返回 locator**

在 `packages/domain/src/role-manager/service.test.ts` 中，将 stub client 目标形状改为：

```ts
async createSession(input: { title?: string; prompt: string; tools?: unknown[]; metadata?: Record<string, unknown> }) {
  return {
    sessionId: `pi_${crypto.randomUUID().slice(0, 12)}`,
    locator: {
      piSessionId: `pi_${crypto.randomUUID().slice(0, 12)}`,
      sessionFile: `/tmp/pi-${crypto.randomUUID()}.jsonl`,
    },
  };
}
```

并新增断言：

```ts
expect(created?.piSessionLocatorJson).toContain('sessionFile');
```

运行：`bun test packages/domain/src/role-manager/service.test.ts`
预期：FAIL，类型或字段不存在。

- [ ] **步骤 2：定义 locator 类型文件**

创建 `packages/pi-client/src/locator.ts`：

```ts
export type PiSessionLocator = {
  piSessionId?: string;
  sessionFile: string;
};

export function stringifyLocator(locator: PiSessionLocator) {
  return JSON.stringify(locator);
}

export function parseLocator(raw: string): PiSessionLocator {
  const parsed = JSON.parse(raw) as Partial<PiSessionLocator>;
  if (!parsed || typeof parsed.sessionFile !== 'string' || !parsed.sessionFile) {
    throw new Error('invalid_pi_session_locator');
  }
  return {
    piSessionId: typeof parsed.piSessionId === 'string' ? parsed.piSessionId : undefined,
    sessionFile: parsed.sessionFile,
  };
}
```

- [ ] **步骤 3：扩展 pi-client 类型定义**

在 `packages/pi-client/src/types.ts` 中引入并定义新的核心类型：

```ts
import type { PiSessionLocator } from './locator';

export type PiCreateSessionResult = {
  sessionId: string;
  locator: PiSessionLocator;
};

export type PiHistoryMessage = {
  id: string;
  role: PiMessageRole;
  text: string;
  createdAt: string | null;
};

export type PiHistoryPage = {
  messages: PiHistoryMessage[];
  nextCursor: string | null;
};

export type PiRunAccepted = {
  sessionId: string;
  runId: string;
};

export type PiSessionStreamEvent =
  | { type: 'message_start'; sessionId: string; runId: string; messageId?: string }
  | { type: 'text_delta'; sessionId: string; runId: string; messageId?: string; delta: string }
  | { type: 'message_end'; sessionId: string; runId: string; messageId?: string }
  | { type: 'error'; sessionId: string; runId: string; error: string };
```

并把 `PiClient` 更新为：

```ts
export type PiClient = {
  createSession(input: PiCreateSessionInput): Promise<PiCreateSessionResult>;
  restoreRuntime(sessionId: string, locator: PiSessionLocator): Promise<void>;
  subscribeSession(sessionId: string, listener: (event: PiSessionStreamEvent) => void | Promise<void>): Promise<() => void>;
  getHistory(sessionId: string, locator: PiSessionLocator, cursor?: string | null, limit?: number): Promise<PiHistoryPage>;
  sendMessage(sessionId: string, content: string): Promise<PiRunAccepted>;
  stopSession(sessionId: string): Promise<PiStopSessionResult>;
  closeRuntime(sessionId: string): Promise<void>;
};
```

- [ ] **步骤 4：运行测试验证类型层失败已转为实现缺失**

运行：`bun test packages/domain/src/role-manager/service.test.ts`
预期：FAIL，但失败点转移到 `role-manager` 未写 locator 或 `client.ts` 未实现新接口。

- [ ] **步骤 5：Commit**

```bash
git add packages/pi-client/src/locator.ts packages/pi-client/src/types.ts packages/domain/src/role-manager/service.test.ts
git commit -m "refactor: define pi client gateway types"
```

## 任务 3：让 domain 持久化 locator

**文件：**
- 修改：`packages/domain/src/role-manager/service.ts`
- 修改：`packages/domain/src/project/service.ts`
- 修改：`packages/domain/src/session/service.ts`
- 修改：`packages/domain/src/extensions/registry.ts`
- 测试：`packages/domain/src/role-manager/service.test.ts`

- [ ] **步骤 1：扩展失败测试，验证 session 写入 locator**

在 `packages/domain/src/role-manager/service.test.ts` 中加入数据库查询断言：

```ts
const [created] = await db.select().from(sessions).where(eq(sessions.id, result.sessionId)).limit(1);
expect(created?.piSessionLocatorJson).toContain('sessionFile');
expect(created?.piSessionId).toMatch(/^pi_/);
```

运行：`bun test packages/domain/src/role-manager/service.test.ts`
预期：FAIL，`piSessionLocatorJson` 仍为空默认值。

- [ ] **步骤 2：更新 role-manager 插入模型**

在 `packages/domain/src/role-manager/service.ts`：

1. 引入：

```ts
import { stringifyLocator } from '@piplus/pi-client/locator';
```

2. 扩展 `insertSession` 输入：

```ts
  piSessionLocatorJson: string;
```

3. 写表时增加：

```ts
    piSessionLocatorJson: input.piSessionLocatorJson,
```

4. 在 `createTopLevelPlannerSession` / `createTopLevelBlankSession` / `spawnSession` 中，处理 `piClient.createSession()` 返回值：

```ts
const piSession = await piClient.createSession({ title, prompt: compiledPrompt });
const piSessionId = piSession.locator.piSessionId ?? piSession.sessionId;
```

并传入：

```ts
piSessionId,
piSessionLocatorJson: stringifyLocator(piSession.locator),
```

- [ ] **步骤 3：兼容上层返回结构**

保持现有返回字段不破坏 API：

```ts
return { sessionId, piSessionId };
```

确保 `project/service.ts`、`session/service.ts` 无需签名大改，只继续透传结果。

- [ ] **步骤 4：更新扩展注册层兼容返回**

如果 `packages/domain/src/extensions/registry.ts` 直接消费 `result.piSessionId`，保持输出：

```ts
return { session_id: result.sessionId, pi_session_id: result.piSessionId };
```

只修正类型错误，不扩大范围。

- [ ] **步骤 5：运行测试验证通过**

运行：`bun test packages/domain/src/role-manager/service.test.ts`
预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add packages/domain/src/role-manager/service.ts packages/domain/src/project/service.ts packages/domain/src/session/service.ts packages/domain/src/extensions/registry.ts packages/domain/src/role-manager/service.test.ts
git commit -m "feat: persist pi session locator in domain"
```

## 任务 4：实现 pi-client 的历史读取与 runtime manager

**文件：**
- 创建：`packages/pi-client/src/history.ts`
- 创建：`packages/pi-client/src/runtime-manager.ts`
- 创建：`packages/pi-client/src/sdk-client.ts`
- 修改：`packages/pi-client/src/client.ts`
- 创建：`packages/pi-client/src/client.test.ts`

- [ ] **步骤 1：先写失败测试，覆盖网关最小能力**

创建 `packages/pi-client/src/client.test.ts`，至少包含以下测试骨架：

```ts
import { describe, expect, test } from 'bun:test';
import { createPiClient } from './client';

describe('pi client gateway', () => {
  test('createSession returns locator with sessionFile', async () => {
    const client = createPiClient();
    const result = await client.createSession({ prompt: 'hello', title: 'Test' });
    expect(result.locator.sessionFile).toBeTruthy();
  });

  test('restored runtime can emit streamed text deltas', async () => {
    const client = createPiClient();
    const created = await client.createSession({ prompt: 'hello' });
    await client.restoreRuntime('session_a', created.locator);
    const events: string[] = [];
    const unsubscribe = await client.subscribeSession('session_a', (event) => {
      if (event.type === 'text_delta') events.push(event.delta);
    });
    await client.sendMessage('session_a', 'say hi');
    unsubscribe();
    expect(events.length).toBeGreaterThan(0);
  });
});
```

运行：`bun --cwd packages/pi-client test`
预期：FAIL，文件/实现不存在。

- [ ] **步骤 2：实现历史读取模块**

创建 `packages/pi-client/src/history.ts`，提供最小 API：

```ts
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { PiHistoryPage, PiSessionLocator } from './types';

export function readHistory(locator: PiSessionLocator, cursor?: string | null, limit = 50): PiHistoryPage {
  const sm = SessionManager.open(locator.sessionFile);
  const entries = sm.getPath();
  const offset = cursor ? Number.parseInt(cursor, 10) || 0 : 0;
  const slice = entries.slice(offset, offset + limit);
  return {
    messages: slice
      .filter((entry: any) => entry.type === 'message' && (entry.role === 'user' || entry.role === 'assistant'))
      .map((entry: any) => ({
        id: entry.id,
        role: entry.role,
        text: entry.text ?? '',
        createdAt: entry.timestamp ?? null,
      })),
    nextCursor: offset + slice.length < entries.length ? String(offset + slice.length) : null,
  };
}
```

如果实际 SDK entry 形状不同，实现时以本地类型为准，但保持这个函数边界不变。

- [ ] **步骤 3：实现 runtime manager**

创建 `packages/pi-client/src/runtime-manager.ts`，实现核心结构：

```ts
import type { PiSessionLocator, PiSessionStreamEvent } from './types';

type Listener = (event: PiSessionStreamEvent) => void | Promise<void>;

type ActiveSessionRuntime = {
  locator: PiSessionLocator;
  runtime: any;
  listeners: Set<Listener>;
  createdAt: number;
  lastActiveAt: number;
};
```

至少实现：

```ts
ensure(sessionId: string, locator: PiSessionLocator): Promise<ActiveSessionRuntime>
subscribe(sessionId: string, listener: Listener): Promise<() => void>
emit(sessionId: string, event: PiSessionStreamEvent): Promise<void>
close(sessionId: string): Promise<void>
```

这里使用真实 `createAgentSessionRuntime()`，并在绑定时桥接 SDK 的 `message_start` / `message_update.text_delta` / `message_end` / 错误到标准化事件。

- [ ] **步骤 4：实现 SDK facade**

创建 `packages/pi-client/src/sdk-client.ts`，按以下轮廓实现：

```ts
import { getAgentDir, SessionManager } from '@earendil-works/pi-coding-agent';
import { RuntimeManager } from './runtime-manager';
import { readHistory } from './history';

export function createSdkPiClient(): PiClient {
  const manager = new RuntimeManager();
  return {
    async createSession(input) { ... },
    async restoreRuntime(sessionId, locator) { ... },
    async subscribeSession(sessionId, listener) { ... },
    async getHistory(sessionId, locator, cursor, limit) { ... },
    async sendMessage(sessionId, content) { ... },
    async stopSession(sessionId) { ... },
    async closeRuntime(sessionId) { ... },
  };
}
```

约束：

- `createSession()` 必须返回 `locator.sessionFile`
- `sendMessage()` 必须返回 `runId`
- 同一 `sessionId` 在 `isStreaming` 时再次发送，必须抛出 busy 错误
- `stopSession()` 调用底层 `session.abort()`

- [ ] **步骤 5：切换默认导出到真实 facade**

把 `packages/pi-client/src/client.ts` 改成：

```ts
export { createSdkPiClient as createPiClient } from './sdk-client';
```

不再保留内存 Map stub 逻辑。

- [ ] **步骤 6：运行包级测试验证通过**

运行：`bun --cwd packages/pi-client test`
预期：PASS。

- [ ] **步骤 7：Commit**

```bash
git add packages/pi-client/src/locator.ts packages/pi-client/src/history.ts packages/pi-client/src/runtime-manager.ts packages/pi-client/src/sdk-client.ts packages/pi-client/src/client.ts packages/pi-client/src/client.test.ts
git commit -m "feat: implement pi sdk session gateway"
```

## 任务 5：接入 API 历史与 session info

**文件：**
- 修改：`apps/api/src/routes/sessions.ts`
- 修改：`apps/web/src/lib/api.ts`
- 修改：`apps/web/src/components/session-info-panel.tsx`
- 修改：`apps/web/src/components/__tests__/session-info-panel.test.tsx`
- 创建：`apps/api/src/routes/sessions.history.test.ts`

- [ ] **步骤 1：先写失败测试，锁定历史来源改为 session 文件**

创建 `apps/api/src/routes/sessions.history.test.ts`：

```ts
import { describe, expect, test } from 'bun:test';
import { createSeedDb } from '@piplus/db/init';
import { createApp } from '../app';

describe('session history route', () => {
  test('reads message history from pi session file', async () => {
    const path = `/tmp/piplus-history-${crypto.randomUUID()}.sqlite`;
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'History Project' }),
    });
    const projectBody = await projectRes.json();

    await app.request(`/api/v1/sessions/${projectBody.sessionId}/chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ content: 'hello file history' }),
    });

    const res = await app.request(`/api/v1/sessions/${projectBody.sessionId}/chat/messages?limit=20`, {
      headers: { 'x-user-id': 'user_seed' },
    });
    const body = await res.json();
    expect(body.messages.some((row: { content_text: string }) => row.content_text.includes('hello file history'))).toBe(true);
  });
});
```

运行：`bun --cwd apps/api test apps/api/src/routes/sessions.history.test.ts`
预期：FAIL 或不稳定，直到真实网关接入完成。

- [ ] **步骤 2：在 info 接口返回 locator**

在 `apps/api/src/routes/sessions.ts` 的 `info` 返回中新增：

```ts
        pi_session_locator_json: session.piSessionLocatorJson,
```

同时保留：

```ts
        pi_session_id: session.piSessionId,
```

- [ ] **步骤 3：将历史接口切到 `getHistory()`**

把当前：

```ts
const piPage = await piClient.listMessages(session.piSessionId, cursor ?? null, limit);
```

改为：

```ts
const piPage = await piClient.getHistory(
  sessionId,
  parseLocator(session.piSessionLocatorJson),
  cursor ?? null,
  limit,
);
```

并调整映射：

```ts
messages: piPage.messages.map((row) => ({
  id: row.id,
  role: row.role,
  message_kind: 'normal',
  source_session_id: null,
  content_text: row.text,
  created_at: row.createdAt,
})),
```

- [ ] **步骤 4：同步前端 Session Info 类型消费**

如果 `apps/web/src/components/session-info-panel.tsx` 需要展示 locator，加入容错：

```tsx
<Metric label="PI locator" value={session.pi_session_locator_json || '{}'} mono />
```

如果不展示，也至少让测试构造数据包含新字段以通过类型检查：

```ts
pi_session_locator_json: '{}',
```

- [ ] **步骤 5：运行 API 历史测试验证通过**

运行：`bun --cwd apps/api test apps/api/src/routes/sessions.history.test.ts`
预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add apps/api/src/routes/sessions.ts apps/api/src/routes/sessions.history.test.ts apps/web/src/lib/api.ts apps/web/src/components/session-info-panel.tsx apps/web/src/components/__tests__/session-info-panel.test.tsx
git commit -m "feat: read session history from pi session files"
```

## 任务 6：接入实时流桥接与 stop 语义

**文件：**
- 创建：`apps/api/src/lib/pi-stream-bridge.ts`
- 修改：`apps/api/src/routes/sessions.ts`
- 创建：`apps/api/src/routes/sessions.stream.test.ts`
- 修改：`apps/api/src/routes/sessions.test.ts`

- [ ] **步骤 1：编写失败测试，锁定 websocket 流式桥接行为**

创建 `apps/api/src/routes/sessions.stream.test.ts`，测试桥接函数本身而不是整条 websocket 网络栈：

```ts
import { describe, expect, test } from 'bun:test';
import { createChatStreamFrame } from '../ws/protocol';
import { mapPiStreamEventToFrames } from '../lib/pi-stream-bridge';

describe('pi stream bridge', () => {
  test('maps text deltas to chat stream frames', () => {
    const frames = mapPiStreamEventToFrames('session_1', {
      type: 'text_delta',
      sessionId: 'session_1',
      runId: 'run_1',
      messageId: 'msg_1',
      delta: 'hello',
    });
    expect(frames).toEqual([
      createChatStreamFrame('session_1', 'delta', 'run_1', 'msg_1', 'hello'),
    ]);
  });
});
```

运行：`bun --cwd apps/api test apps/api/src/routes/sessions.stream.test.ts`
预期：FAIL，桥接文件不存在。

- [ ] **步骤 2：实现桥接模块**

创建 `apps/api/src/lib/pi-stream-bridge.ts`：

```ts
import type { PiSessionStreamEvent } from '@piplus/pi-client';
import { createChatStreamFrame } from '../ws/protocol';

export function mapPiStreamEventToFrames(sessionId: string, event: PiSessionStreamEvent) {
  switch (event.type) {
    case 'message_start':
      return [createChatStreamFrame(sessionId, 'start', event.runId, event.messageId ?? event.runId)];
    case 'text_delta':
      return [createChatStreamFrame(sessionId, 'delta', event.runId, event.messageId ?? event.runId, event.delta)];
    case 'message_end':
      return [createChatStreamFrame(sessionId, 'complete', event.runId, event.messageId ?? event.runId)];
    case 'error':
      return [createChatStreamFrame(sessionId, 'error', event.runId, event.messageId ?? event.runId, null, event.error)];
  }
}
```

- [ ] **步骤 3：将发送接口接入订阅链路**

在 `apps/api/src/routes/sessions.ts` 的 `POST /chat/messages` 中：

1. 用 locator 恢复 runtime：

```ts
const locator = parseLocator(session.piSessionLocatorJson);
await piClient.restoreRuntime(sessionId, locator);
```

2. 建立或复用订阅：

```ts
await piClient.subscribeSession(sessionId, async (event) => {
  for (const frame of mapPiStreamEventToFrames(sessionId, event)) {
    socketHub.sendToSession(sessionId, frame);
  }
  if (event.type === 'message_start') {
    socketHub.sendToSession(sessionId, createEvent('session.runtime_status_changed', { runtime_status: 'running' }, { project_id: session.projectId, session_id: sessionId }));
  }
  if (event.type === 'message_end' || event.type === 'error') {
    socketHub.sendToSession(sessionId, createEvent('session.runtime_status_changed', { runtime_status: 'idle' }, { project_id: session.projectId, session_id: sessionId }));
  }
});
```

3. 发送消息：

```ts
const run = await piClient.sendMessage(sessionId, content);
```

并把返回值带上：

```ts
return c.json({ accepted: true, session_id: sessionId, run_id: run.runId, message_id: messageId }, 202);
```

- [ ] **步骤 4：切换 stop 到业务 session 维度**

把：

```ts
await piClient.stopSession(session.piSessionId);
```

改为：

```ts
await piClient.stopSession(sessionId);
```

并保留现有数据库 runtime 状态投影更新逻辑。

- [ ] **步骤 5：更新旧测试断言**

在 `apps/api/src/routes/sessions.test.ts` 中，替换当前基于回声 stub 的分页断言，例如删除：

```ts
expect(page1.messages.map((row) => row.content_text)).toEqual(['one', 'one']);
```

改为更稳妥的断言：

```ts
expect(page1.messages.some((row: { content_text: string }) => row.content_text.includes('one'))).toBe(true);
```

避免真实模型输出导致测试假设过强。

- [ ] **步骤 6：运行会话路由测试验证通过**

运行：`bun --cwd apps/api test apps/api/src/routes/sessions.test.ts apps/api/src/routes/sessions.stream.test.ts`
预期：PASS。

- [ ] **步骤 7：Commit**

```bash
git add apps/api/src/lib/pi-stream-bridge.ts apps/api/src/routes/sessions.ts apps/api/src/routes/sessions.stream.test.ts apps/api/src/routes/sessions.test.ts
git commit -m "feat: bridge pi session streams to api websocket events"
```

## 任务 7：补充 fork 与关闭后可读历史的回归测试

**文件：**
- 修改：`packages/pi-client/src/client.test.ts`
- 修改：`apps/api/src/routes/sessions.history.test.ts`

- [ ] **步骤 1：为 fork 写失败测试**

在 `packages/pi-client/src/client.test.ts` 增加：

```ts
test('forkSession creates a new locator from the current leaf', async () => {
  const client = createPiClient();
  const created = await client.createSession({ prompt: 'hello' });
  await client.restoreRuntime('session_a', created.locator);
  await client.sendMessage('session_a', 'branch me');
  const forked = await client.forkSession('session_a', created.locator);
  expect(forked.locator.sessionFile).not.toBe(created.locator.sessionFile);
});
```

运行：`bun --cwd packages/pi-client test`
预期：FAIL，`forkSession` 未实现或不返回新 locator。

- [ ] **步骤 2：实现从当前叶子 fork**

在 `packages/pi-client/src/sdk-client.ts` 中补充：

```ts
async forkSession(sessionId, locator, entryId) {
  const sm = SessionManager.open(locator.sessionFile);
  const targetId = entryId ?? sm.getLeafEntry()?.id;
  if (!targetId) throw new Error('pi_fork_target_not_found');
  const branchedFile = sm.createBranchedSession(targetId);
  return {
    locator: {
      piSessionId: undefined,
      sessionFile: branchedFile,
    },
  };
}
```

如果 SDK 返回对象形状与此不同，实现时以实际返回值为准，但保留相同语义。

- [ ] **步骤 3：补回归测试，关闭 runtime 后仍可读历史**

在 `apps/api/src/routes/sessions.history.test.ts` 中增加：

```ts
test('history remains readable after runtime is closed', async () => {
  // 创建 session -> 发送消息 -> 关闭 runtime -> 再读历史
  // 断言消息仍存在
});
```

实现时通过 `createPiClient()` 暴露的 `closeRuntime()` 或 API 路由内部手段完成关闭，再读取历史。

- [ ] **步骤 4：运行测试验证通过**

运行：`bun --cwd packages/pi-client test && bun --cwd apps/api test apps/api/src/routes/sessions.history.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add packages/pi-client/src/client.test.ts packages/pi-client/src/sdk-client.ts apps/api/src/routes/sessions.history.test.ts
git commit -m "feat: support pi session forking and history recovery"
```

## 任务 8：全量验证与清理

**文件：**
- 修改：根据前述任务收尾需要的小修正文件
- 测试：`package.json` 中现有脚本覆盖的所有相关模块

- [ ] **步骤 1：运行 pi-client 包测试**

运行：`bun --cwd packages/pi-client test`
预期：PASS。

- [ ] **步骤 2：运行 domain 相关测试**

运行：`bun test packages/domain/src/role-manager/service.test.ts`
预期：PASS。

- [ ] **步骤 3：运行 API 测试**

运行：`bun --cwd apps/api test`
预期：PASS。

- [ ] **步骤 4：运行全量类型检查**

运行：`bun run typecheck`
预期：PASS。

- [ ] **步骤 5：审查编译和测试暴露出的命名不一致并修正**

重点自查以下名称一致性：

```ts
piSessionLocatorJson
PiSessionLocator
subscribeSession
getHistory
sendMessage
runId
```

如有不一致，直接修正并重新执行相应测试。

- [ ] **步骤 6：最终 Commit**

```bash
git add packages/pi-client apps/api packages/domain packages/db packages/shared apps/web
git commit -m "feat: integrate pi sdk session gateway"
```

## 自检

- 规格中的数据模型、运行时恢复、显式流订阅、历史从 session 文件读取、stop/abort、fork 当前叶子，均已对应到任务 1-7。
- 计划中没有使用“TODO/待定/后续实现”作为步骤本身；所有关键步骤都给了具体文件、代码骨架、命令与预期结果。
- 类型命名在计划中统一使用：`PiSessionLocator`、`piSessionLocatorJson`、`subscribeSession()`、`sendMessage()`、`runId`、`getHistory()`。
