# Role Manager Extension Tool Design

日期：2026-06-11

## 1. 背景

当前 `packages/domain/src/extensions/registry.ts` 已经存在 `spawn_session` 和 `writeback_to_parent` 的 tool 定义和 handler 雏形，但存在以下问题：

- tool 描述是静态写死的，无法反映当前数据库角色目录
- tool 参数模型 `target + constraints` 语义不清，不适合角色管理场景
- tool 还没有通过 pi extension 机制真正注册到 agent session
- tool 调用链路 `tool_call → handler → role-manager → pi-client` 还没打通
- `registry.ts` 职责混乱，既有 tool schema 又有 tool dispatcher 又有业务编排

本次设计目标是把这套角色管理能力真正通过 `pi SDK` 的 extension/tool 机制暴露给 LLM，并升级 tool 入参模型、动态化角色目录描述。

## 2. 目标

- 通过 pi extension/tool runtime 把 `spawn_session` / `writeback_to_parent` 注册进 agent session
- LLM 根据 tool 说明自主决定何时调用，平台负责执行和角色实例化
- tool 说明里展示的可创建角色集合动态来自角色目录，不写死
- tool 参数升级为结构化字段，便于平台做 prompt 拼装和审计
- 不限制哪个 session 可以调用 `spawn_session`（当前阶段）

## 3. 非目标

- 角色创建权限控制（后续版本）
- `spawnable` 标记筛选（后续版本）
- 运行中的 session 动态热刷新 tool 描述
- 跨 session 的 tool 共享机制

## 4. 核心原则

### 4.1 tool 是 LLM 意图入口
LLM 只需要知道：
- 有哪些 tool 可用
- tool 参数怎么填
- 什么场景下适合用

LLM 不需要知道：
- 角色系统内部结构
- session 树的实现
- prompt 怎么拼装
- session locator 是什么

### 4.2 平台负责所有角色治理
role-manager 负责：
- 查角色模板
- 拼装最终 system prompt
- 创建 pi session
- 记录 DB session 信息
- 维护 parent/root/depth

### 4.3 动态角色目录的刷新粒度
- session 创建时快照角色目录
- session 恢复（restoreRuntime）时重新快照
- 不做运行中热更新

## 5. 分层设计

### 5.1 新增：`packages/domain/src/extensions/role-catalog.ts`

职责：
- 从 DB 读取所有未归档角色模板
- 合并内置默认角色说明
- 如果 DB 中有 description，优先用 DB 的；否则回退内置说明（策略 C）
- 返回给 tool 描述生成器使用

```ts
type RoleCatalogEntry = {
  key: string;
  name: string;
  description: string;
  source: 'builtin' | 'db';
};

type RoleCatalog = {
  roles: RoleCatalogEntry[];
};

async function loadRoleCatalog(db: RoleManagerDb): Promise<RoleCatalog>
```

### 5.2 新增：`packages/domain/src/extensions/role-manager-tools.ts`

职责：
- 根据动态角色目录生成 `spawn_session` tool schema
- 定义 `writeback_to_parent` tool schema
- 校验/标准化 tool 参数
- 调用 role-manager 业务服务
- 返回 tool result 给 LLM

这一层是 LLM tool 协议层，不直接操作 DB。

### 5.3 改造：`packages/domain/src/extensions/registry.ts`

职责收窄为：
- 汇总所有 tool defs（从各 adapter 拿）
- 根据 toolName 分发给对应 handler

不再写死 tool schema，不再内联角色业务逻辑。

### 5.4 改造：`packages/pi-client` 新增 tool runtime 绑定

职责：
- 在 `createSession()` / `restoreRuntime()` 时接收 tool defs
- 通过 pi SDK 的 `customTools` 机制注册到 agent session
- 在 `sendMessage()` 流程中接收 tool call 事件
- 把 tool call 转发给上层 handler
- 把 handler 返回值作为 tool result 回注给 agent session

### 5.5 保留：`packages/domain/src/role-manager/service.ts`

主要改动：
- `spawnSession()` 输入升级，`target` 拆分为 `objective / scope / task`
- `compilePrompt()` 接入新参数
- 其他业务逻辑保持不变

## 6. tool 参数协议

### 6.1 `spawn_session`

```ts
type SpawnSessionToolInput = {
  role: string;
  objective: string;
  scope?: string;
  task?: string;
  constraints?: string[];
};
```

说明：
- `role`：角色 key，必须是当前目录中存在的角色
- `objective`：该角色要达成的最终目标
- `scope`：工作范围 / 修改边界（可选）
- `task`：本次具体执行项（可选）
- `constraints`：额外硬约束列表（可选）

### 6.2 `writeback_to_parent`

```ts
type WritebackToParentToolInput = {
  summary: string;
  blocks?: unknown[];
};
```

### 6.3 tool result

`spawn_session` 成功后返回给 LLM 的内容：

```json
{
  "session_id": "session_xxx",
  "project_id": "project_xxx",
  "role": "worker",
  "title": "Worker - implement API validation",
  "status": "created"
}
```

不返回 locator、文件路径等内部细节。

## 7. 动态角色目录生成

### 7.1 角色目录加载逻辑

```
1. 读取 DB roleTemplates 表中 archivedAt IS NULL 的所有模板
2. 以 role key 为索引，合并内置默认说明
3. 对每个角色：
   - 如果 DB 中有非空 description，使用 DB description
   - 否则使用内置默认说明
4. 返回 RoleCatalog
```

### 7.2 内置默认角色说明

```ts
const BUILTIN_ROLE_DESCRIPTIONS: Record<string, string> = {
  planner: 'Plans and coordinates work. Breaks large goals into structured steps.',
  worker: 'Executes concrete implementation tasks.',
  reviewer: 'Reviews output and returns critiques or confirmations.',
  researcher: 'Investigates a topic and summarizes findings.',
  blank: 'A minimal, no-preset session for ad-hoc work.',
};
```

### 7.3 生成的 tool description 示例

```txt
Create a child session with a specialized role to delegate work.

Available roles right now:
- planner: Plans and coordinates work. Breaks large goals into structured steps.
- worker: Executes concrete implementation tasks.
- reviewer: Reviews output and returns critiques or confirmations.
- researcher: Investigates a topic and summarizes findings.

Use this tool when a task should be delegated to a specialized role.
The platform will create the child session, assemble the role prompt, and
track parent/child session relationships automatically. You do not need to
specify anything beyond the parameters below.
```

## 8. `role-manager.spawnSession()` 参数升级

### 当前

```ts
type SpawnSessionInput = {
  projectId: string;
  parentSessionId: string;
  createdBy: string;
  role: string;
  target: string;
  constraints: string[];
};
```

### 升级后

```ts
type SpawnSessionInput = {
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

### prompt 拼装升级

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

## 9. pi-client tool runtime 绑定方案

### 9.1 PiClient 接口扩展

```ts
type PiToolCallHandler = (
  toolName: string,
  args: Record<string, unknown>,
  context: { sessionId: string; userId?: string | null },
) => Promise<unknown>;

// 新增方法
bindToolRuntime(
  sessionId: string,
  tools: PiToolDef[],
  handler: PiToolCallHandler,
): Promise<void>;
```

### 9.2 实现方式

pi SDK 提供了 `customTools` 参数给 `createAgentSession`：

```ts
const { session } = await createAgentSession({
  sessionManager: ...,
  customTools: [
    {
      name: 'spawn_session',
      description: dynamicDescription,
      parameters: spawnSessionSchema,
      execute: async (args) => {
        return await handler('spawn_session', args, ctx);
      }
    }
  ]
});
```

`bindToolRuntime()` 的职责：
- 保存 tools 和 handler 到 runtime registry
- 创建/恢复 agentSession 时传入 `customTools`
- 每个 tool 的 execute 回调转发给 handler

### 9.3 工作流时序

```
用户发消息
  ↓
api: restoreRuntime(sessionId, locator)
  + bindToolRuntime(sessionId, toolDefs, handler)
  ↓
api: sendMessage(sessionId, content)
  ↓
agentSession.prompt(content)
  ↓
LLM 决定调用 spawn_session
  ↓
SDK 触发 customTool.execute(args)
  ↓
转发到 handler(toolName, args, ctx)
  ↓
invokePlatformTool(toolName, args, ctx)
  ↓
role-manager.spawnSession(...)
  ↓
piClient.createSession(...)
  ↓
DB 记录新 session
  ↓
返回 tool result 给 LLM
  ↓
LLM 继续推理
```

## 10. registry.ts 收窄

改造后的 registry 只做：

```ts
async function buildAllToolDefs(db: RoleManagerDb): Promise<PiToolDef[]> {
  const catalog = await loadRoleCatalog(db);
  return buildRoleManagerToolDefs(catalog);
}

async function invokeAnyTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: PlatformToolContext,
): Promise<unknown> {
  return invokeRoleManagerTool(toolName, args, ctx);
}
```

以后如果有 `audit-tools`、`project-tools` 等新 adapter，在这里合并 defs 和分发 invoke 即可。

## 11. 测试策略

### 11.1 `role-catalog.test.ts`

- 默认角色全部出现在目录中
- DB 中新增角色模板后出现在目录中
- 已归档角色不出现
- DB 有 description 时优先使用 DB 说明
- DB description 为空时使用内置默认说明

### 11.2 `role-manager-tools.test.ts`

- 动态 tool description 包含当前目录中所有角色
- 添加新角色后 tool description 更新
- spawn_session 参数校验正确
- spawn_session 成功调用 role-manager 并返回 session 元信息
- writeback_to_parent 成功调用 role-manager

### 11.3 `pi-client tool runtime test`

- bindToolRuntime 后发消息，LLM 调用 tool，handler 被触发
- tool result 正确返回给 LLM

### 11.4 `role-manager/service.test.ts` 扩展

- spawnSession 接受新的 objective/scope/task 参数
- compiledPrompt 包含 Objective/Scope/Task 节
- 现有 target 字段向后兼容测试

## 12. 兼容性说明

`spawnSession()` 的 `target` 参数会被替换为 `objective`。由于现有唯一调用方是 `registry.ts/invokePlatformTool`，改动面是可控的。`domain` 测试中的 `spawnSession` 调用也需要同步更新。

## 13. 结论

这次设计的核心是：

**LLM 通过 pi extension tool 表达角色派生意图，平台通过 role-manager 将意图转化为受治理的子 session。**

LLM 不知道也不需要知道 session 树、locator、角色模板版本、prompt 结构，它只需要正确使用 tool。
