# 图片附件输入与 Pi SDK 多模态发送实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 Web 聊天增加图片附件输入（文件选择 + 剪贴板粘贴），并通过 Pi SDK 原生图片能力把消息发送给支持图片的模型，同时在历史中回显用户图片缩略图。

**架构：** 前后端统一使用结构化消息块表示用户输入内容：API 接收 `content + attachments`，将文本块和图片块写入本地消息镜像，并把图片映射为 Pi SDK `images` 传给 `session.prompt()`。历史读取继续以 Pi session 文件为主来源，解析 user message 中的 image block，前端基于扩展后的 DTO 渲染缩略图与原图预览。

**技术栈：** React 19、TypeScript、TanStack Query、Hono、Drizzle、Bun、Pi SDK（`@earendil-works/pi-coding-agent`）

---

## 文件结构

### 需要修改的文件
- `packages/shared/src/dto.ts` — 扩展聊天消息 DTO 与图片附件块类型
- `packages/shared/src/index.ts` — 导出新增 DTO 类型
- `packages/pi-client/src/types.ts` — 扩展 `PiHistoryMessage`、`PiClient.sendMessage()`、图片输入类型
- `packages/pi-client/src/history.ts` — 解析 user message 的图片块
- `packages/pi-client/src/client.ts` — 把图片映射给 `session.prompt(text, { images })`
- `apps/api/src/routes/sessions.ts` — 扩展发送接口、模型能力校验、历史响应映射
- `apps/api/src/routes/sessions.test.ts` — API 发送/历史测试
- `apps/web/src/lib/api.ts` — 扩展发送接口参数
- `apps/web/src/lib/hooks.ts` — 扩展发送 mutation 载荷
- `apps/web/src/components/TabChat.tsx` — 图片选择、粘贴、预览、原图查看、发送
- `apps/web/src/App.tsx` — 适配新的发送签名与 optimistic user message 结构

### 可能需要新建的文件
- 无硬性要求；若 `TabChat.tsx` 变更过大，可拆出轻量附件预览子组件，但仅在必要时进行。

---

### 任务 1：共享类型与 pi-client 多模态链路

**文件：**
- 修改：`packages/shared/src/dto.ts`
- 修改：`packages/shared/src/index.ts`
- 修改：`packages/pi-client/src/types.ts`
- 修改：`packages/pi-client/src/history.ts`
- 修改：`packages/pi-client/src/client.ts`
- 测试：如已有相邻测试则补充；否则至少运行相关 typecheck

- [ ] **步骤 1：为共享 DTO 增加图片内容块类型**

```ts
export type ChatMessageImageBlockDTO = {
  type: 'image';
  mime_type: string;
  data_base64: string;
  width?: number;
  height?: number;
  filename?: string | null;
};

export type ChatMessageTextBlockDTO = {
  type: 'text';
  text: string;
};

export type ChatMessageContentBlockDTO = ChatMessageTextBlockDTO | ChatMessageImageBlockDTO;
```

- [ ] **步骤 2：扩展 `ChatMessageDTO` 结构**

```ts
export type ChatMessageDTO = {
  id: string;
  role: keyof typeof MessageRole | 'tool';
  message_kind: keyof typeof MessageKind | 'tool_call' | 'tool';
  source_session_id: string | null;
  content_text: string;
  content_blocks?: ChatMessageContentBlockDTO[] | null;
  created_at: string;
  tool_name?: string | null;
  tool_args_json?: string | null;
};
```

- [ ] **步骤 3：为 pi-client 增加图片输入与历史结构类型**

```ts
export type PiImageInput = {
  mimeType: string;
  dataBase64: string;
  filename?: string | null;
  width?: number;
  height?: number;
};

export type PiHistoryContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; dataBase64: string; filename?: string | null; width?: number; height?: number };
```

- [ ] **步骤 4：扩展 `PiHistoryMessage` 与 `PiClient.sendMessage()` 签名**

```ts
export type PiHistoryMessage = {
  id: string;
  role: PiMessageRole;
  text: string;
  createdAt: string | null;
  contentBlocks?: PiHistoryContentBlock[];
  messageKind?: 'normal' | 'tool_call' | 'tool';
  toolName?: string;
  toolArgs?: Record<string, unknown>;
};

sendMessage(sessionId: string, content: string, images?: PiImageInput[]): Promise<PiRunAccepted>;
```

- [ ] **步骤 5：在 `history.ts` 解析 user message 中的 text/image 块**

```ts
if (msg.role === 'user') {
  const blocks = Array.isArray(msg.content)
    ? msg.content.flatMap((block) => {
        if (block?.type === 'text' && typeof block.text === 'string') return [{ type: 'text' as const, text: block.text }];
        if (block?.type === 'image' && typeof (block as any).mimeType === 'string' && typeof (block as any).data === 'string') {
          return [{ type: 'image' as const, mimeType: (block as any).mimeType, dataBase64: (block as any).data }];
        }
        return [];
      })
    : undefined;

  messages.push({
    id: entry.id,
    role: 'user',
    text: toText(msg.content),
    createdAt: entry.timestamp ?? null,
    contentBlocks: blocks,
  });
}
```

- [ ] **步骤 6：在 `client.ts` 中把图片映射给 Pi SDK**

```ts
async sendMessage(sessionId, content, images) {
  const promptImages = images?.map((image) => ({
    type: 'image' as const,
    source: {
      type: 'base64' as const,
      mediaType: image.mimeType,
      data: image.dataBase64,
    },
  }));

  await session.agentSession.prompt(content, promptImages?.length ? { images: promptImages } : undefined);
}
```

- [ ] **步骤 7：运行相关 typecheck 验证类型闭环**

运行：`cd packages/shared && bun run typecheck && cd ../pi-client && bun run typecheck`
预期：exit 0

- [ ] **步骤 8：Commit**

```bash
git add packages/shared/src/dto.ts packages/shared/src/index.ts packages/pi-client/src/types.ts packages/pi-client/src/history.ts packages/pi-client/src/client.ts
git commit -m "feat: add multimodal message types"
```

### 任务 2：API 接收图片附件、校验模型能力并返回结构化历史

**文件：**
- 修改：`apps/api/src/routes/sessions.ts`
- 修改：`apps/api/src/routes/sessions.test.ts`
- 参考：`apps/api/src/routes/models.ts`

- [ ] **步骤 1：为发送接口定义请求体和校验辅助函数**

```ts
type IncomingImageAttachment = {
  type: 'image';
  mime_type: string;
  data_base64: string;
  width?: number;
  height?: number;
  filename?: string | null;
};

function normalizeImageAttachments(input: unknown): IncomingImageAttachment[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const raw = item as Record<string, unknown>;
    if (raw.type !== 'image') return [];
    const mime_type = String(raw.mime_type ?? '').trim();
    const data_base64 = String(raw.data_base64 ?? '').trim();
    if (!mime_type || !data_base64) return [];
    return [{
      type: 'image',
      mime_type,
      data_base64,
      width: typeof raw.width === 'number' ? raw.width : undefined,
      height: typeof raw.height === 'number' ? raw.height : undefined,
      filename: typeof raw.filename === 'string' ? raw.filename : null,
    }];
  });
}
```

- [ ] **步骤 2：新增模型是否支持图片的后端判断**

```ts
function modelSupportsImageInput(model: { provider?: string | null; id?: string | null }, availableModels: Array<{ provider: string; id: string; input?: string[] }>) {
  const match = availableModels.find((candidate) => candidate.provider === model.provider && candidate.id === model.id);
  return Boolean(match?.input?.includes('image'));
}
```

- [ ] **步骤 3：扩展 POST 接口逻辑**

```ts
const body = await c.req.json().catch(() => ({}));
const content = String((body as { content?: string }).content ?? '');
const attachments = normalizeImageAttachments((body as { attachments?: unknown[] }).attachments);

if (!content.trim() && attachments.length === 0) {
  return c.json({ error: { code: 'EMPTY_MESSAGE', message: 'Message content or image attachment is required' } }, 400);
}
if (attachments.length > 4) {
  return c.json({ error: { code: 'TOO_MANY_ATTACHMENTS', message: 'At most 4 images are allowed' } }, 400);
}
```

- [ ] **步骤 4：有图时校验 MIME 与模型能力**

```ts
const allowedImageMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
if (attachments.some((item) => !allowedImageMimeTypes.has(item.mime_type))) {
  return c.json({ error: { code: 'UNSUPPORTED_IMAGE_TYPE', message: 'Unsupported image type' } }, 400);
}

if (attachments.length > 0) {
  const availableModels = await piClient.listAvailableModels();
  const supportsImages = modelSupportsImageInput(
    { provider: session.currentModelProvider, id: session.currentModelId },
    availableModels as Array<{ provider: string; id: string; input?: string[] }>,
  );
  if (!supportsImages) {
    return c.json({ error: { code: 'MODEL_DOES_NOT_SUPPORT_IMAGES', message: 'Current model does not support image input' } }, 400);
  }
}
```

- [ ] **步骤 5：构造结构化 `contentBlocks` 并写入 DB 镜像**

```ts
const trimmedContent = content.trim();
const contentBlocks = [
  ...(trimmedContent ? [{ type: 'text' as const, text: trimmedContent }] : []),
  ...attachments,
];

await db.insert(messages).values({
  contentText: trimmedContent,
  contentBlocksJson: JSON.stringify(contentBlocks),
  contentVersion: 1,
} as any);
```

- [ ] **步骤 6：调用 `startSessionRun()` 时把图片传给 pi-client**

```ts
const run = await startSessionRun({
  db,
  piClient,
  sessionId,
  userId,
  content: trimmedContent,
  images: attachments.map((image) => ({
    mimeType: image.mime_type,
    dataBase64: image.data_base64,
    filename: image.filename,
    width: image.width,
    height: image.height,
  })),
  startedAt: now,
  ...handlers,
});
```

- [ ] **步骤 7：把历史响应映射为 `content_blocks`**

```ts
messages: pageRows.map((row) => ({
  id: row.id,
  role: row.role,
  message_kind: row.messageKind ?? 'normal',
  source_session_id: null,
  content_text: row.text,
  content_blocks: row.contentBlocks?.map((block) =>
    block.type === 'text'
      ? { type: 'text', text: block.text }
      : { type: 'image', mime_type: block.mimeType, data_base64: block.dataBase64, filename: block.filename ?? null, width: block.width, height: block.height },
  ) ?? null,
  created_at: row.createdAt,
  tool_name: row.toolName ?? null,
  tool_args_json: row.toolArgs ? JSON.stringify(row.toolArgs) : null,
}))
```

- [ ] **步骤 8：为 API 增加回归测试**

```ts
const sendRes = await app.request(`/api/v1/sessions/${sessionId}/chat/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
  body: JSON.stringify({
    content: 'describe image',
    attachments: [{ type: 'image', mime_type: 'image/png', data_base64: 'aGVsbG8=' }],
  }),
});
expect(sendRes.status).toBe(202);
```

- [ ] **步骤 9：运行 API 定向测试**

运行：`cd apps/api && bun test src/routes/sessions.test.ts`
预期：新增图片用例通过，既有会话测试不回归

- [ ] **步骤 10：Commit**

```bash
git add apps/api/src/routes/sessions.ts apps/api/src/routes/sessions.test.ts
git commit -m "feat: accept image attachments in session messages"
```

### 任务 3：Web 聊天输入、预览与历史缩略图渲染

**文件：**
- 修改：`apps/web/src/lib/api.ts`
- 修改：`apps/web/src/lib/hooks.ts`
- 修改：`apps/web/src/App.tsx`
- 修改：`apps/web/src/components/TabChat.tsx`

- [ ] **步骤 1：扩展 Web API 发送类型**

```ts
export type SessionImageAttachmentInput = {
  type: 'image';
  mime_type: string;
  data_base64: string;
  width?: number;
  height?: number;
  filename?: string | null;
};

export function sendSessionMessage(sessionId: string, payload: { content: string; attachments?: SessionImageAttachmentInput[] }) {
  return request<{ accepted: boolean; session_id: string; run_id: string; message_id: string }>(
    `/api/v1/sessions/${sessionId}/chat/messages`,
    { method: 'POST', body: JSON.stringify(payload) },
  );
}
```

- [ ] **步骤 2：扩展 `useSendMessageMutation()` 与 App 的发送签名**

```ts
mutationFn: (payload: { content: string; attachments?: SessionImageAttachmentInput[] }) => sendSessionMessage(sessionId!, payload)
```

```ts
const handleSend = useCallback(async (payload: { content: string; attachments?: SessionImageAttachmentInput[] }) => {
  // optimistic message should carry content_blocks when attachments exist
}, [selectedSessionId, sendMessageMut, queryClient]);
```

- [ ] **步骤 3：在 `TabChat` 中增加附件本地状态**

```ts
const [attachments, setAttachments] = useState<SessionImageAttachmentInput[]>([]);
const fileInputRef = useRef<HTMLInputElement>(null);
const maxImages = 4;
```

- [ ] **步骤 4：实现文件选择与 base64 读取**

```ts
async function fileToImageAttachment(file: File): Promise<SessionImageAttachmentInput> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('read_failed'));
    reader.readAsDataURL(file);
  });
  const [, mimeType = '', dataBase64 = ''] = dataUrl.match(/^data:(.*?);base64,(.*)$/) ?? [];
  return { type: 'image', mime_type: mimeType, data_base64: dataBase64, filename: file.name };
}
```

- [ ] **步骤 5：实现粘贴监听**

```ts
onPaste={async (e) => {
  const files = Array.from(e.clipboardData?.items ?? [])
    .filter((item) => item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  if (files.length === 0) return;
  e.preventDefault();
  const next = await Promise.all(files.map(fileToImageAttachment));
  setAttachments((prev) => [...prev, ...next].slice(0, maxImages));
}}
```

- [ ] **步骤 6：发送前模型能力与空消息校验**

```ts
const supportsImages = currentModelValue
  ? Boolean(models?.find((m) => `${m.provider}/${m.id}` === currentModelValue))
  : true;

if (attachments.length > 0 && !selectedModelSupportsImages) {
  // surface inline error / disable submit
  return;
}
if (!draft.trim() && attachments.length === 0) return;
```

- [ ] **步骤 7：渲染输入区附件预览与历史消息缩略图**

```tsx
{attachments.length > 0 && (
  <div className="flex gap-2 flex-wrap">
    {attachments.map((image, index) => (
      <button key={`${image.filename ?? 'pasted'}-${index}`} type="button">
        <img src={`data:${image.mime_type};base64,${image.data_base64}`} alt={image.filename ?? 'attachment'} />
      </button>
    ))}
  </div>
)}
```

```tsx
const imageBlocks = msg.content_blocks?.filter((block) => block.type === 'image') ?? [];
```

- [ ] **步骤 8：点击缩略图时复用 `Modal` 预览原图**

```tsx
<Modal open={Boolean(previewImage)} onClose={() => setPreviewImage(null)}>
  {previewImage ? <img src={`data:${previewImage.mime_type};base64,${previewImage.data_base64}`} alt={previewImage.filename ?? 'preview'} /> : null}
</Modal>
```

- [ ] **步骤 9：发送成功后清空草稿与附件**

```ts
setDraft('');
setAttachments([]);
await onSend({ content, attachments });
```

- [ ] **步骤 10：运行 Web typecheck**

运行：`cd apps/web && bun run lint`
预期：exit 0

- [ ] **步骤 11：Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/hooks.ts apps/web/src/App.tsx apps/web/src/components/TabChat.tsx
git commit -m "feat: add chat image attachments ui"
```

### 任务 4：端到端验证与收尾

**文件：**
- 修改：如前 3 个任务所涉及文件
- 测试：`apps/api`, `apps/web`, 必要时仓库级 typecheck

- [ ] **步骤 1：运行 API 测试**

运行：`cd apps/api && bun test`
预期：所有 API 测试通过

- [ ] **步骤 2：运行 Web 类型检查**

运行：`cd apps/web && bun run lint`
预期：exit 0

- [ ] **步骤 3：运行相关包类型检查**

运行：`cd packages/shared && bun run typecheck && cd ../pi-client && bun run typecheck`
预期：exit 0

- [ ] **步骤 4：核对需求清单**

运行：`rg -n "input.*image|attachments|content_blocks|onPaste|fileToImageAttachment|MODEL_DOES_NOT_SUPPORT_IMAGES" apps/web apps/api packages/shared packages/pi-client -S`
预期：能定位到文件选择、粘贴、后端校验、SDK 图片发送、历史结构回显的实现证据

- [ ] **步骤 5：Commit**

```bash
git add apps/web apps/api packages/shared packages/pi-client
git commit -m "test: verify image attachment flow"
```
