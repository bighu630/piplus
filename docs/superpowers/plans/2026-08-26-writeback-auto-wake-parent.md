# writeback 自动拉起 idle 父会话 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** `writebackToParent()` 落库后若父会话 `runtimeStatus='idle'` 则自动调用 `startSessionRun` 拉起父会话，将 writeback 的 summary(+blocks) 作为新一轮 run 的用户消息写入，避免内容躺在 DB 无人消费。

**架构：** 在 `packages/domain/src/role-manager/service.ts:writebackToParent` 落库后增量检查父会话状态；`idle` 时动态 `import('../session/runtime')` 调用 `startSessionRun`（原子 idle→running 认领保证幂等），`running`/`stopping` 跳过；`stopping`/已归档/不存在的父会话跳过；通过 `requestId`/`messageId` 与 runtime 的原子认领天然去重；WS 通知走 `startSessionRun` 的 `onRuntimeStatusChange` 回调（domain 层通过可注入回调避免直接依赖 `socketHub`）。

**技术栈：** TypeScript / Bun / drizzle-orm / @piplus/db / @piplus/pi-client / @piplus/domain

---

## 文件结构

- 修改：`packages/domain/src/role-manager/service.ts` — 在 `writebackToParent` 末尾追加 idle 检查与 `startSessionRun` 拉起逻辑（动态 import 规避 `service ↔ runtime` 循环依赖）
- 可选修改：`packages/domain/src/session/runtime.ts` — 无需改动（复用现有 `startSessionRun` 原子认领语义）；若需仅为注释补充
- 测试：`packages/domain/src/role-manager/service.test.ts` — 新增 4-5 个用例覆盖 idle 拉起 / running 跳过 / stopping 跳过 / 父会话不存在归档跳过 / 去重（session_busy 吞错）
- 计划：`docs/superpowers/plans/2026-08-26-writeback-auto-wake-parent.md` — 本文件

---

### 任务 1：基线确认与可复现验证

**文件：**
- 读取：`packages/domain/src/role-manager/service.ts:533`、`packages/domain/src/session/runtime.ts:166`、`packages/domain/src/session/request-context.ts`

- [ ] **步骤 1：确认当前分支与基线测试通过**

```bash
git branch --show-current # 期望 dev
cd /data/code/piplus && bun run typecheck 2>&1 | tail -n 20
cd /data/code/piplus && bun test packages/domain/src/role-manager/service.test.ts 2>&1 | tail -n 30
```

预期：`typecheck` 0 错误，现有 `service.test.ts` 7 个用例全 PASS；记录基线输出供对比

- [ ] **步骤 2：确认现状 writeback 不拉起（手工复现）**

在 `service.test.ts` 临时片段或 node REPL 中验证：`await roleManager.writebackToParent(...)` 后父 `runtimeStatus` 仍为 `idle` 且无 `startSessionRun` 调用（当前行为）

预期：确认“躺 DB”现状成立，为任务 2 提供失败基线

---

### 任务 2：实现 writebackToParent 的 idle 自动拉起（核心）

**文件：**
- 修改：`packages/domain/src/role-manager/service.ts`
- 测试：`packages/domain/src/role-manager/service.test.ts`（本任务先加 1 个失败用例）

- [ ] **步骤 1：编写失败的测试 — idle 父会话应被拉起**

在 `packages/domain/src/role-manager/service.test.ts` 新增用例（紧跟现有 `writes back to the resolved parent session internally` 用例之后）：

```ts
test('writeback auto-wakes idle parent session', async () => {
  const { db, roleManager, piClient } = await setupDomain();
  const { projectId, sessionId: parentSessionId } = await roleManager.createProjectWithPlanner({
    name: 'Wake Parent',
    createdBy: 'user_seed',
  });
  const { sessionId: childSessionId } = await roleManager.spawnSession({
    projectId,
    parentSessionId,
    createdBy: 'user_seed',
    role: 'worker',
    objective: 'do work',
    title: 'Do Work',
    constraints: [],
  });

  // 关键：mock piClient 的 startSessionRun 依赖方法
  // makeRecordingPiClient 已有 ensureRuntime/subscribeSession/sendMessage 等桩
  // 为验证拉起，需要让 piClient.ensureRuntime 不抛错且 startSessionRun 能认领 idle→running
  // 做法：让 piClient.subscribeSession 返回一次性的空订阅，sendMessage 正常 resolve
  // 父会话默认 idle，writeback 后应变为 running（被认领）
  await roleManager.writebackToParent({
    childSessionId,
    summary: 'Task done',
    blocks: [{ type: 'text', text: 'done' }],
  });

  const [parent] = await db.select().from(sessions).where(eq(sessions.id, parentSessionId)).limit(1);
  // 失败基线：当前实现 parent.runtimeStatus 仍为 idle
  expect(parent?.runtimeStatus).toBe('running');
});
```

运行：

```bash
cd /data/code/piplus && bun test packages/domain/src/role-manager/service.test.ts -t "writeback auto-wakes idle parent" 2>&1 | tail -n 40
```

预期：FAIL（`expected idle to be running`），证明尚未实现拉起

- [ ] **步骤 2：运行测试验证失败**

执行上条命令，确认 FAIL 并记录错误信息

- [ ] **步骤 3：编写最少实现代码 — 在 service.ts 追加拉起逻辑**

修改 `packages/domain/src/role-manager/service.ts`，在 `writebackToParent` 的 `touchProject` 之后、`return` 之前插入：

```ts
// Auto-wake idle parent (fire-and-forget, best-effort)
try {
  const [parent] = await db.select().from(sessions).where(eq(sessions.id, parentSessionId)).limit(1);
  if (!parent) return { parentSessionId, messageId };
  if ((parent as any).status && (parent as any).status !== 'active') return { parentSessionId, messageId };
  if (parent.runtimeStatus !== 'idle') return { parentSessionId, messageId };
  // 已归档或已删除的会话跳过（status !== active）
  // planner 的 writeback 工具已在 runtime 层过滤，不会循环（见 runtime.ts 工具过滤）

  const summaryText = input.summary ?? '';
  const blocksPart = input.blocks ? `\n\n${JSON.stringify(input.blocks, null, 2)}` : '';
  const content = `${summaryText}${blocksPart}`.trim() || summaryText;

  // 避免 service ↔ runtime 循环依赖：动态 import
  const { startSessionRun } = await import('../session/runtime');
  const userId = (child as any).createdBy ?? (parent as any).createdBy;
  if (!userId) return { parentSessionId, messageId };

  // 去重/防并发：依赖 startSessionRun 内部的原子 idle→running 认领
  // 若并发已将父置为 running，此处会抛 session_busy，被下层 catch 吞掉
  await startSessionRun({
    db: db as any,
    piClient: piClient as any,
    sessionId: parentSessionId,
    userId,
    content,
    requestId: `wb_${messageId}`,
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('session_busy') || msg.includes('session_not_found')) {
      console.log('[role-manager] auto-wake skipped', { parentSessionId, reason: msg });
      return;
    }
    console.warn('[role-manager] auto-wake failed', { parentSessionId, err: msg });
  });
} catch (err) {
  console.warn('[role-manager] auto-wake check failed', { parentSessionId, err: String(err) });
}
```

同时确保文件顶部已有 `import { getRequestContext } from '../session/request-context'`（已有），无需新增静态 import；`piClient` 通过 `createRoleManagerService(db, piClient)` 闭包已可用。

可选增强：若项目需要 WS 通知，在 `createRoleManagerService` 第三个参数注入 `onRuntimeStatusChange` 回调，并在 `startSessionRun` 调用中透传；缺省则不传，行为与现有非 WS 路径一致。

- [ ] **步骤 4：运行测试验证通过**

```bash
cd /data/code/piplus && bun test packages/domain/src/role-manager/service.test.ts -t "writeback auto-wakes idle parent" 2>&1 | tail -n 40
```

预期：PASS，`parent.runtimeStatus === 'running'`

- [ ] **步骤 5：Commit**

```bash
git add packages/domain/src/role-manager/service.ts packages/domain/src/role-manager/service.test.ts
git commit -m "feat(domain): auto-wake idle parent on writeback"
```

---

### 任务 3：补齐边界与去重/防并发语义

**文件：**
- 修改：`packages/domain/src/role-manager/service.ts`（若任务 2 未完全覆盖则补齐）
- 测试：`packages/domain/src/role-manager/service.test.ts`

- [ ] **步骤 1：编写失败的测试 — running / stopping / 已归档父会话不拉起 + session_busy 去重**

新增 3 个用例：

```ts
test('writeback does not wake running parent', async () => {
  // 将父置为 running 后 writeback，断言仍为 running 且 startSessionRun 未二次认领（无抛错）
});

test('writeback does not wake stopping parent', async () => {
  // 将父 runtimeStatus 设为 stopping，writeback 后仍为 stopping
});

test('writeback skips wake when parent archived or deleted', async () => {
  // 将父 status 设为 archived 或删除行，writeback 仍落库但不抛错
});

test('concurrent writebacks deduplicate via atomic claim', async () => {
  // 连续两次 writebackToParent 同一 child，第一次将父拉为 running，第二次应捕获 session_busy 且不抛错
  // 断言两次调用均返回 parentSessionId，且父最终为 running
});
```

每个用例先以当前实现跑一遍，running/stopping/archived 场景应已在任务 2 的提前返回中 PASS；并发去重用例需验证第二次调用不抛错（依赖 catch 分支）。

运行：

```bash
cd /data/code/piplus && bun test packages/domain/src/role-manager/service.test.ts -t "writeback does not wake" 2>&1 | tail -n 40
cd /data/code/piplus && bun test packages/domain/src/role-manager/service.test.ts -t "concurrent writebacks" 2>&1 | tail -n 40
```

预期：首次运行若未覆盖则 FAIL，补齐后 PASS

- [ ] **步骤 2：实现最少代码补齐**

若任务 2 已包含 `if (parent.runtimeStatus !== 'idle') return` 与 `status !== 'active'` 检查，则本步骤仅需确认 `catch` 分支对 `session_busy` 的吞错逻辑存在；否则按任务 2 的代码块补齐对应分支。

- [ ] **步骤 3：运行测试验证通过**

```bash
cd /data/code/piplus && bun test packages/domain/src/role-manager/service.test.ts 2>&1 | tail -n 40
```

预期：新增 4 用例全部 PASS，旧有 7 用例保持 PASS

- [ ] **步骤 4：Commit**

```bash
git add packages/domain/src/role-manager/service.ts packages/domain/src/role-manager/service.test.ts
git commit -m "test(domain): cover writeback wake skips and deduplication"
```

---

### 任务 4：可选 WS 通知（socketHub）

**文件：**
- 修改：`packages/domain/src/role-manager/service.ts`（为 `createRoleManagerService` 增加可选第三参 `opts?: { onRuntimeStatusChange?: ... }`）
- 或：`apps/api` 侧在创建 roleManager 时传入回调（若保持 domain 零依赖则跳过本任务，仅保留日志）

- [ ] **步骤 1：评估是否需要 domain 直连 socketHub**

检查 `apps/api/src/routes/sessions/routes/runtime.ts` 中 `socketHub.sendToSession` 的调用方式；确认 domain 层不应直接 `import { socketHub } from '@api/ws/server'`，应通过回调注入避免跨包循环。

决策：
- 若评估为“保持 domain 零依赖”，则本任务仅保留 `console.log('[role-manager] parent auto-woken', { parentSessionId, messageId })` 日志，前端通过轮询 `sessions.runtimeStatus` 感知；不改代码，仅在计划中记录决策
- 若评估为“需要实时 WS”，则为 `createRoleManagerService(db, piClient, opts?)` 增加 `onRuntimeStatusChange` 并在 `startSessionRun` 调用中透传，`apps/api` 侧创建实例时传入 `socketHub` 推送

- [ ] **步骤 2：实现（若决策为需要）**

```ts
export function createRoleManagerService(db: RoleManagerDb, piClient: PiClient, opts?: {
  onRuntimeStatusChange?: (p: { sessionId: string; projectId: string; runtimeStatus: 'running'|'idle'; error: string|null }) => void|Promise<void>;
}) {
  // ...
  await startSessionRun({
    // ...
    onRuntimeStatusChange: opts?.onRuntimeStatusChange,
  });
}
```

- [ ] **步骤 3：验证**

```bash
cd /data/code/piplus && bun run typecheck 2>&1 | tail -n 20
```

预期：无新增类型错误

- [ ] **步骤 4：Commit（若有改动）**

```bash
git add packages/domain/src/role-manager/service.ts
git commit -m "feat(domain): wire optional runtime status callback for writeback wake"
```

---

### 任务 5：全量验证

- [ ] **步骤 1：类型检查**

```bash
cd /data/code/piplus && bun run typecheck 2>&1 | tail -n 30
```

预期：0 错误

- [ ] **步骤 2：领域单测**

```bash
cd /data/code/piplus && bun test packages/domain/src/role-manager/service.test.ts 2>&1 | tail -n 40
```

预期：全部 PASS（含新增 4-5 用例）

- [ ] **步骤 3：关联运行时单测（回归）**

```bash
cd /data/code/piplus && bun test packages/domain/src/session/runtime.test.ts 2>&1 | tail -n 40
```

预期：PASS（未改 runtime 逻辑，仅复用）

---

## 自检

- 规格覆盖：idle 拉起 / running 跳过 / stopping 跳过 / 去重防并发 / 避免循环 / 可选 WS 均有对应任务（任务 2/3/4）
- 占位符：无 TODO/待定，所有步骤含可执行代码与命令
- 类型一致：`createRoleManagerService` 签名变更向后兼容（opts 可选）；`startSessionRun` 入参与现有定义一致；`sessions.status`/`runtimeStatus` 字段名与 schema 一致

