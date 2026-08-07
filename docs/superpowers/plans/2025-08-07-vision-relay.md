# 多模态模型识别图片转发（vision relay）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 非多模态模型会话中发送图片时，由配置的多模态模型（含备选回退）识别图片生成文字描述，再将描述与用户文本合并后交给原文本模型处理；识别失败时插入 error 历史消息并拒绝整条消息。

**Architecture:** 三层改动：① pi-client 新增 `completeModel` 薄封装（复用模块级 `modelRuntime`，直接调用 SDK `completeSimple`，auth 自动解析）；② 后端 settings 白名单新增 3 个 key（vision_enabled / vision_model / vision_fallback_model），sessions.ts 图片拦截点改造为 vision relay 流程（主→备回退、失败插 error 消息 + 400 拒绝）；③ 前端设置面板新增实验性开关与模型下拉、ChatInput 放行图片、TabChat 渲染 error 消息。

**Tech Stack:** Bun + Hono + drizzle-orm（后端）、React + TanStack Query（前端）、@earendil-works/pi-coding-agent ModelRuntime（模型直调）。

**用户已确认的决策：**
1. 描述文本合并方式：追加在用户文本后（`用户文本\n\n[图片内容识别]\n描述`；纯图片消息仅描述）
2. 主备都失败：**整条拒绝**（用户消息不落库）+ 插入 `messageKind='error'` 历史消息说明原因，HTTP 400 `VISION_DESCRIPTION_FAILED`
3. 实验性标注 UI：设置卡片标题旁橙色"实验性"badge

**默认行为（已与用户确认无异议）：**
- `vision_model` 未配置或格式非法 → 保持原 400 `MODEL_DOES_NOT_SUPPORT_IMAGES` 行为
- 备选模型允许留空（留空 = 不启用回退）

**并行工作区说明：** 本计划 3 个任务分属不同文件集合（Task 1 只碰 packages/shared + packages/domain/index.ts + packages/pi-client；Task 2 只碰 apps/api；Task 3 只碰 apps/web），可并行执行。Task 1 的 `PiCompleteModelInput`/`PiCompleteModelResult` 类型签名在下方"Task 1 交付物"中已锁定，Task 2 依赖该签名（两个 worker 同时开工，最终统一跑 typecheck 验证）。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `packages/shared/src/enums.ts` | MessageKind 增加 `error` |
| `packages/domain/src/index.ts` | 导出 settings/service（getSetting 供 api 使用） |
| `packages/pi-client/src/types.ts` | `PiCompleteModelInput`/`PiCompleteModelResult` 类型 + PiClient 接口方法 |
| `packages/pi-client/src/client.ts` | `completeModel` 实现 + `buildCompleteModelContext` 纯函数 |
| `packages/pi-client/src/client.test.ts` | completeModel 失败路径测试 |
| `apps/api/src/routes/settings.ts` | 3 个新 key 白名单 + per-key 校验 |
| `apps/api/src/routes/settings.test.ts` | 新 key 校验测试 |
| `apps/api/src/routes/sessions.ts` | 图片拦截点 → vision relay；GET 历史合并 error 消息 |
| `apps/api/src/routes/sessions.test.ts` | vision relay 失败路径测试 |
| `apps/web/src/components/SettingsPanel.tsx` | 实验性卡片（开关 + 主/备模型下拉） |
| `apps/web/src/App.tsx` | useSettings 读取 vision 配置并传 ChatInput |
| `apps/web/src/components/TabChat.tsx` | 透传 visionEnabled 到 ChatInput |
| `apps/web/src/components/ChatInput.tsx` | canSendImages 放行 + 文案提示 + 失败错误映射 |

---

## Task 1: shared enums + domain 导出 + pi-client completeModel

**Files:**
- Modify: `packages/shared/src/enums.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/pi-client/src/types.ts`
- Modify: `packages/pi-client/src/client.ts`
- Test: `packages/pi-client/src/client.test.ts`

- [ ] **Step 1: MessageKind 增加 error**

`packages/shared/src/enums.ts` 中：

```ts
export const MessageKind = {
  normal: 'normal',
  writeback: 'writeback',
  error: 'error',
} as const;
```

（`packages/shared/src/dto.ts` 中 `ChatMessageDTO.message_kind: keyof typeof MessageKind | 'tool_call' | 'tool'` 自动覆盖 'error'，无需改动。）

- [ ] **Step 2: domain index 导出 settings service**

`packages/domain/src/index.ts` 末尾追加：

```ts
export * from './settings/service';
```

（settings/service.ts 已存在，导出 getSetting/setSetting/getSubagentTimeoutMs/SETTING_KEY_SUBAGENT_TIMEOUT，与其他导出无命名冲突。）

- [ ] **Step 3: pi-client 类型定义**

`packages/pi-client/src/types.ts` 中，`PiImageInput` 定义之后追加：

```ts
export type PiCompleteModelMessage = {
  role: 'user' | 'assistant';
  content: string;
  images?: PiImageInput[];
};

export type PiCompleteModelInput = {
  provider: string;
  id: string;
  systemPrompt?: string;
  messages: PiCompleteModelMessage[];
  maxTokens?: number;
  signal?: AbortSignal;
};

export type PiCompleteModelResult = {
  text: string;
  stopReason: string;
};
```

`PiClient` 接口中 `sendMessage(...)` 声明之后追加：

```ts
completeModel(input: PiCompleteModelInput): Promise<PiCompleteModelResult>;
```

- [ ] **Step 4: client.ts 实现 buildCompleteModelContext 与 completeModel**

`packages/pi-client/src/client.ts` 中，`normalizeImages` 函数之后追加：

```ts
function buildCompleteModelContext(input: PiCompleteModelInput) {
  return {
    systemPrompt: input.systemPrompt,
    messages: input.messages.map((msg) => ({
      role: msg.role,
      timestamp: Date.now(),
      content: msg.images?.length
        ? [
            { type: 'text' as const, text: msg.content },
            ...msg.images.map((image) => ({
              type: 'image' as const,
              data: image.dataBase64,
              mimeType: image.mimeType ?? image.mediaType ?? 'image/png',
            })),
          ]
        : msg.content,
    })),
  };
}
```

`PiClient` 对象（`createPiClient()` 返回的 `client` 对象）中，`getCurrentModel` 方法之后追加：

```ts
async completeModel(input: PiCompleteModelInput): Promise<PiCompleteModelResult> {
  const model = modelRuntime.getModel(input.provider, input.id);
  if (!model) {
    throw new Error(`model_not_found: ${input.provider}/${input.id}`);
  }
  const message = await modelRuntime.completeSimple(model, buildCompleteModelContext(input), {
    maxTokens: input.maxTokens,
    signal: input.signal,
  });
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { type: 'text'; text: string }).text)
    .join('\n');
  return { text, stopReason: message.stopReason };
}
```

（模块级 `modelRuntime` 已存在：`const modelRuntime = await ModelRuntime.create();`。`completeSimple` 内部 `prepareRequest` 自动解析 auth/apiKey；未配置 provider 时抛 auth 错误，未知模型时上面的 `model_not_found` 先拦截。）

- [ ] **Step 5: client.test.ts 新增失败路径测试**

`packages/pi-client/src/client.test.ts` 的 describe 块内追加：

```ts
test('completeModel rejects unknown model', async () => {
  const client = createPiClient();
  await expect(client.completeModel({
    provider: 'no-such-provider-xyz',
    id: 'no-such-model',
    messages: [{ role: 'user', content: 'hi' }],
  })).rejects.toThrow(/model_not_found/);
});
```

- [ ] **Step 6: 运行测试验证**

```bash
cd apps/api && bun test 2>&1 | tail -5
```

Expected: 全部通过（`completeModel rejects unknown model` 出现且 pass）。

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/enums.ts packages/domain/src/index.ts packages/pi-client/src/types.ts packages/pi-client/src/client.ts packages/pi-client/src/client.test.ts
git commit -m "feat(pi-client): add completeModel direct-call wrapper and error MessageKind"
```

---

## Task 2: 后端 settings 白名单 + sessions.ts vision relay

**Files:**
- Modify: `apps/api/src/routes/settings.ts`
- Test: `apps/api/src/routes/settings.test.ts`
- Modify: `apps/api/src/routes/sessions.ts`
- Test: `apps/api/src/routes/sessions.test.ts`

### 2a. settings.ts

- [ ] **Step 1: 重写校验逻辑**

`apps/api/src/routes/settings.ts` 中，将 ALLOWED_KEYS 与校验逻辑替换为：

```ts
// 允许通过 API 读写的设置项白名单
const ALLOWED_KEYS: readonly string[] = ['subagent_timeout_minutes', 'vision_enabled', 'vision_model', 'vision_fallback_model'];

// 严格校验：非负整数分钟（0 = 永不超时）。
// 拒绝 true→1、null→0、"1e3"→1000、"0x10"→16 等宽松隐式转换。
const isNonNegInt = (raw: unknown): boolean =>
  (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) ||
  (typeof raw === 'string' && /^\d+$/.test(raw.trim()));

// 存储时统一为 String 形式（Number 30 → '30'；字符串 '30' → '30'）
function normalizeValue(raw: number | string): string {
  return typeof raw === 'number' ? String(raw) : raw.trim();
}

// 模型引用格式：provider/id（id 内可含 '/'，如 custom-provider/models/xxx）
const MODEL_REF_PATTERN = /^[^/\s]+\/.+$/;

/** 返回规范化后的存储值；返回 null 表示校验失败（message 中有原因）。空字符串表示清除配置。 */
function validateSettingValue(key: string, raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
  switch (key) {
    case 'subagent_timeout_minutes': {
      if (!isNonNegInt(raw)) {
        return { ok: false, message: 'subagent_timeout_minutes 必须是非负整数分钟（0 = 永不超时）' };
      }
      return { ok: true, value: normalizeValue(raw as number | string) };
    }
    case 'vision_enabled': {
      const s = typeof raw === 'string' ? raw.trim() : String(raw);
      if (s !== 'true' && s !== 'false') {
        return { ok: false, message: 'vision_enabled 必须是 "true" 或 "false"' };
      }
      return { ok: true, value: s };
    }
    case 'vision_model':
    case 'vision_fallback_model': {
      const s = typeof raw === 'string' ? raw.trim() : '';
      if (s !== '' && !MODEL_REF_PATTERN.test(s)) {
        return { ok: false, message: `${key} 必须是 "provider/id" 格式` };
      }
      return { ok: true, value: s };
    }
    default:
      return { ok: false, message: `未知设置项: ${key}` };
  }
}
```

PUT handler 中的校验循环替换为：

```ts
    // 先全量校验（白名单 + 值），任一非法立即 400 且不写入任何行；
    // 全部通过后再统一 upsert。
    const entries: Array<[string, string]> = [];
    for (const [key, raw] of Object.entries(body)) {
      if (!ALLOWED_KEYS.includes(key)) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: `未知设置项: ${key}` } }, 400);
      }
      const result = validateSettingValue(key, raw);
      if (!result.ok) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: result.message } }, 400);
      }
      entries.push([key, result.value]);
    }
```

- [ ] **Step 2: settings.test.ts 新增测试**

`apps/api/src/routes/settings.test.ts` describe 块内追加：

```ts
  test('PUT accepts vision_enabled boolean and model refs', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const res = await app.request('/api/v1/settings', {
      method: 'PUT',
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        vision_enabled: 'true',
        vision_model: 'anthropic/claude-sonnet-4-5',
        vision_fallback_model: 'openai/gpt-4o',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.vision_enabled).toBe('true');
    expect(body.vision_model).toBe('anthropic/claude-sonnet-4-5');

    const db = createDb(`file:${path}`);
    const rows = await db.select().from(settings);
    expect(rows).toHaveLength(3);
  });

  test('PUT rejects invalid vision_enabled / model ref values', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    for (const [body, needle] of [
      [{ vision_enabled: 1 }, 'vision_enabled'],
      [{ vision_enabled: 'yes' }, 'vision_enabled'],
      [{ vision_model: 'no-slash-here' }, 'vision_model'],
      [{ vision_model: 42 }, 'vision_model'],
      [{ vision_fallback_model: '/leading-slash' }, 'vision_fallback_model'],
    ] as const) {
      const res = await app.request('/api/v1/settings', {
        method: 'PUT',
        headers: AUTH_HEADERS,
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain(needle);
    }
  });

  test('PUT allows clearing vision model refs with empty string', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const res = await app.request('/api/v1/settings', {
      method: 'PUT',
      headers: AUTH_HEADERS,
      body: JSON.stringify({ vision_model: '' }),
    });
    expect(res.status).toBe(200);
  });
```

- [ ] **Step 3: 运行 settings 测试**

```bash
cd apps/api && bun test routes/settings.test.ts 2>&1 | tail -5
```

Expected: 全部 pass。

### 2b. sessions.ts vision relay

- [ ] **Step 4: imports 与模块级辅助函数**

`apps/api/src/routes/sessions.ts` 顶部 import 修改：

```ts
import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
```

```ts
import { createAuditService, findRoleTemplateByVersion, getSetting, MERGED_USER_MESSAGE_SEPARATOR, startSessionRun } from '@piplus/domain';
```

（`getSetting` 由 Task 1 Step 2 的 domain 导出提供；若并行开发时 Task 1 未合入，先直接从相对路径 `@piplus/domain` 引用即可，最终以 domain index 导出为准——不，直接使用 `@piplus/domain` 导出，Task 1 会保证它存在。）

在 `modelSupportsImageInput` 函数之后追加：

```ts
// ---------- vision relay（实验性：多模态模型识别图片后转发给文本模型） ----------

const VISION_SYSTEM_PROMPT = [
  '你是一个图片识别助手。请结合用户的提示词，尽可能详细、准确地描述图片中的内容，',
  '包括所有可见的文本（逐字转写代码、界面文字、报错信息）、图表、界面元素、布局与关键细节。',
  '你的描述将代替图片交给另一个文本模型继续处理，请确保信息完整、不遗漏重要内容。',
  '只输出描述内容本身，不要客套话。',
].join('');

const VISION_CALL_TIMEOUT_MS = 60_000;

function parseModelRef(raw: string | null): { provider: string; id: string } | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const slashIndex = trimmed.indexOf('/');
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, slashIndex), id: trimmed.slice(slashIndex + 1) };
}

function modelRefLabel(ref: { provider: string; id: string } | null): string {
  return ref ? `${ref.provider}/${ref.id}` : '未配置';
}

/** 用单个多模态模型识别图片；失败抛错（超时/网络/空响应均视为失败）。 */
async function describeImagesWithModel(
  piClient: ReturnType<typeof createPiClient>,
  ref: { provider: string; id: string },
  content: string,
  images: PiImageInput[],
): Promise<string> {
  const result = await piClient.completeModel({
    provider: ref.provider,
    id: ref.id,
    systemPrompt: VISION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: content || '（无文本提示，请直接描述图片内容）', images }],
    signal: AbortSignal.timeout(VISION_CALL_TIMEOUT_MS),
  });
  const text = result.text.trim();
  if (!text) throw new Error('多模态模型返回了空响应');
  return text;
}

/** 主 → 备回退调用；全部失败返回 { ok: false, error }。 */
async function describeImagesWithFallback(
  piClient: ReturnType<typeof createPiClient>,
  primary: { provider: string; id: string },
  fallback: { provider: string; id: string } | null,
  content: string,
  images: PiImageInput[],
): Promise<{ ok: true; description: string } | { ok: false; error: string }> {
  for (const ref of fallback ? [primary, fallback] : [primary]) {
    try {
      const description = await describeImagesWithModel(piClient, ref, content, images);
      return { ok: true, description };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.info('vision relay model failed', { model: modelRefLabel(ref), reason });
    }
  }
  return { ok: false, error: '主备多模态模型均不可用' };
}

/** 图片描述与用户文本合并（描述追加在文本后；纯图片消息仅描述）。 */
function buildVisionMergedContent(content: string, description: string): string {
  const desc = `[图片内容识别]\n${description}`;
  return content ? `${content}\n\n${desc}` : desc;
}

/** 主备都失败：插入 error 历史消息（用户可见），返回用户友好的错误文案。 */
async function insertVisionFailureMessage(
  db: ReturnType<typeof createDb>,
  sessionId: string,
  primary: { provider: string; id: string },
  fallback: { provider: string; id: string } | null,
  reason: string,
) {
  const messageId = randomId('message');
  const now = nextMessageTime();
  await db.insert(messages).values({
    id: messageId,
    sessionId,
    piMessageId: null,
    messageKind: 'error',
    sourceSessionId: null,
    role: 'assistant',
    contentText: `图片识别失败，消息未发送。多模态识别模型（主：${modelRefLabel(primary)}，备：${modelRefLabel(fallback)}）${reason}。你可以稍后重试，或切换到支持图片的模型直接发送。`,
    contentBlocksJson: null,
    contentVersion: 1,
    createdAt: now,
  } as any);
  log.info('vision relay failed, inserted error message', { sessionId, messageId });
}
```

（确认 `log`、`createDb`、`messages`、`nextMessageTime`、`randomId`、`PiImageInput` 均已在文件顶部导入：`log` 来自 `../lib/logger`、`nextMessageTime` 已存在于文件中，`createDb`/`messages` 已导入，`PiImageInput` 已从 `@piplus/pi-client` 导入。若 `nextMessageTime` 定义在文件内部则直接用。）

- [ ] **Step 5: 图片拦截点改造**

`apps/api/src/routes/sessions.ts` POST handler 中：

1. 在 `const content = String(...).trim();` 之后立即保存原始内容（该行现在是 `const content`，保持不变，但后续需要可变变量）：

```ts
    const rawContent = content;
```

2. 将现有拦截点：

```ts
    const currentModel = await resolveSessionModelWithCapabilities(piClient, session);
    if (attachmentParse.images.length > 0 && !modelSupportsImageInput(currentModel)) {
      return c.json({ error: { code: 'MODEL_DOES_NOT_SUPPORT_IMAGES', message: 'Current model does not support image input' } }, 400);
    }
```

替换为：

```ts
    const currentModel = await resolveSessionModelWithCapabilities(piClient, session);
    let effectiveContent = rawContent;
    let effectiveImages = attachmentParse.images;
    if (attachmentParse.images.length > 0 && !modelSupportsImageInput(currentModel)) {
      const visionEnabled = (await getSetting(db, 'vision_enabled')) === 'true';
      const primaryRef = visionEnabled ? parseModelRef(await getSetting(db, 'vision_model')) : null;
      if (primaryRef) {
        const fallbackRef = parseModelRef(await getSetting(db, 'vision_fallback_model'));
        const outcome = await describeImagesWithFallback(piClient, primaryRef, fallbackRef, rawContent, attachmentParse.images);
        if (!outcome.ok) {
          // 主备都失败：插入 error 历史消息，整条消息拒绝（不落库、不发给文本模型）
          await insertVisionFailureMessage(db, sessionId, primaryRef, fallbackRef, outcome.error);
          return c.json({
            error: { code: 'VISION_DESCRIPTION_FAILED', message: '图片识别失败，消息未发送（多模态识别模型不可用）' },
          }, 400);
        }
        // 成功：描述与用户文本合并，图片本身不发给文本模型
        effectiveContent = buildVisionMergedContent(rawContent, outcome.description);
        effectiveImages = [];
      } else {
        // 未开启功能或未配置多模态模型：保持原有拒绝行为
        return c.json({ error: { code: 'MODEL_DOES_NOT_SUPPORT_IMAGES', message: 'Current model does not support image input' } }, 400);
      }
    }
```

3. 落库部分：`contentBlocks` 使用原始文本与原始图片 blocks（历史展示用），`contentText` 用原始文本：

```ts
    const contentBlocks: PiContentBlock[] = [
      ...(rawContent ? [{ type: 'text' as const, text: rawContent }] : []),
      ...attachmentParse.blocks,
    ];
```

（原代码此处为 `content`，替换为 `rawContent`；`contentBlocks` 变量声明位置不变。落库 insert 中的 `contentText: content` 同步改为 `contentText: rawContent`。）

4. `startSessionRun` 调用改为传 `content: effectiveContent` 与 `images: effectiveImages`：

```ts
    const run = await startSessionRun({
      db,
      piClient,
      sessionId,
      userId,
      content: effectiveContent,
      images: effectiveImages,
      startedAt: now,
      ...
```

（其余参数原样保留。）

- [ ] **Step 6: GET /chat/messages 合并 error 消息**

`apps/api/src/routes/sessions.ts` GET 历史路由中，现有：

```ts
      const dbRows = await db.select().from(messages)
        .where(and(eq(messages.sessionId, sessionId), eq(messages.messageKind, 'slash_command')))
        .orderBy(desc(messages.createdAt))
        .limit(20);
```

替换为：

```ts
      const dbRows = await db.select().from(messages)
        .where(and(eq(messages.sessionId, sessionId), inArray(messages.messageKind, ['slash_command', 'error'])))
        .orderBy(desc(messages.createdAt))
        .limit(20);
```

（合并映射代码不变——`messageKind: row.messageKind as any` 已透传 'error'。）

- [ ] **Step 7: sessions.test.ts 新增测试**

`apps/api/src/routes/sessions.test.ts` 中，在现有 `chat messages reject images for models without image support` 测试之后追加两个测试：

```ts
  test('vision relay: both vision models fail → 400 + error history message, user message not stored', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Vision Relay Project', mode: 'existing', path: '/tmp' }),
    });
    const projectBody = await projectRes.json();
    const sessionId = projectBody.sessionId as string;

    // 切换到纯文本模型（无图片支持）
    const modelsRes = await app.request('/api/v1/models', { headers: { 'x-user-id': 'user_seed' } });
    const modelsBody = await modelsRes.json();
    const textOnlyModel = (modelsBody.models as Array<{ provider: string; id: string; input?: string[] }>).find(
      (m) => Array.isArray(m.input) && !m.input.includes('image'),
    );
    if (textOnlyModel) {
      await app.request(`/api/v1/sessions/${sessionId}/model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
        body: JSON.stringify({ provider: textOnlyModel.provider, id: textOnlyModel.id }),
      });
    }

    // 开启 vision relay，主模型指向不存在的模型（保证快速失败，无需真实 API key）
    const settingsRes = await app.request('/api/v1/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({
        vision_enabled: 'true',
        vision_model: 'nonexistent-vision/nonexistent-model',
        vision_fallback_model: 'nonexistent-vision/fallback-model',
      }),
    });
    expect(settingsRes.status).toBe(200);

    const sendRes = await app.request(`/api/v1/sessions/${sessionId}/chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({
        content: 'describe this',
        attachments: [{
          type: 'image',
          mime_type: 'image/png',
          data_base64: Buffer.from('blocked').toString('base64'),
          filename: 'blocked.png',
        }],
      }),
    });
    expect(sendRes.status).toBe(400);
    expect(await sendRes.json()).toMatchObject({ error: { code: 'VISION_DESCRIPTION_FAILED' } });

    // 用户消息不落库
    const db = createDb(`file:${path}`);
    const userRows = await db.select().from(messages).where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'user')));
    expect(userRows).toHaveLength(0);

    // error 历史消息可见
    const histRes = await app.request(`/api/v1/sessions/${sessionId}/chat/messages?limit=50&cursor=0`, {
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
    });
    expect(histRes.status).toBe(200);
    const histBody = await histRes.json();
    const errorMsg = (histBody.messages as Array<{ message_kind: string; content_text: string }>).find((m) => m.message_kind === 'error');
    expect(errorMsg).toBeTruthy();
    expect(errorMsg!.content_text).toContain('图片识别失败');
  });

  test('vision relay: enabled but no vision model keeps MODEL_DOES_NOT_SUPPORT_IMAGES', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Vision Relay Unconfigured', mode: 'existing', path: '/tmp' }),
    });
    const projectBody = await projectRes.json();
    const sessionId = projectBody.sessionId as string;

    // 切换到纯文本模型
    const modelsRes = await app.request('/api/v1/models', { headers: { 'x-user-id': 'user_seed' } });
    const modelsBody = await modelsRes.json();
    const textOnlyModel = (modelsBody.models as Array<{ provider: string; id: string; input?: string[] }>).find(
      (m) => Array.isArray(m.input) && !m.input.includes('image'),
    );
    if (textOnlyModel) {
      await app.request(`/api/v1/sessions/${sessionId}/model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
        body: JSON.stringify({ provider: textOnlyModel.provider, id: textOnlyModel.id }),
      });
    }

    // 开启功能但不配置模型 → 保持原拒绝行为
    const settingsRes = await app.request('/api/v1/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ vision_enabled: 'true' }),
    });
    expect(settingsRes.status).toBe(200);

    const sendRes = await app.request(`/api/v1/sessions/${sessionId}/chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({
        content: 'describe this',
        attachments: [{
          type: 'image',
          mime_type: 'image/png',
          data_base64: Buffer.from('blocked').toString('base64'),
          filename: 'blocked.png',
        }],
      }),
    });
    expect(sendRes.status).toBe(400);
    expect(await sendRes.json()).toMatchObject({ error: { code: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } });
  });
```

- [ ] **Step 8: 运行测试验证**

```bash
cd apps/api && bun test routes/settings.test.ts routes/sessions.test.ts 2>&1 | tail -8
```

Expected: 全部 pass（注意：测试中 `createPiClient()` 真实初始化模型运行时，首次运行稍慢属正常）。若 `nonexistent-vision` provider 触发 `getModel` 之外的缓慢网络路径，确认 `getModel` 对未知 provider 立即返回 undefined（本计划 Task 1 Step 4 已保证）。

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/routes/settings.ts apps/api/src/routes/settings.test.ts apps/api/src/routes/sessions.ts apps/api/src/routes/sessions.test.ts
git commit -m "feat(api): vision relay — describe images via configured multimodal model before forwarding to text model"
```

---

## Task 3: 前端（设置面板 + ChatInput + TabChat + App）

**Files:**
- Modify: `apps/web/src/components/SettingsPanel.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/TabChat.tsx`
- Modify: `apps/web/src/components/ChatInput.tsx`

### 3a. SettingsPanel 实验性卡片

- [ ] **Step 1: import 扩展与状态**

`apps/web/src/components/SettingsPanel.tsx` 中：

- hooks import 增加 `useModels`：

```ts
import { useModels, usePackages, usePackageUpdates, useRoleTemplates, useUpdateRoleTemplateMutation, useCreateRoleTemplateMutation, useDeleteRoleTemplateMutation, useSettings, useUpdateSettingsMutation } from '../lib/hooks';
```

- 在 `subagentTimeoutError` state 之后追加 vision state：

```ts
  const modelsQuery = useModels();
  const visionModels = (modelsQuery.data ?? []).filter((m) => Array.isArray(m.input) && m.input.includes('image'));
  const [visionEnabled, setVisionEnabled] = useState(false);
  const [visionModel, setVisionModel] = useState('');
  const [visionFallbackModel, setVisionFallbackModel] = useState('');
  const [visionTouched, setVisionTouched] = useState(false);
  const [visionSaved, setVisionSaved] = useState(false);
  const [visionError, setVisionError] = useState<string | null>(null);
```

- 在现有 subagentTimeout 同步 useEffect 之后追加（模型列表就绪后初始化一次，仅当用户未触碰）：

```ts
  // Sync vision settings from server when they arrive (only if untouched).
  useEffect(() => {
    if (visionTouched) return;
    setVisionEnabled(settingsQuery.data?.vision_enabled === 'true');
    setVisionModel(settingsQuery.data?.vision_model ?? '');
    setVisionFallbackModel(settingsQuery.data?.vision_fallback_model ?? '');
  }, [settingsQuery.data, visionTouched]);
```

（注意：`useState`/`useEffect` 已在文件中 import——顶部已 import React hooks，确认后直接使用。）

- [ ] **Step 2: 渲染实验性卡片**

在"子代理超时"卡片（`</div>` 收尾后）之后、`{/* 包管理 tab */}` 之前，追加新卡片：

```tsx
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">使用多模态模型识别图片</span>
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-bold text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-950/50 border border-amber-300 dark:border-amber-800">实验性</span>
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                  开启后，非多模态模型会话中发送的图片将由配置的多模态模型识别为文字描述后转发给当前模型（图片本身不发送）。识别失败时消息会被拒绝并显示错误说明。实验性功能，识别质量依赖所选模型。
                </div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer shrink-0">
                <input type="checkbox" className="sr-only peer" checked={visionEnabled} onChange={(e) => { setVisionEnabled(e.target.checked); setVisionTouched(true); setVisionError(null); setVisionSaved(false); }} />
                <div className="w-9 h-5 bg-slate-300 dark:bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
              </label>
            </div>

            {visionEnabled && (
              <div className="space-y-2 pt-1">
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">多模态识别模型（主）</label>
                  <div className="relative" style={{ minWidth: 200 }}>
                    <Select
                      value={visionModel}
                      onChange={(v) => { setVisionModel(v); setVisionTouched(true); setVisionError(null); setVisionSaved(false); }}
                      options={visionModels.map((m) => ({ value: `${m.provider}/${m.id}`, label: `${m.provider} / ${m.label}` }))}
                      placeholder={visionModels.length ? '选择支持图片的模型' : '暂无可用的多模态模型'}
                      searchable
                      dropdownMaxHeight="max-h-72"
                      dropdownMinWidth="260px"
                      className="w-full"
                    />
                  </div>
                  {!visionModel && (
                    <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">必须选择主模型，功能才能生效。</p>
                  )}
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">备选模型（可选）</label>
                  <div className="relative" style={{ minWidth: 200 }}>
                    <Select
                      value={visionFallbackModel}
                      onChange={(v) => { setVisionFallbackModel(v); setVisionTouched(true); setVisionError(null); setVisionSaved(false); }}
                      options={visionModels.map((m) => ({ value: `${m.provider}/${m.id}`, label: `${m.provider} / ${m.label}` }))}
                      placeholder="不启用回退"
                      searchable
                      dropdownMaxHeight="max-h-72"
                      dropdownMinWidth="260px"
                      className="w-full"
                    />
                  </div>
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <button
                    onClick={async () => {
                      setVisionError(null);
                      setVisionSaved(false);
                      try {
                        await updateSettingsMut.mutateAsync({
                          vision_enabled: String(visionEnabled),
                          vision_model: visionModel,
                          vision_fallback_model: visionFallbackModel,
                        });
                        setVisionSaved(true);
                        setVisionTouched(false);
                      } catch (err) {
                        setVisionError(err instanceof Error ? err.message : '保存失败');
                      }
                    }}
                    disabled={!visionModel}
                    className="px-3 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    保存
                  </button>
                  {visionSaved && <span className="text-[11px] text-emerald-600 dark:text-emerald-400">已保存</span>}
                  {visionError && <span className="text-[11px] text-red-600 dark:text-red-400">{visionError}</span>}
                </div>
              </div>
            )}
          </div>
```

（`Select` 组件已在 SettingsPanel 中可用？若未 import，从 `./Select` 引入：`import Select from './Select';`。Select 的 props 参照 `apps/web/src/components/TabChat.tsx` L904 附近用法：`value` / `onChange` / `options` / `searchable` / `dropdownMaxHeight` / `dropdownMinWidth` / `className`，`placeholder` 若 Select 不支持则用空 value 的占位 option 代替。检查 `./Select` 的 props 定义后按实际接口适配。）

### 3b. App.tsx 读取设置并透传

- [ ] **Step 3: App.tsx 修改**

`apps/web/src/App.tsx`：

- hooks import 增加 `useSettings`（App.tsx 已 import 多个 hooks，找到 `useModels,` 所在行加入 `useSettings,`）。
- 在 `const modelsQuery = useModels();` 附近追加：

```ts
  const settingsQuery = useSettings();
  const visionRelayEnabled = settingsQuery.data?.vision_enabled === 'true'
    && !!settingsQuery.data?.vision_model
    && settingsQuery.data.vision_model.includes('/');
```

- 将渲染 TabChat 处（L858 附近 `currentModelSupportsImages={currentModelSupportsImages}`）追加一行 prop：

```tsx
                  visionRelayEnabled={visionRelayEnabled}
```

### 3c. TabChat 透传

- [ ] **Step 4: TabChat props 与透传**

`apps/web/src/components/TabChat.tsx`：

- props 接口（`currentModelSupportsImages?: boolean | null;` 附近）追加：

```ts
  visionRelayEnabled?: boolean;
```

- 解构处（`currentModelSupportsImages,` 附近）追加：

```ts
  visionRelayEnabled,
```

- ChatInput 使用处（L999 附近）追加：

```tsx
        visionRelayEnabled={visionRelayEnabled}
```

### 3d. ChatInput 放行与文案

- [ ] **Step 5: ChatInput 修改**

`apps/web/src/components/ChatInput.tsx`：

- props 接口（`currentModelSupportsImages?: boolean | null;` 之后）追加：

```ts
  visionRelayEnabled?: boolean;
```

- 解构处追加：

```ts
  visionRelayEnabled,
```

- `canSendImages` 计算替换为：

```ts
  const canSendImages = currentModelSupportsImages !== false || visionRelayEnabled === true;
```

- `addImageFiles` 中错误分支文案（`if (!canSendImages)` 分支不再可达，但保留兜底）：

```ts
    if (!canSendImages) {
      setAttachmentError('当前模型不支持图片输入，请先切换到支持图片的模型。');
      return;
    }
```

- 图片按钮 `title` 与图标：当 `currentModelSupportsImages === false && visionRelayEnabled` 时提示走多模态识别：

```tsx
                title={isRunning ? '对话进行中，暂时不能添加图片'
                  : currentModelSupportsImages === false && visionRelayEnabled
                    ? '当前模型不支持图片输入，将通过多模态模型识别图片'
                    : canSendImages ? '添加图片' : '当前模型不支持图片输入'}
```

- 附件存在且 `currentModelSupportsImages === false` 时，在附件区域上方加一行提示（找到附件列表渲染处，通常在 `attachments.length > 0` 分支内加）：

```tsx
          {attachments.length > 0 && currentModelSupportsImages === false && visionRelayEnabled && (
            <div className="text-[11px] text-amber-600 dark:text-amber-400">
              当前模型不支持图片输入，图片将由多模态模型识别为文字描述后发送。
            </div>
          )}
```

- 发送失败错误映射（`catch (error)` 分支，`/does not support image input/i` 分支之后）追加：

```ts
      if (/图片识别失败/i.test(message)) {
        setAttachmentError('图片识别失败，消息未发送（多模态识别模型不可用），请查看会话中的错误说明。');
        return;
      }
```

### 3e. TabChat error 消息渲染

- [ ] **Step 6: TabChat 渲染 error 消息**

`apps/web/src/components/TabChat.tsx` 消息渲染分支中，在 tool 消息分支（`if (isTool)`）**之前**插入 error 分支。找到渲染循环中判断 `isToolCall` 的位置（约 L537），在 `const isToolCall = ...` 之后加：

```ts
          const isErrorKind = msg.message_kind === 'error';
```

并在消息主体渲染处（tool 分支之前的合适位置——参照现有 tool 错误卡片红色样式，`OctagonX` 已在 import 中）插入：

```tsx
          {isErrorKind && (
            <div className="flex gap-2.5 px-4 md:px-5 py-2">
              <div className="flex-1 rounded-xl border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30 p-3 space-y-1">
                <div className="flex items-center gap-1.5 text-xs font-bold text-red-700 dark:text-red-400">
                  <OctagonX className="w-3.5 h-3.5" />
                  系统提示
                </div>
                <div className="text-xs text-red-700 dark:text-red-400 whitespace-pre-wrap">
                  {msg.content_text}
                </div>
              </div>
            </div>
          )}
```

（注意：现有渲染结构是条件链（`if (isToolCall) {...} else if (isTool) {...} else {...}` 或类似），将 `isErrorKind` 分支放在链条最前面，确保 error 消息不落入其他分支。渲染时参照周围消息块的 `gap-2.5 px-4 md:px-5 py-2` 布局。）

- [ ] **Step 7: typecheck 验证**

```bash
cd apps/web && bun run lint 2>&1 | tail -10
```

Expected: 无错误。（`bun run lint` 是 web 的 typecheck 脚本——实际脚本为 `cd apps/web && bun run lint`，即 tsc --noEmit。）

### 3f. Commit

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/SettingsPanel.tsx apps/web/src/App.tsx apps/web/src/components/TabChat.tsx apps/web/src/components/ChatInput.tsx
git commit -m "feat(web): vision relay settings UI, image input allowance and error message rendering"
```

---

## Task 4: 整合验证（feature_lead 执行）

- [ ] **Step 1: 全量 typecheck**

```bash
cd /home/ivhu/.config/piplus/projects/piplus/.worktrees/vision-relay && bun run typecheck
```

Expected: 全部通过（api / web lint / desktop / db / domain / pi-client / shared）。

- [ ] **Step 2: 全量测试**

```bash
bun run test 2>&1 | tail -8
```

Expected: 原 74 pass + 新增测试 pass；已知 pre-existing 失败 1 个（`server config > derives projects root from HOME`，与本次改动无关，主工作区 dev 分支同样失败）。

- [ ] **Step 3: 手动验证清单（dev:api + dev:web）**

1. 设置 → 常规 → 勾选"使用多模态模型识别图片"（显示实验性 badge）→ 主模型选一个多模态模型（下拉只含 input 含 image 的模型）→ 保存
2. 未勾选时：文本模型会话发图片 → 仍 400 拒绝（行为不变）
3. 勾选后：文本模型会话（如 deepseek 纯文本模型）发图片 → 消息发送成功；后端日志可见 vision relay 调用；回复内容能描述图片
4. 历史中用户消息保留图片附件（content_blocks 含 image），模型收到的消息为"用户文本 + [图片内容识别]描述"
5. 主模型配置为不存在/无效模型 → 发图片 → 400 提示 + 会话中出现红色 error 历史消息
6. 备选模型回退：主模型配置为不可用、备选配置为可用 → 发图片 → 走备选成功

---

## 自检记录（Self-Review）

**Spec coverage:**
- 全局设置 3 个新 key：Task 2a（settings.ts 白名单 + 校验）+ Task 3a（UI 开关与下拉）✅
- 实验性标注：Task 3a 橙色 badge ✅
- 多模态模型列表（后端返回 input 含 image）：前端 useModels 过滤（Task 3a）；后端解析能力复用现有 readModelCapabilities（Task 2b 未改动，沿用 resolveSessionModelWithCapabilities）✅
- 备选模型回退：Task 2b describeImagesWithFallback（主→备）✅
- 图片发给多模态模型、输出作为提示词发给文本模型（图片不发送）：Task 2b Step 5（effectiveContent 合并、effectiveImages 清空）✅
- 失败插 error 历史消息 + 整条拒绝：Task 2b insertVisionFailureMessage + 400 VISION_DESCRIPTION_FAILED ✅
- GET /chat/messages 合并 error：Task 2b Step 6 ✅
- 前端 ChatInput 放行 + 提示：Task 3d ✅
- 错误消息渲染：Task 3e ✅
- 未开启时行为不变：Task 2b（else 分支保持 400 MODEL_DOES_NOT_SUPPORT_IMAGES）+ 测试（Task 2b Step 7 第二个测试）✅
- 验证：Task 4 ✅

**Placeholder scan:** 无 TBD/TODO；所有代码块完整。

**Type consistency:**
- `PiCompleteModelInput`/`PiCompleteModelResult`：Task 1 定义，Task 2 消费（completeModel 调用处字段名一致：provider/id/systemPrompt/messages/maxTokens/signal；返回 text/stopReason）✅
- `getSetting(db, key)`：Task 1 Step 2 从 domain 导出，Task 2 Step 4 import ✅
- `messageKind: 'error'`：Task 1 枚举 + Task 2 插入 + Task 3e 渲染，三处一致 ✅
- 设置 key 名 `vision_enabled`/`vision_model`/`vision_fallback_model`：Task 2a 校验、Task 2b 读取、Task 3a 写入、Task 3b 读取，四处一致 ✅
