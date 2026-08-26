# ask_question 交互式提问工具 + 前端表单渲染 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 piplus 中实现 ask_question 工具（阻塞等待 + WS 推送 + 回填），默认加载，前端表单渲染（单选/多选/问卷 + 已回答卡片），并通过 before_agent_start 注入 systemPrompt。

**架构：** 后端在 `packages/domain/src/extensions/ask-question.ts` 维护 pendingQuestions 内存 Map（questionId → Promise），`execute` 生成 questionId 后通过注册的 WS 回调推送 `ask_question_pending` 事件并 await 前端回填或 5 分钟超时；前端 `TabChat.tsx` 识别 ask_question 的 tool_call/tool_result，待回答时渲染表单（radio/checkbox/自定义输入/问卷导航），已回答时渲染结果卡片；`packages/domain/src/extensions/registry.ts` 将 ask_question 加入默认工具列表，`packages/pi-client/src/client/session-lifecycle.ts` 与 `tools.ts` 支持带 details 的工具返回，`apps/api/src/routes/sessions/routes/ask-question.ts` 提供 POST 回填端点。

**技术栈：** TypeScript, Hono, Drizzle, Pi SDK (extensionFactories/pi.registerTool), React + Tailwind, WebSocket (shared/ws)

---

### 文件清单

**新建：**
- `packages/domain/src/extensions/ask-question.ts` — ask_question 工具定义、pending 存储、execute/answer/timeout、before_agent_start 扩展工厂
- `apps/api/src/routes/sessions/routes/ask-question.ts` — POST /api/v1/sessions/:sessionId/ask-answer 回填路由
- `apps/web/src/components/AskQuestionCard.tsx` — 表单卡片与结果卡片组件（待回答/已回答）

**修改：**
- `packages/domain/src/extensions/registry.ts` — buildAllToolDefs 加入 ask_question、invokePlatformTool 分发
- `packages/pi-client/src/client/session-lifecycle.ts` — extensionFactories 支持 before_agent_start 注入 + 透传 details
- `packages/pi-client/src/client/tools.ts` — 同上，支持 details 透传
- `packages/domain/src/session/runtime.ts` — 可选：注入 ask_question 的 systemPrompt（若 registry 不直接处理）（或在 ask-question 扩展内通过 pi.on 实现）
- `apps/api/src/ws/server.ts` — 新增 ask_question_answer WS 上行处理（可选，与 HTTP 回填选一，优先 HTTP）
- `apps/web/src/components/TabChat.tsx` — 识别 ask_question tool_call/tool_result，渲染表单卡片/结果卡片，订阅 WS ask_question_pending
- `packages/shared/src/ws.ts` — 新增 WS 客户端/服务端消息类型（如 ask_question_pending / ask_question_answer）
- `apps/api/src/ws/protocol.ts` — createAskQuestionPendingEvent helper（可选）
- `apps/api/src/routes/sessions/routes/index.ts` — 注册 ask-question 路由

---

### 任务 1：后端 pending 存储 + 工具定义 + 阻塞等待 + 超时

**文件：**
- 创建：`packages/domain/src/extensions/ask-question.ts`
- 测试：`packages/domain/src/extensions/ask-question.test.ts`

- [ ] **步骤 1：编写失败的测试 — 工具定义与 pending 流程**

```ts
import { describe, test, expect } from "bun:test";
import { buildAskQuestionToolDef, pendingQuestions, normalizeOptions } from "./ask-question";

describe("ask_question tool def", () => {
  test("tool def has correct name and no required params", () => {
    const def = buildAskQuestionToolDef();
    expect(def.name).toBe("ask_question");
    expect(def.parameters.required).toEqual([]);
    expect(def.parameters.properties.question).toBeDefined();
    expect(def.parameters.properties.options).toBeDefined();
    expect(def.parameters.properties.questions).toBeDefined();
  });
  test("normalizeOptions dedup and slice 8", () => {
    expect(normalizeOptions(["a","a"," b "])).toEqual(["a","b"]);
  });
});

describe("pending lifecycle", () => {
  test("createPending + answer resolves", async () => {
    const { createPending, answerQuestion } = await import("./ask-question");
    const { questionId, promise } = createPending("sess1", { question: "Q?", options: ["A","B"] });
    const result = answerQuestion(questionId, "A");
    expect(result.ok).toBe(true);
    const val = await promise;
    expect(val.answer).toBe("A");
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /data/code/piplus/.worktrees/ask-question && bun test packages/domain/src/extensions/ask-question.test.ts`
预期：FAIL — file not found

- [ ] **步骤 3：编写最少实现 — 定义 tool def、pending map、createPending/answerQuestion/execute、5 分钟超时**

```ts
// ask-question.ts 伪码要点
export const pendingQuestions = new Map<string, PendingEntry>();
export function buildAskQuestionToolDef(): PiToolDef { /* schema 如需求 */ }
export function createPending(sessionId, params): {questionId, promise}
export function answerQuestion(questionId, answer): {ok:boolean}
export async function executeAskQuestion(params, ctx) { /* 生成 id、推送 WS 回调、await promise、超时返回未回答 */ }
export function normalizeOptions(opts: string[]): string[]
// 监听器注册：onAskQuestionPending(cb)
```

包含 5 分钟超时：setTimeout 5*60*1000 后 resolve 为 {cancelled:true}

- [ ] **步骤 4：运行测试验证通过**

运行：`bun test packages/domain/src/extensions/ask-question.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add packages/domain/src/extensions/ask-question.ts packages/domain/src/extensions/ask-question.test.ts
git commit -m "feat: add ask_question pending store and tool definition"
```

---

### 任务 2：默认加载 + registry 集成 + before_agent_start 注入

**文件：**
- 修改：`packages/domain/src/extensions/registry.ts`
- 修改：`packages/pi-client/src/client/session-lifecycle.ts`
- 修改：`packages/pi-client/src/client/tools.ts`

- [ ] **步骤 1：编写失败的测试 — registry 包含 ask_question**

```ts
import { buildAllToolDefs } from "./registry";
test("buildAllToolDefs includes ask_question", async () => {
  const defs = await buildAllToolDefs(mockDb);
  expect(defs.some(d => d.name === "ask_question")).toBe(true);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`bun test packages/domain/src/extensions/registry.test.ts`
预期：FAIL

- [ ] **步骤 3：修改 registry.ts**

```ts
import { buildAskQuestionToolDef } from "./ask-question";
export async function buildAllToolDefs(db, projectId?) {
  const catalog = await loadRoleCatalog(db, projectId);
  const defs = buildRoleManagerToolDefs(catalog);
  defs.push(buildAskQuestionToolDef());
  return defs;
}
export async function invokePlatformTool(toolName, args, ctx) {
  if (toolName === "ask_question") return executeAskQuestion(args, ctx);
  return invokeRoleManagerTool(toolName, args, ctx);
}
```

同时在 `session-lifecycle.ts` / `tools.ts` 的 `pi.registerTool` 扩展工厂中支持返回 `{content, details}` 的透传（若 result 含 content/details 则直接返回，否则包一层 text）。

before_agent_start：在 ask-question.ts 导出 `askQuestionExtensionFactory`，在其中 `pi.on('before_agent_start', ...)` 注入 systemPrompt 片段；registry 或 runtime 里将该 factory 加入 extensionFactories。

- [ ] **步骤 4：运行测试验证通过**

运行：`bun test packages/domain/src/extensions/registry.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add packages/domain/src/extensions/registry.ts packages/pi-client/src/client/session-lifecycle.ts packages/pi-client/src/client/tools.ts
git commit -m "feat: register ask_question as default tool with before_agent_start prompt"
```

---

### 任务 3：回填通道 — HTTP POST + WS 推送

**文件：**
- 创建：`apps/api/src/routes/sessions/routes/ask-question.ts`
- 修改：`apps/api/src/ws/server.ts`（可选 WS 上行）
- 修改：`packages/shared/src/ws.ts`
- 修改：`apps/api/src/routes/sessions/routes/index.ts`

- [ ] **步骤 1：编写失败的测试 — POST 回填**

```ts
test("POST /api/v1/sessions/:sessionId/ask-answer resolves pending", async () => {
  const { createPending } = await import("@piplus/domain/extensions/ask-question");
  const { questionId, promise } = createPending("sess1", { question: "Q?", options: ["A","B"] });
  const app = createApp();
  const res = await app.request(`/api/v1/sessions/sess1/ask-answer`, { method: "POST", headers: {...}, body: JSON.stringify({ questionId, answer: "A"}) });
  expect(res.status).toBe(200);
  expect((await promise).answer).toBe("A");
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`bun test apps/api/src/routes/ask-question.test.ts`
预期：FAIL

- [ ] **步骤 3：实现路由**

```ts
app.post('/api/v1/sessions/:sessionId/ask-answer', async (c) => {
  // 鉴权、session 归属校验
  // body: { questionId, answer: string|string[]|null, wasCustom?, customAnswers? }
  // 调用 answerQuestion(questionId, answer)
  // 成功返回 {ok:true}，不存在返回 404，sessionId 不匹配返回 403
});
```

WS 推送：在 ask-question.ts 中 `createPending` 内调用 `notifyPending(sessionId, payload)`，api 启动时 `onAskQuestionPending(payload => socketHub.sendToSession(sessionId, createEvent('ask_question_pending', payload)))`

shared/ws.ts 新增类型：
```ts
export type ServerAskQuestionPending = { kind:'event', type:'ask_question_pending', payload:{ questionId, question, options, multiSelect, questions } }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`bun test apps/api`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add apps/api/src/routes/sessions/routes/ask-question.ts packages/shared/src/ws.ts apps/api/src/ws/server.ts
git commit -m "feat: add ask_question answer channel (HTTP POST + WS push)"
```

---

### 任务 4：前端 WS 订阅与 AskQuestionCard 组件

**文件：**
- 创建：`apps/web/src/components/AskQuestionCard.tsx`
- 修改：`apps/web/src/lib/ws-provider.tsx` 或 `ws-client.ts`
- 测试：`apps/web/src/components/AskQuestionCard.test.tsx`（可选，vitest）

- [ ] **步骤 1：编写失败的测试 — 组件渲染**

用 happy-dom/jsdom 渲染 AskQuestionCard，传入单选/多选/问卷 props，断言表单元素存在。

- [ ] **步骤 2：实现 AskQuestionCard**

单问题：
- props: { question, options, multiSelect, questionId, sessionId, onSubmit/onCancel }
- 单选：radio 组；多选：checkbox 组；底部"自己输入"文本框
- 提交按钮 disabled 直到有选择或输入；取消按钮

问卷：
- props: { questions: Array<{question,options,multiSelect,label}> }
- 渲染标签页或顺序排列；提交时收集所有答案

已回答状态：
- 单选：✓ 答案
- 自定义：✓ 自己输入：X
- 多选：每项一行 ✓ X
- 取消：warning 色"已取消"
- 问卷：逐题 ✓ label：答案
- 样式 Tailwind，与现有工具卡片一致，绿增/强调色

- [ ] **步骤 3：运行测试验证通过**

运行：`bun test apps/web/src/components/AskQuestionCard.test.tsx`

- [ ] **步骤 4：Commit**

```bash
git add apps/web/src/components/AskQuestionCard.tsx apps/web/src/lib/ws-provider.tsx
git commit -m "feat: add AskQuestionCard form and result rendering"
```

---

### 任务 5：前端 TabChat 集成 — 识别 tool_call/tool_result + pending WS 插入

**文件：**
- 修改：`apps/web/src/components/TabChat.tsx`
- 修改：`apps/web/src/lib/ws-provider.tsx`

- [ ] **步骤 1：编写失败的测试 — TabChat 渲染 ask_question 卡片**

模拟 messages 含 ask_question tool_call，断言 TabChat 渲染表单而非纯文本。

- [ ] **步骤 2：修改 TabChat.tsx**

- 导入 AskQuestionCard
- 新增 state: `pendingAskQuestions: Map<questionId, pendingPayload>`
- ws-provider 新增订阅：收到 `ask_question_pending` 事件时加入 map
- 在 messages 渲染循环中：
  - 若 msg.message_kind==='tool_call' && msg.tool_name==='ask_question' 且 pendingAskQuestions 有对应项 → 渲染 AskQuestionCard 待回答状态
  - 若 msg.message_kind==='tool' && msg.tool_name==='ask_question' → 解析 details（或 content[0].text 降级），渲染 AskQuestionCard 已回答状态
- 处理提交：POST /api/v1/sessions/:sessionId/ask-answer，乐观更新

- [ ] **步骤 3：运行测试验证通过**

运行：`bun test apps/web`

- [ ] **步骤 4：Commit**

```bash
git add apps/web/src/components/TabChat.tsx apps/web/src/lib/ws-provider.tsx
git commit -m "feat: integrate ask_question rendering in TabChat with WS pending flow"
```

---

### 任务 6：打通验证 — typecheck + bun test + 手动端到端

**文件：** 无新增，仅验证

- [ ] **步骤 1：运行 typecheck**

运行：`cd /data/code/piplus/.worktrees/ask-question && bun run typecheck`

预期：所有包 typecheck 通过

- [ ] **步骤 2：运行 bun test**

运行：`bun test`（或分别 `cd apps/api && bun test` / `packages/domain && bun test`）

预期：无新增失败

- [ ] **步骤 3：手动验证（如有空）**

启动 dev 环境，触发 ask_question 工具（可临时加一条 slash command 或直接让模型调用），验证：
- 前端弹出表单
- 单选/多选/自定义输入提交后模型继续
- 超时 5 分钟返回"用户未回答"
- 问卷导航与提交

```
