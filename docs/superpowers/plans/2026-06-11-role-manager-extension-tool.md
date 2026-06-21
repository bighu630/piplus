# Role Manager Extension Tool 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 通过 pi SDK 的 `extensionFactories` + `pi.registerTool()` 机制把 `spawn_session` 和 `writeback_to_parent` 真正注册进 agent session，LLM 自主决定何时调用，平台执行角色实例化。

**架构：** 新增 `role-catalog.ts`（动态角色目录）和 `role-manager-tools.ts`（tool 协议层），瘦身 `registry.ts`，升级 `role-manager.spawnSession()` 参数，在 `pi-client` 的 `restoreRuntime/createSession` 中通过 `DefaultResourceLoader + extensionFactories` 把 tool 绑定到 agent session。

**技术栈：** Bun、TypeScript、Drizzle ORM、`@earendil-works/pi-coding-agent` SDK（TypeBox、`defineTool`/`pi.registerTool`、`DefaultResourceLoader`、`extensionFactories`）。

---

## 文件结构

**创建：**
- `packages/domain/src/extensions/role-catalog.ts`
  - 动态角色目录加载：DB 模板 + 内置默认说明（策略 C）
- `packages/domain/src/extensions/role-manager-tools.ts`
  - `spawn_session` / `writeback_to_parent` tool schema 生成和 handler
- `packages/domain/src/extensions/role-catalog.test.ts`
  - 角色目录加载逻辑的单元测试
- `packages/domain/src/extensions/role-manager-tools.test.ts`
  - tool description 动态生成、参数校验、handler 调用的单元测试

**修改：**
- `packages/domain/src/extensions/registry.ts`
  - 瘦身为总装配/分发层，不再内联静态 tool schema
- `packages/domain/src/extensions/spawn-session.ts`
  - `InternalSpawnSessionInput` 从 `target` 升级为 `objective/scope/task`
- `packages/domain/src/role-manager/service.ts`
  - `SpawnSessionInput` 升级，`compilePrompt` 接入新参数
- `packages/domain/src/role-manager/service.test.ts`
  - 更新 spawnSession 调用和 compiledPrompt 断言
- `packages/pi-client/src/types.ts`
  - 新增 `PiToolCallHandler` 和 `PiClient.bindToolRuntime()`
- `packages/pi-client/src/runtime-registry.ts`
  - `ActiveSessionRuntime` 增加 `toolHandler` 字段
- `packages/pi-client/src/client.ts`
  - `createSession` / `restoreRuntime` 接入 `DefaultResourceLoader + extensionFactories`
  - 新增 `bindToolRuntime(sessionId, tools, handler)`
- `packages/pi-client/src/client.test.ts`
  - 新增 tool runtime 绑定和 LLM tool call 的集成测试

**测试命令：**
- `bun test packages/domain/src/extensions/role-catalog.test.ts`
- `bun test packages/domain/src/extensions/role-manager-tools.test.ts`
- `bun test packages/domain/src/role-manager/service.test.ts`
- `cd packages/pi-client && bun test src/client.test.ts`
- `cd packages/domain && bun run typecheck`
- `cd packages/pi-client && bun run typecheck`

---

## 任务 1：动态角色目录

**文件：**
- 创建：`packages/domain/src/extensions/role-catalog.ts`
- 创建：`packages/domain/src/extensions/role-catalog.test.ts`

- [ ] **步骤 1：写失败测试，锁定目录加载逻辑**

创建 `packages/domain/src/extensions/role-catalog.test.ts`：

```ts
import { describe, expect, test } from 'bun:test';
import { createDb } from '@piplus/db/client';
import { createSeedDb } from '@piplus/db/init';
import { loadRoleCatalog } from './role-catalog';

function makeDbPath() {
  return `/tmp/piplus-catalog-${crypto.randomUUID()}.sqlite`;
}

describe('role catalog', () => {
  test('includes all non-archived db templates', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    const db = createDb(`file:${path}`);
    const catalog = await loadRoleCatalog(db);
    const keys = catalog.roles.map((r) => r.key);
    expect(keys).toContain('planner');
    expect(keys).toContain('worker');
    expect(keys).toContain('reviewer');
  });

  test('uses db description when present', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    const db = createDb(`file:${path}`);
    const catalog = await loadRoleCatalog(db);
    const planner = catalog.roles.find((r) => r.key === 'planner');
    expect(planner?.description).toBeTruthy();
  });

  test('falls back to builtin description when db description is empty', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    const db = createDb(`file:${path}`);
    // blank has empty description in seed
    const catalog = await loadRoleCatalog(db);
    const blank = catalog.roles.find((r) => r.key === 'blank');
    expect(blank?.description).toBeTruthy();
  });
});
```

运行：`bun test packages/domain/src/extensions/role-catalog.test.ts`
预期：FAIL，`loadRoleCatalog` 不存在。

- [ ] **步骤 2：实现 `role-catalog.ts`**

创建 `packages/domain/src/extensions/role-catalog.ts`：

```ts
import { roleTemplates } from '@piplus/db/schema';
import type { RoleManagerDb } from '../role-manager/service';
import { isNull } from 'drizzle-orm';

export type RoleCatalogEntry = {
  key: string;
  name: string;
  description: string;
  source: 'builtin' | 'db';
};

export type RoleCatalog = {
  roles: RoleCatalogEntry[];
};

const BUILTIN_ROLE_DESCRIPTIONS: Record<string, string> = {
  planner: 'Plans and coordinates work. Breaks large goals into structured steps.',
  worker: 'Executes concrete implementation tasks.',
  reviewer: 'Reviews output and returns critiques or confirmations.',
  researcher: 'Investigates a topic and summarizes findings.',
  blank: 'A minimal, no-preset session for ad-hoc work.',
};

export async function loadRoleCatalog(db: RoleManagerDb): Promise<RoleCatalog> {
  const rows = await db
    .select({
      key: roleTemplates.key,
      name: roleTemplates.name,
      description: roleTemplates.description,
    })
    .from(roleTemplates)
    .where(isNull(roleTemplates.archivedAt));

  const roles: RoleCatalogEntry[] = rows.map((row) => ({
    key: row.key,
    name: row.name,
    description: row.description?.trim()
      ? row.description
      : (BUILTIN_ROLE_DESCRIPTIONS[row.key] ?? `${row.name} session.`),
    source: 'db',
  }));

  return { roles };
}
```

- [ ] **步骤 3：运行测试验证通过**

运行：`bun test packages/domain/src/extensions/role-catalog.test.ts`
预期：PASS。

- [ ] **步骤 4：Commit**

```bash
git add packages/domain/src/extensions/role-catalog.ts packages/domain/src/extensions/role-catalog.test.ts
git commit -m "feat: add dynamic role catalog"
```

---

## 任务 2：升级 `spawnSession` 参数模型

**文件：**
- 修改：`packages/domain/src/extensions/spawn-session.ts`
- 修改：`packages/domain/src/role-manager/service.ts`
- 修改：`packages/domain/src/role-manager/service.test.ts`

- [ ] **步骤 1：写失败测试，锁定新参数结构**

在 `service.test.ts` 的 `spawns a child session...` 测试中，把 `spawnSession` 调用改为：

```ts
const result = await roleManager.spawnSession({
  projectId,
  parentSessionId,
  createdBy: 'user_seed',
  role: 'reviewer',
  objective: 'review the API boundary',
  scope: 'apps/api/src/routes',
  task: 'identify any input validation gaps',
  constraints: ['keep it short', 'do not mention tree structure'],
});
```

并更新断言：

```ts
expect(child?.compiledPrompt).toContain('Objective:');
expect(child?.compiledPrompt).toContain('review the API boundary');
expect(child?.compiledPrompt).toContain('Scope:');
expect(child?.compiledPrompt).toContain('Task:');
```

运行：`bun test packages/domain/src/role-manager/service.test.ts`
预期：FAIL，`spawnSession` 不接受 `objective`。

- [ ] **步骤 2：升级 `spawn-session.ts`**

```ts
export type InternalSpawnSessionInput = {
  role: string;
  objective: string;
  scope?: string;
  task?: string;
  constraints: string[];
};

export function buildSpawnSessionInput(input: InternalSpawnSessionInput) {
  return {
    role: input.role,
    objective: input.objective,
    scope: input.scope,
    task: input.task,
    constraints: input.constraints,
  };
}
```

- [ ] **步骤 3：升级 `service.ts` 的 `SpawnSessionInput` 和 `compilePrompt`**

在 `service.ts` 中：

1. 更新 `SpawnSessionInput`：

```ts
export type SpawnSessionInput = {
  projectId: string;
  parentSessionId: string;
  createdBy: string;
  role: string;
  objective: string;
  scope?: string;
  task?: string;
  constraints: string[];
};
```

2. 更新 `compilePrompt` 函数签名和实现：

```ts
function compilePrompt(input: {
  roleBasePrompt: string;
  objective?: string;
  scope?: string;
  task?: string;
  parentSuppliedPrompt?: string;
  constraints?: string[];
}) {
  const parts = [input.roleBasePrompt];
  if (input.parentSuppliedPrompt) parts.push(input.parentSuppliedPrompt);
  const directive: string[] = [];
  if (input.objective) directive.push(`Objective:\n${input.objective}`);
  if (input.scope) directive.push(`Scope:\n${input.scope}`);
  if (input.task) directive.push(`Task:\n${input.task}`);
  if (directive.length) parts.push(directive.join('\n\n'));
  if (input.constraints?.length) {
    parts.push(`Constraints:\n- ${input.constraints.join('\n- ')}`);
  }
  return parts.filter(Boolean).join('\n\n');
}
```

3. 在 `spawnSession` 里传入新字段：

```ts
const compiledPrompt = compilePrompt({
  roleBasePrompt: template.basePrompt,
  objective: input.objective,
  scope: input.scope,
  task: input.task,
  constraints: input.constraints,
});
```

注意：`createTopLevelPlannerSession` 和 `createTopLevelBlankSession` 里的 `compilePrompt` 调用不需要 `objective/scope/task`，保持不变。

- [ ] **步骤 4：运行测试验证通过**

运行：`bun test packages/domain/src/role-manager/service.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add packages/domain/src/extensions/spawn-session.ts packages/domain/src/role-manager/service.ts packages/domain/src/role-manager/service.test.ts
git commit -m "feat: upgrade spawnSession to objective/scope/task params"
```

---

## 任务 3：role-manager-tools adapter

**文件：**
- 创建：`packages/domain/src/extensions/role-manager-tools.ts`
- 创建：`packages/domain/src/extensions/role-manager-tools.test.ts`
- 修改：`packages/domain/src/extensions/registry.ts`

- [ ] **步骤 1：写失败测试，锁定动态 tool description**

创建 `packages/domain/src/extensions/role-manager-tools.test.ts`：

```ts
import { describe, expect, test } from 'bun:test';
import { createDb } from '@piplus/db/client';
import { createSeedDb } from '@piplus/db/init';
import { buildRoleManagerToolDefs } from './role-manager-tools';
import { loadRoleCatalog } from './role-catalog';

describe('role manager tools', () => {
  test('spawn_session description includes available roles', async () => {
    const path = `/tmp/piplus-tools-${crypto.randomUUID()}.sqlite`;
    createSeedDb(path);
    const db = createDb(`file:${path}`);
    const catalog = await loadRoleCatalog(db);
    const defs = buildRoleManagerToolDefs(catalog);
    const spawn = defs.find((d) => d.name === 'spawn_session');
    expect(spawn).toBeTruthy();
    expect(spawn!.description).toContain('planner');
    expect(spawn!.description).toContain('worker');
    expect(spawn!.description).toContain('reviewer');
  });

  test('spawn_session includes objective parameter', async () => {
    const path = `/tmp/piplus-tools-${crypto.randomUUID()}.sqlite`;
    createSeedDb(path);
    const db = createDb(`file:${path}`);
    const catalog = await loadRoleCatalog(db);
    const defs = buildRoleManagerToolDefs(catalog);
    const spawn = defs.find((d) => d.name === 'spawn_session');
    expect(JSON.stringify(spawn!.parameters)).toContain('objective');
    expect(JSON.stringify(spawn!.parameters)).toContain('scope');
    expect(JSON.stringify(spawn!.parameters)).toContain('task');
  });
});
```

运行：`bun test packages/domain/src/extensions/role-manager-tools.test.ts`
预期：FAIL。

- [ ] **步骤 2：实现 `role-manager-tools.ts`**

创建 `packages/domain/src/extensions/role-manager-tools.ts`：

```ts
import type { PiToolDef, PiToolCallHandler } from '@piplus/pi-client';
import type { RoleCatalog } from './role-catalog';
import type { RoleManagerDb } from '../role-manager/service';
import type { PiClient } from '@piplus/pi-client';
import { sessions } from '@piplus/db/schema';
import { eq } from 'drizzle-orm';
import { createRoleManagerService } from '../role-manager/service';

export function buildRoleManagerToolDefs(catalog: RoleCatalog): PiToolDef[] {
  const roleLines = catalog.roles
    .map((r) => `- ${r.key}: ${r.description}`)
    .join('\n');

  return [
    {
      name: 'spawn_session',
      description: [
        'Create a child session with a specialized role to delegate work.',
        '',
        'Available roles right now:',
        roleLines,
        '',
        'The platform will create the child session, assemble the role prompt,',
        'and track parent/child session relationships automatically.',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'Role key (must be one of the available roles listed above)' },
          objective: { type: 'string', description: 'The outcome this child session should achieve' },
          scope: { type: 'string', description: 'The codebase area or boundary it should stay within (optional)' },
          task: { type: 'string', description: 'The specific task to execute (optional)' },
          constraints: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional extra restrictions',
          },
        },
        required: ['role', 'objective'],
      },
    },
    {
      name: 'writeback_to_parent',
      description:
        'Write results back to the parent session when work is complete. The platform resolves the parent internally.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Summary of work completed' },
          blocks: {
            type: 'array',
            items: { type: 'object' },
            description: 'Optional structured output blocks',
          },
        },
        required: ['summary'],
      },
    },
  ];
}

export type RoleManagerToolContext = {
  db: RoleManagerDb;
  piClient: PiClient;
  sessionId: string;
  userId: string;
};

export async function invokeRoleManagerTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: RoleManagerToolContext,
): Promise<unknown> {
  const roleManager = createRoleManagerService(ctx.db, ctx.piClient);

  if (toolName === 'spawn_session') {
    const [parent] = await ctx.db
      .select({ projectId: sessions.projectId })
      .from(sessions)
      .where(eq(sessions.id, ctx.sessionId))
      .limit(1);
    if (!parent) throw new Error('parent_session_not_found');

    const result = await roleManager.spawnSession({
      projectId: parent.projectId,
      parentSessionId: ctx.sessionId,
      createdBy: ctx.userId,
      role: String(args.role ?? 'worker'),
      objective: String(args.objective ?? ''),
      scope: args.scope ? String(args.scope) : undefined,
      task: args.task ? String(args.task) : undefined,
      constraints: Array.isArray(args.constraints) ? args.constraints.map(String) : [],
    });

    return {
      session_id: result.sessionId,
      role: String(args.role),
      status: 'created',
    };
  }

  if (toolName === 'writeback_to_parent') {
    await roleManager.writebackToParent({
      childSessionId: ctx.sessionId,
      summary: String(args.summary ?? ''),
      blocks: Array.isArray(args.blocks) ? args.blocks : null,
    });
    return { ok: true };
  }

  throw new Error(`unknown_tool:${toolName}`);
}
```

- [ ] **步骤 3：运行测试验证通过**

运行：`bun test packages/domain/src/extensions/role-manager-tools.test.ts`
预期：PASS。

- [ ] **步骤 4：瘦身 `registry.ts`**

把 `registry.ts` 改成总装配层：

```ts
import type { PiClient } from '@piplus/pi-client';
import type { RoleManagerDb } from '../role-manager/service';
import { loadRoleCatalog } from './role-catalog';
import { buildRoleManagerToolDefs, invokeRoleManagerTool } from './role-manager-tools';

export type PlatformToolContext = {
  db: RoleManagerDb;
  piClient: PiClient;
  sessionId: string;
  userId: string;
};

export async function buildAllToolDefs(db: RoleManagerDb) {
  const catalog = await loadRoleCatalog(db);
  return buildRoleManagerToolDefs(catalog);
}

export async function invokePlatformTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: PlatformToolContext,
): Promise<unknown> {
  return invokeRoleManagerTool(toolName, args, ctx);
}
```

- [ ] **步骤 5：运行 domain typecheck**

运行：`cd packages/domain && bun run typecheck`
预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add packages/domain/src/extensions/role-manager-tools.ts packages/domain/src/extensions/role-manager-tools.test.ts packages/domain/src/extensions/registry.ts
git commit -m "feat: add role-manager-tools adapter with dynamic catalog"
```

---

## 任务 4：pi-client bindToolRuntime

**文件：**
- 修改：`packages/pi-client/src/types.ts`
- 修改：`packages/pi-client/src/runtime-registry.ts`
- 修改：`packages/pi-client/src/client.ts`
- 修改：`packages/pi-client/src/client.test.ts`

- [ ] **步骤 1：写失败测试，锁定 tool call 路径**

在 `packages/pi-client/src/client.test.ts` 中新增：

```ts
  test('bindToolRuntime registers tools into agent session and handler is called on tool use', async () => {
    const client = createPiClient();
    const created = await client.createSession({ prompt: 'You are a test assistant.' });
    await client.restoreRuntime(created.sessionId, created.locator);

    const handlerCalls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
    await client.bindToolRuntime(created.sessionId, [
      {
        name: 'test_ping',
        description: 'Reply with pong',
        parameters: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
        },
      },
    ], async (toolName, args) => {
      handlerCalls.push({ toolName, args });
      return { pong: args.message };
    });

    await client.sendMessage(created.sessionId, 'Call the test_ping tool with message "hello"');

    await client.closeRuntime(created.sessionId);
    expect(handlerCalls.some((c) => c.toolName === 'test_ping')).toBe(true);
  });
```

运行：`cd packages/pi-client && bun test src/client.test.ts`
预期：FAIL，`bindToolRuntime` 不存在。

- [ ] **步骤 2：在 `types.ts` 中新增 `bindToolRuntime`**

在 `PiClient` 类型中新增：

```ts
bindToolRuntime(
  sessionId: string,
  tools: PiToolDef[],
  handler: (toolName: string, args: Record<string, unknown>, context: { sessionId: string }) => Promise<unknown>,
): Promise<void>;
```

- [ ] **步骤 3：在 `runtime-registry.ts` 中增加 tool handler 字段**

```ts
export type ActiveSessionRuntime = {
  locator: PiSessionLocator;
  agentSession?: AgentSession;
  toolHandler?: (toolName: string, args: Record<string, unknown>, context: { sessionId: string }) => Promise<unknown>;
  toolDefs?: PiToolDef[];
  messages: PiMessage[];
  stopped: boolean;
  prompt: string;
  title: string | null;
  listeners: Set<SessionListener>;
};
```

- [ ] **步骤 4：在 `client.ts` 中实现 `bindToolRuntime`**

需要引入 `DefaultResourceLoader`，并在 `createSession/restoreRuntime` 里支持传入 tool runtime。`bindToolRuntime` 的实现步骤：

1. 把 toolDefs 和 handler 存入 registry
2. 如果 `session.agentSession` 已存在，dispose 它并重新用 `DefaultResourceLoader + extensionFactories` 重建

```ts
async bindToolRuntime(sessionId, tools, handler) {
  const session = runtimeRegistry.ensure(sessionId);
  session.toolDefs = tools;
  session.toolHandler = handler;

  // 重建 agentSession with tools
  if (session.agentSession) {
    session.agentSession.dispose();
    session.agentSession = undefined;
  }

  const { DefaultResourceLoader, getAgentDir } = await import('@earendil-works/pi-coding-agent');

  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    extensionFactories: [
      (pi) => {
        for (const toolDef of tools) {
          pi.registerTool({
            name: toolDef.name,
            label: toolDef.name,
            description: toolDef.description,
            parameters: toolDef.parameters as any,
            execute: async (_toolCallId, params) => {
              const result = await handler(toolDef.name, params as Record<string, unknown>, { sessionId });
              return {
                content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }],
                details: {},
              };
            },
          });
        }
      },
    ],
  });
  await loader.reload();

  const { session: agentSession } = await createAgentSession({
    resourceLoader: loader,
    sessionManager: SessionManager.open(session.locator.sessionFile),
  });
  session.agentSession = agentSession;
},
```

注意：需要把 `DefaultResourceLoader` 和 `getAgentDir` 加入顶层 import。

- [ ] **步骤 5：运行 pi-client typecheck 和测试**

运行：`cd packages/pi-client && bun run typecheck`
运行：`cd packages/pi-client && bun test src/client.test.ts --timeout 60000`
预期：PASS（tool call 测试可能需要 LLM 实际调用工具，时间较长）。

- [ ] **步骤 6：Commit**

```bash
git add packages/pi-client/src/types.ts packages/pi-client/src/runtime-registry.ts packages/pi-client/src/client.ts packages/pi-client/src/client.test.ts
git commit -m "feat: add bindToolRuntime to pi-client"
```

---

## 任务 5：接入 API 层

**文件：**
- 修改：`apps/api/src/routes/sessions.ts`
- 修改：`apps/api/src/routes/projects.ts`

- [ ] **步骤 1：在 `POST /chat/messages` 接入 tool runtime**

在 `apps/api/src/routes/sessions.ts` 中，`POST /chat/messages` 的 `restoreRuntime` 之后，新增 `bindToolRuntime` 调用：

```ts
import { getDbPath } from '../db-context';
import { buildAllToolDefs, invokePlatformTool } from '@piplus/domain/extensions/registry';

// 在 restoreRuntime 之后、subscribeSession 之前：
const toolDefs = await buildAllToolDefs(db);
await piClient.bindToolRuntime(sessionId, toolDefs, async (toolName, args) => {
  return invokePlatformTool(toolName, args, {
    db,
    piClient,
    sessionId,
    userId,
  });
});
```

- [ ] **步骤 2：运行 API typecheck**

运行：`cd apps/api && bun run typecheck`
预期：PASS。

- [ ] **步骤 3：Commit**

```bash
git add apps/api/src/routes/sessions.ts
git commit -m "feat: bind role manager tools in api send message route"
```

---

## 任务 6：全量验证

- [ ] **步骤 1：运行 domain 全量测试**

运行：`bun test packages/domain/src/role-manager/service.test.ts packages/domain/src/extensions/role-catalog.test.ts packages/domain/src/extensions/role-manager-tools.test.ts`
预期：PASS。

- [ ] **步骤 2：运行 pi-client 全量测试**

运行：`cd packages/pi-client && bun test src/client.test.ts --timeout 60000`
预期：PASS。

- [ ] **步骤 3：运行 API 基础测试**

运行：`cd apps/api && bun test src/routes/sessions.test.ts src/routes/sessions.stream.test.ts --timeout 30000`
预期：PASS。

- [ ] **步骤 4：全量 typecheck**

运行：
```bash
cd packages/domain && bun run typecheck
cd packages/pi-client && bun run typecheck
cd apps/api && bun run typecheck
```
预期：全部 PASS。

- [ ] **步骤 5：最终 Commit**

```bash
git add -A
git commit -m "feat: role manager extension tool via pi sdk"
```

---

## 自检

- 规格的所有主要内容均有对应任务：
  - 动态角色目录 → 任务 1
  - spawnSession 参数升级 → 任务 2
  - tool adapter / registry 瘦身 → 任务 3
  - pi-client bindToolRuntime → 任务 4
  - API 层接入 → 任务 5
- 没有占位符，每个步骤都有具体代码和命令
- 类型命名统一：`RoleCatalog`、`RoleCatalogEntry`、`bindToolRuntime`、`buildAllToolDefs`、`invokePlatformTool`、`invokeRoleManagerTool`
- 任务 2 对旧 `target` 字段的兼容性：`spawn-session.ts` 完全替换，`service.ts` 替换，`service.test.ts` 同步更新，`registry.ts` 已指向新 adapter

唯一风险：任务 4 的 `bindToolRuntime` 测试依赖真实 LLM 调用工具，在网络慢时可能超时，已在测试命令中加了 `--timeout 60000`。
