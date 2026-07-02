import type { Hono } from 'hono';
import { createDb } from '@piplus/db/client';
import { messages, projects, roleTemplates, sessionEvents, sessionSyncStates, sessions } from '@piplus/db/schema';
import { and, desc, eq, lt, or } from 'drizzle-orm';
import { createPiClient } from '@piplus/pi-client';
import type { PiContentBlock, PiImageInput, PiModelInfo } from '@piplus/pi-client';
import { parseLocator } from '@piplus/pi-client/locator';
import { getDbPath } from '../db-context';
import { registerWebSocketRoutes, socketHub } from '../ws/server';
import { createEvent } from '../ws/protocol';
import { mapPiStreamEventToFrames } from '../lib/pi-stream-bridge';
import { createLogger } from '../lib/logger';
import { createAuditService, startSessionRun } from '@piplus/domain';
import { execSync } from 'node:child_process';
import { readdir, readFile, appendFile, access, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

function getPiplusModelsFilePath() {
  const configDir = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, 'piplus')
    : path.join(process.env.HOME || homedir(), '.config', 'piplus');
  return path.join(configDir, 'piplus-models.json');
}

function getPiModelsFilePath() {
  return path.join(process.env.HOME || homedir(), '.pi', 'agent', 'models.json');
}

function randomId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
}

type MessageCursor = {
  created_at: string;
  id: string;
};

function encodeCursor(row: { createdAt: Date; id: string }) {
  const payload: MessageCursor = { created_at: row.createdAt.toISOString(), id: row.id };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeCursor(raw: string): MessageCursor | null {
  try {
    const payload = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<MessageCursor>;
    if (typeof payload.created_at === 'string' && typeof payload.id === 'string') return { created_at: payload.created_at, id: payload.id };
  } catch {
    return null;
  }
  return null;
}

let messageSequence = 0;
function nextMessageTime() {
  messageSequence += 1;
  return new Date(Date.now() + messageSequence);
}

const log = createLogger('routes.sessions');
const MAX_CHAT_IMAGE_ATTACHMENTS = 4;
const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_FILE_TREE_DEPTH = 6;
const MAX_FILE_CONTENT_BYTES = 1024 * 1024;
const MAX_FILE_WRITE_BYTES = 1024 * 1024;
const TEXT_FILE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.txt', '.css', '.scss', '.sass', '.less', '.html', '.htm', '.mdx', '.jsonc', '.postcss',
  '.yml', '.yaml', '.xml', '.svg', '.sh', '.bash', '.zsh', '.env', '.toml', '.ini', '.conf', '.config', '.sql', '.py', '.rb', '.pyi', '.kts', '.scala', '.zig', '.dart', '.lua', '.r', '.jl', '.ex', '.exs', '.erl', '.hrl', '.clj', '.cljs', '.graphql', '.gql', '.proto',
  '.rs', '.go', '.java', '.kt', '.swift', '.php', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.vue', '.svelte', '.astro', '.sol', '.vy', '.move', '.cairo', '.abi',
  '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.prettierignore', '.prettierrc', '.eslintrc', '.eslintignore', '.dockerignore', '.env.example', '.nvmrc', '.babelrc',
  '.fish', '.ps1', '.bat', '.cmd',
]);
const IGNORED_ENTRY_NAMES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.turbo', 'coverage']);

function isTextFilePath(filePath: string) {
  const baseName = path.basename(filePath).toLowerCase();
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_FILE_EXTENSIONS.has(baseName) || TEXT_FILE_EXTENSIONS.has(ext) || !path.basename(filePath).includes('.');
}

function looksLikeBinary(buffer: Buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) return true;

  let suspiciousBytes = 0;
  for (const byte of sample) {
    const isPrintableAscii = byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126);
    const isCommonUtf8LeadOrContinuation = byte >= 128;
    if (!isPrintableAscii && !isCommonUtf8LeadOrContinuation) {
      suspiciousBytes += 1;
    }
  }

  return sample.length > 0 && suspiciousBytes / sample.length > 0.1;
}

type ChatImageAttachmentInput = {
  type?: string;
  mime_type?: string;
  data_base64?: string;
  filename?: string | null;
};

function normalizeImageAttachments(raw: unknown) {
  if (raw == null) return [] as ChatImageAttachmentInput[];
  if (!Array.isArray(raw)) throw new Error('invalid_attachments');
  return raw as ChatImageAttachmentInput[];
}

function parseImageAttachments(raw: unknown) {
  const attachments = normalizeImageAttachments(raw);
  if (attachments.length > MAX_CHAT_IMAGE_ATTACHMENTS) {
    return { error: { code: 'TOO_MANY_ATTACHMENTS', message: `At most ${MAX_CHAT_IMAGE_ATTACHMENTS} images are allowed` }, status: 400 as const };
  }

  const images: PiImageInput[] = [];
  const blocks: PiContentBlock[] = [];
  for (const attachment of attachments) {
    if (attachment?.type !== 'image') {
      return { error: { code: 'INVALID_ATTACHMENT_TYPE', message: 'Only image attachments are supported' }, status: 400 as const };
    }

    const mimeType = String(attachment.mime_type ?? '').trim().toLowerCase();
    if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
      return { error: { code: 'UNSUPPORTED_IMAGE_MIME_TYPE', message: 'Unsupported image MIME type' }, status: 400 as const };
    }

    const data = String(attachment.data_base64 ?? '').trim();
    if (!data) {
      return { error: { code: 'INVALID_IMAGE_DATA', message: 'Image data is required' }, status: 400 as const };
    }

    try {
      const buffer = Buffer.from(data, 'base64');
      if (!buffer.byteLength || buffer.toString('base64') !== data.replace(/\s+/g, '')) {
        return { error: { code: 'INVALID_IMAGE_DATA', message: 'Image data must be valid base64' }, status: 400 as const };
      }
    } catch {
      return { error: { code: 'INVALID_IMAGE_DATA', message: 'Image data must be valid base64' }, status: 400 as const };
    }

    const filename = typeof attachment.filename === 'string' && attachment.filename.trim() ? attachment.filename.trim() : null;
    images.push({ dataBase64: data, mimeType, mediaType: mimeType, filename: filename ?? undefined });
    blocks.push({ type: 'image', mimeType, mediaType: mimeType, filename, uri: null, dataBase64: data });
  }

  return { images, blocks };
}

async function readModelCapabilitiesFromFile(filePath: string, provider: string, id: string) {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as {
      providers?: Record<string, { models?: Array<{ id?: string; input?: string[] }> }>;
    };
    const models = parsed.providers?.[provider]?.models;
    const matched = models?.find((candidate) => candidate.id === id);
    return matched?.input;
  } catch {
    return undefined;
  }
}

async function readModelCapabilities(provider: string, id: string) {
  const piplusInput = await readModelCapabilitiesFromFile(getPiplusModelsFilePath(), provider, id);
  if (piplusInput) return piplusInput;
  return readModelCapabilitiesFromFile(getPiModelsFilePath(), provider, id);
}

async function resolveSessionModelWithCapabilities(piClient: ReturnType<typeof createPiClient>, session: typeof sessions.$inferSelect) {
  const runtimeModel = await piClient.getCurrentModel(session.id);
  const model = runtimeModel ?? (session.currentModelProvider && session.currentModelId
    ? { provider: session.currentModelProvider, id: session.currentModelId, label: session.currentModelId }
    : null);
  if (!model) return null;

  const availableModels = await piClient.listAvailableModels();
  const matched = availableModels.find((candidate: any) => candidate.provider === model.provider && candidate.id === model.id) as (PiModelInfo & { input?: string[] }) | undefined;
  const input = matched?.input ?? await readModelCapabilities(model.provider, model.id);
  return input ? { ...model, input } : (matched ?? model);
}

function modelSupportsImageInput(model: (PiModelInfo & { input?: string[] }) | null) {
  return Array.isArray(model?.input) && model!.input.includes('image');
}

async function buildFileTree(rootPath: string, relativePath = '', depth = 0): Promise<Array<{ name: string; path: string; kind: 'file' | 'directory'; children?: any[] }>> {
  if (depth > MAX_FILE_TREE_DEPTH) return [];
  const absoluteDir = relativePath ? path.join(rootPath, relativePath) : rootPath;
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const visible = entries
    .filter((entry) => !IGNORED_ENTRY_NAMES.has(entry.name) && !entry.name.startsWith('.DS_Store'))
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

  const nodes = await Promise.all(visible.map(async (entry) => {
    const entryRelativePath = relativePath ? path.posix.join(relativePath, entry.name) : entry.name;
    if (entry.isDirectory()) {
      return {
        name: entry.name,
        path: entryRelativePath,
        kind: 'directory' as const,
        children: await buildFileTree(rootPath, entryRelativePath, depth + 1),
      };
    }
    return {
      name: entry.name,
      path: entryRelativePath,
      kind: 'file' as const,
    };
  }));

  return nodes;
}

export function registerSessionRoutes(app: Hono) {
  const piClient = createPiClient();

  /**
   * @swagger
   * /api/v1/sessions/{sessionId}/info:
   *   get:
   *     summary: 获取会话聚合详情
   *     tags: [Sessions]
   *     security:
   *       - bearerAuth: []
   *     description: 返回会话、项目、血缘、角色模板、提示词快照、同步状态和最近事件。
   *     responses:
   *       200:
   *         description: 查询成功。
   *       404:
   *         description: 会话不存在或无访问权限。
   */
  app.get('/api/v1/sessions/:sessionId/info', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);

    if (!session) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const [project] = await db.select({ id: projects.id, name: projects.name, createdBy: projects.createdBy, projectPath: projects.projectPath }).from(projects).where(eq(projects.id, session.projectId)).limit(1);
    if (!project || project.createdBy !== userId) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const [rt] = await db.select({ key: roleTemplates.key, version: roleTemplates.version, name: roleTemplates.name })
      .from(roleTemplates).where(eq(roleTemplates.id, session.roleTemplateId)).limit(1);

    const [parent] = await db.select({ id: sessions.id, title: sessions.title }).from(sessions).where(eq(sessions.id, session.parentSessionId ?? '')).limit(1);
    const [root] = await db.select({ id: sessions.id, title: sessions.title }).from(sessions).where(eq(sessions.id, session.rootSessionId)).limit(1);
    const [sync] = await db.select().from(sessionSyncStates).where(eq(sessionSyncStates.sessionId, sessionId)).limit(1);

    const events = await db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, sessionId)).orderBy(desc(sessionEvents.createdAt)).limit(20);

    const runtimeModel = await piClient.getCurrentModel(sessionId);
    const currentModel = runtimeModel ?? (() => {
      if (!session.currentModelProvider || !session.currentModelId) return null;
      // 尝试从可用模型列表中查找 label（如 "DeepSeek V4 Pro"），
      // 如果找不到就用 id 作为 label，避免出现 "deepseek/deepseek-v4-pro" 这种拼接
      const label = session.currentModelId;
      return { provider: session.currentModelProvider, id: session.currentModelId, label };
    })();

    return c.json({
      session: {
        id: session.id,
        title: session.title,
        project_id: session.projectId,
        parent_session_id: session.parentSessionId,
        root_session_id: session.rootSessionId,
        created_by: session.createdBy,
        created_at: new Date(session.createdAt).toISOString(),
        archived_at: session.archivedAt ? new Date(session.archivedAt).toISOString() : null,
        pi_session_id: session.piSessionId,
        pi_session_locator_json: session.piSessionLocatorJson,
        status: session.status,
        runtime_status: session.runtimeStatus,
        current_model: currentModel,
      },
      project: project
        ? { id: project.id, name: project.name }
        : { id: session.projectId, name: 'Unknown project' },
      lineage: {
        parent_session: parent ? { id: parent.id, title: parent.title } : null,
        root_session: root ? { id: root.id, title: root.title } : null,
        depth: session.depth,
      },
      role_template: rt ? { key: rt.key, version: rt.version, name: rt.name } : { key: 'unknown', version: '0', name: 'Unknown' },
      prompts: {
        role_base_prompt_snapshot: session.roleBasePromptSnapshot,
        user_supplied_prompt: session.userSuppliedPrompt,
        parent_supplied_prompt: session.parentSuppliedPrompt,
        compiled_prompt: session.compiledPrompt,
      },
      sync: {
        sync_status: sync?.syncStatus ?? 'idle',
        last_synced_at: sync?.lastSyncedAt ? new Date(sync.lastSyncedAt).toISOString() : null,
        last_pi_message_id: sync?.lastPiMessageId ?? null,
        last_error: sync?.lastError ?? null,
        retry_count: sync?.retryCount ?? 0,
      },
      recent_events: events.map((e) => ({
        id: e.id,
        type: e.type,
        payload: e.payload,
        created_at: new Date(e.createdAt).toISOString(),
      })),
    });
  });

  /**
   * @swagger
   * /api/v1/sessions/{sessionId}/planner-role-prompt:
   *   get:
   *     summary: 获取顶层 planner 的角色系统提示词
   *     tags: [Sessions]
   *     security:
   *       - bearerAuth: []
   *     description: 仅顶层 planner 且 idle 可用，返回当前会话保存的 compiled planner prompt，供前端作为普通用户消息再次发送。
   *     responses:
   *       200:
   *         description: 查询成功。
   *       400:
   *         description: 非顶层 planner 或会话繁忙。
   *       404:
   *         description: 会话不存在或无访问权限。
   */
  app.get('/api/v1/sessions/:sessionId/planner-role-prompt', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!session) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const [project] = await db.select({ id: projects.id, createdBy: projects.createdBy }).from(projects).where(eq(projects.id, session.projectId)).limit(1);
    if (!project || project.createdBy !== userId) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const [template] = await db.select({ key: roleTemplates.key }).from(roleTemplates).where(eq(roleTemplates.id, session.roleTemplateId)).limit(1);
    if (!template || template.key !== 'planner' || session.depth !== 0) {
      return c.json({ error: { code: 'NOT_PLANNER_ROOT', message: 'Only top-level planner sessions are supported' } }, 400);
    }

    if (session.runtimeStatus !== 'idle') {
      return c.json({ error: { code: 'SESSION_BUSY', message: 'Session is currently busy' } }, 409);
    }

    return c.json({
      session_id: sessionId,
      prompt: session.compiledPrompt,
      prompt_length: session.compiledPrompt.length,
    });
  });

  /**
   * @swagger
   * /api/v1/sessions/{sessionId}/chat/messages:
   *   get:
   *     summary: 获取会话消息历史
   *     tags: [Sessions, Chat]
   *     security:
   *       - bearerAuth: []
   *     description: 从 Pi 会话历史中按游标分页读取消息。
   *     responses:
   *       200:
   *         description: 查询成功。
   *       404:
   *         description: 会话不存在或无访问权限。
   */
  app.get('/api/v1/sessions/:sessionId/chat/messages', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!session) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const [project] = await db.select({ id: projects.id, createdBy: projects.createdBy, projectPath: projects.projectPath }).from(projects).where(eq(projects.id, session.projectId)).limit(1);
    if (!project || project.createdBy !== userId) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const limit = Math.min(Number(c.req.query('limit') ?? '50') || 50, 100);
    const cursor = c.req.query('cursor');
    const piPage = await piClient.getHistory(sessionId, parseLocator(session.piSessionLocatorJson), cursor ?? null, limit);
    const pageRows = piPage.messages;

    return c.json({
      session_id: sessionId,
      cursor: cursor ?? null,
      next_cursor: piPage.nextCursor,
      messages: pageRows.map((row: typeof pageRows[number]) => ({
        id: row.id,
        role: row.role,
        message_kind: row.messageKind ?? 'normal',
        source_session_id: null,
        content_text: row.text,
        content_blocks: row.contentBlocks?.map((block) => block.type === 'text'
          ? { type: 'text' as const, text: block.text }
          : {
              type: 'image' as const,
              mime_type: block.mimeType,
              media_type: block.mediaType,
              filename: block.filename,
              uri: block.uri,
              data_base64: block.dataBase64,
            }) ?? null,
        created_at: row.createdAt,
        tool_name: row.toolName ?? null,
        tool_args_json: row.toolArgs ? JSON.stringify(row.toolArgs) : null,
      })),
    });
  });

  /**
   * @swagger
   * /api/v1/sessions/{sessionId}/chat/messages:
   *   post:
   *     summary: 发送会话消息
   *     tags: [Sessions, Chat]
   *     security:
   *       - bearerAuth: []
   *     description: 受理用户消息并异步启动 LLM；生成结果通过 WebSocket chat_stream 推送。
   *     responses:
   *       202:
   *         description: 已受理，返回 run_id 与 message_id。
   *       400:
   *         description: 消息内容为空。
   *       409:
   *         description: 会话繁忙。
   */
  app.post('/api/v1/sessions/:sessionId/chat/messages', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const body = await c.req.json().catch(() => ({}));
    const content = String((body as { content?: string }).content ?? '').trim();
    let attachmentParse: ReturnType<typeof parseImageAttachments>;
    try {
      attachmentParse = parseImageAttachments((body as { attachments?: unknown }).attachments);
    } catch {
      return c.json({ error: { code: 'INVALID_ATTACHMENTS', message: 'Attachments must be an array' } }, 400);
    }
    if ('error' in attachmentParse) {
      return c.json({ error: attachmentParse.error }, attachmentParse.status);
    }

    if (!content && attachmentParse.images.length === 0) {
      return c.json({ error: { code: 'EMPTY_MESSAGE', message: 'Message content or image attachment is required' } }, 400);
    }

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!session) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const [project] = await db.select({ id: projects.id, createdBy: projects.createdBy, projectPath: projects.projectPath }).from(projects).where(eq(projects.id, session.projectId)).limit(1);
    if (!project || project.createdBy !== userId) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    if (session.runtimeStatus === 'running' || session.runtimeStatus === 'stopping') {
      return c.json({ error: { code: 'SESSION_BUSY', message: 'Session is currently busy' } }, 409);
    }

    const currentModel = await resolveSessionModelWithCapabilities(piClient, session);
    if (attachmentParse.images.length > 0 && !modelSupportsImageInput(currentModel)) {
      return c.json({ error: { code: 'MODEL_DOES_NOT_SUPPORT_IMAGES', message: 'Current model does not support image input' } }, 400);
    }

    const contentBlocks: PiContentBlock[] = [
      ...(content ? [{ type: 'text' as const, text: content }] : []),
      ...attachmentParse.blocks,
    ];

    const now = nextMessageTime();
    const messageId = randomId('message');
    await db.insert(messages).values({
      id: messageId,
      sessionId,
      piMessageId: null,
      messageKind: 'normal',
      sourceSessionId: null,
      role: 'user',
      contentText: content,
      contentBlocksJson: contentBlocks.length ? JSON.stringify(contentBlocks) : null,
      contentVersion: contentBlocks.length ? 2 : 1,
      createdAt: now,
    } as any);

    log.info('message sent', { sessionId, messageId });
    await createAuditService(db).record(userId, "message.sent", "session", sessionId, { message_id: messageId });

    await db.insert(sessionEvents).values({
      id: randomId('event'),
      sessionId,
      type: 'chat_message_received',
      payload: JSON.stringify({ message_id: messageId }),
      parentMessageId: null,
      sequence: 1,
      createdAt: now,
    } as any);

    const run = await startSessionRun({
      db,
      piClient,
      sessionId,
      userId,
      content,
      images: attachmentParse.images,
      startedAt: now,
      onStreamEvent: async (event) => {
        for (const frame of mapPiStreamEventToFrames(sessionId, event)) {
          socketHub.sendToSession(sessionId, frame);
        }
      },
      onRuntimeStatusChange: async ({ projectId, runtimeStatus, error }) => {
        socketHub.sendToSession(sessionId, createEvent('session.runtime_status_changed', { runtime_status: runtimeStatus, error }, { project_id: projectId, session_id: sessionId }));
      },
      onToolSessionCreated: async ({ sessionId: childSessionId, projectId }) => {
        socketHub.broadcast(createEvent('session.created', { session_id: childSessionId }, { project_id: projectId, session_id: childSessionId }));
        socketHub.broadcast(createEvent('tree.changed', { project_id: projectId }, { project_id: projectId }));
      },
    });

    socketHub.broadcast(createEvent('session.updated', { session_id: sessionId }, { project_id: session.projectId, session_id: sessionId }));
    socketHub.broadcast(createEvent('tree.changed', { project_id: session.projectId }, { project_id: session.projectId }));

    return c.json({ accepted: true, session_id: sessionId, run_id: run.runId, message_id: messageId }, 202);
  });

  /**
   * @swagger
   * /api/v1/sessions/{sessionId}/model:
   *   post:
   *     summary: 设置会话模型
   *     tags: [Sessions, Models]
   *     security:
   *       - bearerAuth: []
   *     description: 仅允许在会话 idle 时切换模型。
   *     responses:
   *       200:
   *         description: 设置成功。
   *       404:
   *         description: 会话不存在或模型不存在。
   *       409:
   *         description: 会话繁忙。
   */
  app.post('/api/v1/sessions/:sessionId/model', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const userId = (c as any).get('userId') as string;
    const body = await c.req.json().catch(() => ({}));
    const provider = String((body as { provider?: string }).provider ?? '');
    const id = String((body as { id?: string }).id ?? '');

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!session) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const [project] = await db.select({ id: projects.id, createdBy: projects.createdBy, projectPath: projects.projectPath }).from(projects).where(eq(projects.id, session.projectId)).limit(1);
    if (!project || project.createdBy !== userId) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    if (session.runtimeStatus === 'running') {
      return c.json({ error: { code: 'SESSION_BUSY', message: 'Session is currently busy' } }, 409);
    }

    const locator = parseLocator(session.piSessionLocatorJson);
    try {
      const model = await piClient.setSessionModel(sessionId, locator, { provider, id }, project.projectPath);
      // Persist to DB so the model survives server restart.
      await db.update(sessions).set({
        currentModelProvider: model.provider,
        currentModelId: model.id,
        updatedAt: new Date(),
      }).where(eq(sessions.id, sessionId));
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

  /**
   * @swagger
   * /api/v1/sessions/{sessionId}/stop:
   *   post:
   *     summary: 停止会话运行
   *     tags: [Sessions]
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       202:
   *         description: 已进入 stopping 状态。
   *       404:
   *         description: 会话不存在或无访问权限。
   */
  app.post('/api/v1/sessions/:sessionId/stop', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!session) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const [project] = await db.select({ id: projects.id, createdBy: projects.createdBy, projectPath: projects.projectPath }).from(projects).where(eq(projects.id, session.projectId)).limit(1);
    if (!project || project.createdBy !== userId) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    try {
      await piClient.stopSession(sessionId);
    } catch (err) {
      log.warn('session stop triggered with error (continue to respond 202)', { sessionId, error: String(err) });
    }
    log.info('session stopping', { sessionId });
    await createAuditService(db).record(userId, "session.stopped", "session", sessionId);

    const now = nextMessageTime();
    await db.update(sessions).set({ runtimeStatus: 'stopping', lastStopAt: now, updatedAt: now }).where(eq(sessions.id, sessionId));
    socketHub.sendToSession(sessionId, createEvent('session.runtime_status_changed', { runtime_status: 'stopping' }, { project_id: session.projectId, session_id: sessionId }));
    return c.json({ session_id: sessionId, status: 'stopping' }, 202);
  });

  /**
   * @swagger
   * /api/v1/sessions/{sessionId}/archive:
   *   post:
   *     summary: 归档会话
   *     tags: [Sessions]
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: 归档成功。
   *       404:
   *         description: 会话不存在或无访问权限。
   */
  app.post('/api/v1/sessions/:sessionId/archive', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const userId = (c as any).get('userId') as string;
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!session) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const [project] = await db.select({ id: projects.id, createdBy: projects.createdBy, projectPath: projects.projectPath }).from(projects).where(eq(projects.id, session.projectId)).limit(1);
    if (!project || project.createdBy !== userId) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const now = nextMessageTime();
    await db.update(sessions).set({ status: 'archived', archivedAt: now, archivedBy: userId, updatedAt: now }).where(eq(sessions.id, sessionId));
    log.info('session archived', { sessionId });
    await createAuditService(db).record(userId, "session.archived", "session", sessionId);
    socketHub.broadcast(createEvent('session.archived', { session_id: sessionId }, { project_id: session.projectId, session_id: sessionId }));
    socketHub.broadcast(createEvent('tree.changed', { project_id: session.projectId }, { project_id: session.projectId }));
    return c.json({ session_id: sessionId, status: 'archived' }, 200);
  });

  /**
   * @swagger
   * /api/v1/sessions/{sessionId}/git-diff:
   *   get:
   *     summary: 获取会话所属项目的 Git Diff
   *     tags: [Sessions, Git]
   *     security:
   *       - bearerAuth: []
   *     description: 在会话所属项目目录执行 git diff，并返回当前工作区差异文本。
   *     responses:
   *       200:
   *         description: 查询成功。
   *       404:
   *         description: 会话不存在或无访问权限。
   */
  function resolveProjectDir(c: any, userId: string, sessionId: string) {
    const db = createDb(`file:${getDbPath()}`);
    const [session] = db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1).all();
    if (!session) return { error: { code: 'NOT_FOUND', message: 'Session not found' }, status: 404 } as const;

    const [project] = db.select({ projectPath: projects.projectPath, createdBy: projects.createdBy }).from(projects).where(eq(projects.id, session.projectId)).limit(1).all();
    if (!project || project.createdBy !== userId) return { error: { code: 'NOT_FOUND', message: 'Session not found' }, status: 404 } as const;

    return { cwd: project.projectPath || process.cwd() };
  }

  function resolveSafeFilePath(rootDir: string, relativePath: string) {
    const normalized = relativePath.replace(/\\/g, '/');
    const resolved = path.resolve(rootDir, normalized);
    const relative = path.relative(rootDir, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return null;
    }
    return resolved;
  }

  async function buildFileTree(
    rootDir: string,
    currentDir = rootDir,
  ): Promise<Array<{ name: string; path: string; kind: 'file' | 'directory'; children?: any[] }>> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    const visibleEntries = entries
      .filter((entry) => entry.name !== '.git' && entry.name !== 'node_modules')
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    return Promise.all(visibleEntries.map(async (entry) => {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = path.relative(rootDir, absolutePath).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        return {
          name: entry.name,
          path: relativePath,
          kind: 'directory' as const,
          children: await buildFileTree(rootDir, absolutePath),
        };
      }
      return {
        name: entry.name,
        path: relativePath,
        kind: 'file' as const,
      };
    }));
  }

  function execGit(cwd: string, ...args: string[]) {
    const stdout = execSync(`git ${args.join(' ')}`, { cwd, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }).toString();
    return stdout;
  }

  app.get('/api/v1/sessions/:sessionId/files/tree', async (c) => {
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const resolved = resolveProjectDir(c, userId, sessionId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const cwd = resolved.cwd;

    const tree = await buildFileTree(cwd);
    return c.json({ session_id: sessionId, root_path: cwd, tree });
  });

  app.get('/api/v1/sessions/:sessionId/files/content', async (c) => {
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const relativePath = String(c.req.query('path') ?? '').trim();
    if (!relativePath) {
      return c.json({ error: { code: 'INVALID_PATH', message: 'File path is required' } }, 400);
    }

    const resolved = resolveProjectDir(c, userId, sessionId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const cwd = resolved.cwd;
    const absolutePath = path.resolve(cwd, relativePath);
    const relativeToRoot = path.relative(cwd, absolutePath);
    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
      return c.json({ error: { code: 'INVALID_PATH', message: 'Path is outside project root' } }, 400);
    }
    if (!isTextFilePath(absolutePath)) {
      return c.json({ error: { code: 'UNSUPPORTED_FILE', message: 'Only text file preview is supported' } }, 400);
    }

    const buffer = await readFile(absolutePath);
    if (looksLikeBinary(buffer)) {
      return c.json({ error: { code: 'UNSUPPORTED_FILE', message: 'Binary file preview is not supported' } }, 400);
    }

    const truncated = buffer.byteLength > MAX_FILE_CONTENT_BYTES;
    const content = buffer.subarray(0, MAX_FILE_CONTENT_BYTES).toString('utf8');
    return c.json({ session_id: sessionId, path: relativePath, content, truncated });
  });

  /**
   * @swagger
   * /api/v1/sessions/{sessionId}/files/content:
   *   put:
   *     summary: 保存文件内容
   *     tags: [Sessions, Files]
   *     security:
   *       - bearerAuth: []
   *     description: 将内容写入指定文件。仅支持文本文件，大小不超过 1MB。
   *     responses:
   *       200:
   *         description: 保存成功。
   *       400:
   *         description: 路径不合法、非文本文件、大小超限。
   *       404:
   *         description: 会话不存在或无访问权限。
   */
  app.put('/api/v1/sessions/:sessionId/files/content', async (c) => {
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const body = await c.req.json().catch(() => ({}));
    const relativePath = String((body as { path?: string }).path ?? '').trim();
    const content = (body as { content?: string }).content ?? '';

    if (!relativePath) {
      return c.json({ error: { code: 'INVALID_PATH', message: 'File path is required' } }, 400);
    }

    if (typeof content !== 'string') {
      return c.json({ error: { code: 'INVALID_CONTENT', message: 'Content must be a string' } }, 400);
    }

    const contentBytes = Buffer.from(content, 'utf8');
    if (contentBytes.byteLength > MAX_FILE_WRITE_BYTES) {
      return c.json({ error: { code: 'CONTENT_TOO_LARGE', message: `Content exceeds maximum size of ${MAX_FILE_WRITE_BYTES} bytes` } }, 413);
    }

    // Auth & resolve project root
    const resolved = resolveProjectDir(c, userId, sessionId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const cwd = resolved.cwd;

    // Path safety
    const absolutePath = resolveSafeFilePath(cwd, relativePath);
    if (!absolutePath) {
      return c.json({ error: { code: 'INVALID_PATH', message: 'Path is outside project root' } }, 400);
    }

    // Check for ignored directories
    const pathSegments = absolutePath.replace(cwd, '').split(/[/\\]/).filter(Boolean);
    const hasIgnoredSegment = pathSegments.some((seg) => IGNORED_ENTRY_NAMES.has(seg));
    if (hasIgnoredSegment) {
      return c.json({ error: { code: 'INVALID_PATH', message: 'Cannot write to ignored directories (.git, node_modules, etc.)' } }, 400);
    }

    // Must not be a directory
    const fileStat = await stat(absolutePath).catch(() => null);
    if (!fileStat) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'File not found' } }, 404);
    }
    if (fileStat.isDirectory()) {
      return c.json({ error: { code: 'IS_DIRECTORY', message: 'Cannot write to a directory' } }, 400);
    }

    // Only allow text file extensions
    if (!isTextFilePath(absolutePath)) {
      return c.json({ error: { code: 'UNSUPPORTED_FILE', message: 'Only text file editing is supported' } }, 400);
    }

    // Also check the written content doesn't look binary
    if (looksLikeBinary(contentBytes)) {
      return c.json({ error: { code: 'UNSUPPORTED_FILE', message: 'Binary content is not supported' } }, 400);
    }

    await writeFile(absolutePath, content, 'utf8');
    return c.json({ session_id: sessionId, path: relativePath, size: contentBytes.byteLength });
  });

  app.get('/api/v1/sessions/:sessionId/git-diff', async (c) => {
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const resolved = resolveProjectDir(c, userId, sessionId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const cwd = resolved.cwd;

    let diff = '';
    try {
      diff = execGit(cwd, 'diff');
    } catch (err: unknown) {
      if (err instanceof Error && 'stdout' in err) {
        diff = String((err as any).stdout ?? '');
      }
    }

    return c.json({ session_id: sessionId, diff, cwd });
  });

  app.post('/api/v1/sessions/:sessionId/git/pull', async (c) => {
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const resolved = resolveProjectDir(c, userId, sessionId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const cwd = resolved.cwd;

    try {
      const stdout = execGit(cwd, 'pull');
      return c.json({ session_id: sessionId, cwd, result: 'ok', stdout: stdout.trim() || 'Already up to date.' });
    } catch (err: unknown) {
      const stderr = err instanceof Error && 'stderr' in err ? String((err as any).stderr ?? err.message) : String(err);
      return c.json({ session_id: sessionId, cwd, result: 'error', stderr }, 500);
    }
  });

  app.post('/api/v1/sessions/:sessionId/git/push', async (c) => {
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const resolved = resolveProjectDir(c, userId, sessionId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const cwd = resolved.cwd;

    try {
      const stdout = execGit(cwd, 'push');
      return c.json({ session_id: sessionId, cwd, result: 'ok', stdout: stdout.trim() || 'Everything up-to-date.' });
    } catch (err: unknown) {
      const stderr = err instanceof Error && 'stderr' in err ? String((err as any).stderr ?? err.message) : String(err);
      return c.json({ session_id: sessionId, cwd, result: 'error', stderr }, 500);
    }
  });

  app.post('/api/v1/sessions/:sessionId/git/commit', async (c) => {
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const body = await c.req.json().catch(() => ({}));
    const message = String((body as { message?: string }).message ?? '').trim();

    if (!message) {
      return c.json({ error: { code: 'EMPTY_MESSAGE', message: 'Commit message is required' } }, 400);
    }

    const resolved = resolveProjectDir(c, userId, sessionId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const cwd = resolved.cwd;

    try {
      execGit(cwd, 'add -A');
      const stdout = execGit(cwd, `commit -m "${message.replace(/"/g, '\\"')}"`);
      return c.json({ session_id: sessionId, cwd, result: 'ok', stdout: stdout.trim() });
    } catch (err: unknown) {
      const stderr = err instanceof Error && 'stderr' in err ? String((err as any).stderr ?? err.message) : String(err);
      return c.json({ session_id: sessionId, cwd, result: 'error', stderr }, 500);
    }
  });

  app.post('/api/v1/sessions/:sessionId/git/gitignore', async (c) => {
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const body = await c.req.json().catch(() => ({}));
    const filePath = String((body as { path?: string }).path ?? '').trim();

    if (!filePath) {
      return c.json({ error: { code: 'INVALID_PATH', message: 'Path is required' } }, 400);
    }

    const resolved = resolveProjectDir(c, userId, sessionId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);

    const gitignorePath = path.join(resolved.cwd, '.gitignore');
    const normalizedEntry = filePath.replace(/\\/g, '/');

    let existingContent = '';
    try {
      await access(gitignorePath, constants.R_OK);
      existingContent = await readFile(gitignorePath, 'utf8');
    } catch {
      // .gitignore doesn't exist yet, that's fine
    }

    const lines = existingContent.split('\n').map((l) => l.trim());
    if (lines.includes(normalizedEntry)) {
      return c.json({ session_id: sessionId, path: normalizedEntry, result: 'already_ignored' });
    }

    const entry = existingContent.endsWith('\n') || existingContent.length === 0
      ? `${normalizedEntry}\n`
      : `\n${normalizedEntry}\n`;

    await appendFile(gitignorePath, entry, 'utf8');
    return c.json({ session_id: sessionId, path: normalizedEntry, result: 'ok' });
  });

  /**
   * @swagger
   * /api/v1/sessions/{sessionId}/git/branches:
   *   get:
   *     summary: 获取项目 Git 分支列表及当前分支
   *     tags: [Sessions, Git]
   *     security:
   *       - bearerAuth: []
   *     description: 返回项目当前 Git 分支列表及当前所在分支。
   *     responses:
   *       200:
   *         description: 查询成功。
   *       404:
   *         description: 会话不存在或无访问权限。
   *       500:
   *         description: Git 操作失败。
   */
  app.get('/api/v1/sessions/:sessionId/git/branches', async (c) => {
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const resolved = resolveProjectDir(c, userId, sessionId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const cwd = resolved.cwd;

    try {
      // Get current branch
      const currentBranch = execGit(cwd, 'rev-parse --abbrev-ref HEAD').trim();

      // Get all local branches
      const branchOutput = execGit(cwd, 'branch --format=\'%(refname:short)|||%(HEAD)\' ');
      const branches = branchOutput
        .split('\n')
        .filter(Boolean)
        .map((line: string) => {
          const [name, headMarker] = line.split('|||');
          return { name: name.trim(), is_current: headMarker.trim() === '*' };
        });

      return c.json({ session_id: sessionId, cwd, current_branch: currentBranch, branches });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: { code: 'GIT_ERROR', message } }, 500);
    }
  });

  /**
   * @swagger
   * /api/v1/sessions/{sessionId}/git/checkout:
   *   post:
   *     summary: 切换到指定 Git 分支
   *     tags: [Sessions, Git]
   *     security:
   *       - bearerAuth: []
   *     description: 切换到指定分支。
   *     responses:
   *       200:
   *         description: 切换成功。
   *       400:
   *         description: 分支名为空。
   *       404:
   *         description: 会话不存在或无访问权限。
   *       500:
   *         description: Git 操作失败。
   */
  app.post('/api/v1/sessions/:sessionId/git/checkout', async (c) => {
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const body = await c.req.json().catch(() => ({}));
    const branch = String((body as { branch?: string }).branch ?? '').trim();

    if (!branch) {
      return c.json({ error: { code: 'EMPTY_BRANCH', message: 'Branch name is required' } }, 400);
    }

    // Validate branch name format (allow letters, numbers, dots, hyphens, underscores, slashes)
    if (!/^[a-zA-Z0-9._\-/]+$/.test(branch)) {
      return c.json({ error: { code: 'INVALID_BRANCH', message: 'Branch name contains invalid characters' } }, 400);
    }

    const resolved = resolveProjectDir(c, userId, sessionId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const cwd = resolved.cwd;

    try {
      const stdout = execGit(cwd, `checkout "${branch.replace(/"/g, '\\"')}"`);
      return c.json({ session_id: sessionId, cwd, result: 'ok', stdout: stdout.trim(), branch });
    } catch (err: unknown) {
      const stderr = err instanceof Error && 'stderr' in err ? String((err as any).stderr ?? err.message) : String(err);
      return c.json({ session_id: sessionId, cwd, result: 'error', stderr, branch }, 500);
    }
  });

  /**
   * @swagger
   * /api/v1/sessions/{sessionId}/context-usage:
   *   get:
   *     summary: 获取会话上下文使用情况
   *     tags: [Sessions]
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: 查询成功，返回 token 使用量、context window 和百分比。
   *       404:
   *         description: 会话不存在或无访问权限。
   */
  app.get('/api/v1/sessions/:sessionId/context-usage', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!session) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const [project] = await db.select({ id: projects.id, createdBy: projects.createdBy, projectPath: projects.projectPath })
      .from(projects).where(eq(projects.id, session.projectId)).limit(1);
    if (!project || project.createdBy !== userId) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const locator = parseLocator(session.piSessionLocatorJson);
    const usage = await piClient.getContextUsage(sessionId, locator);

    if (!usage) {
      return c.json({ session_id: sessionId, tokens: null, context_window: 128000, percent: null });
    }

    return c.json({
      session_id: sessionId,
      tokens: usage.tokens,
      context_window: usage.contextWindow,
      percent: usage.percent,
    });
  });

  /**
   * @swagger
   * /api/v1/sessions/{sessionId}/compact:
   *   post:
   *     summary: 手动触发会话上下文压缩
   *     tags: [Sessions]
   *     security:
   *       - bearerAuth: []
   *     description: 触发 LLM 摘要生成以压缩上下文。仅在会话 idle 时可用。压缩进度通过 WebSocket 推送 compaction_start / compaction_end 事件。
   *     responses:
   *       202:
   *         description: 已受理压缩请求。
   *       409:
   *         description: 会话繁忙。
   *       404:
   *         description: 会话不存在或无访问权限。
   */
  app.post('/api/v1/sessions/:sessionId/compact', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!session) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const [project] = await db.select({ id: projects.id, createdBy: projects.createdBy, projectPath: projects.projectPath })
      .from(projects).where(eq(projects.id, session.projectId)).limit(1);
    if (!project || project.createdBy !== userId) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    if (session.runtimeStatus === 'running' || session.runtimeStatus === 'stopping') {
      return c.json({ error: { code: 'SESSION_BUSY', message: 'Session is currently busy' } }, 409);
    }

    const locator = parseLocator(session.piSessionLocatorJson);

    // Fire and forget — compaction is async, progress pushed via WS events
    (async () => {
      try {
        await piClient.compactSession(sessionId, locator, project.projectPath);
        log.info('compaction completed', { sessionId });
        socketHub.broadcast(createEvent('session.compacted', { session_id: sessionId }, { project_id: session.projectId, session_id: sessionId }));
      } catch (err) {
        log.error('compaction failed', { sessionId, error: String(err) });
      }
    })();

    return c.json({ session_id: sessionId, accepted: true }, 202);
  });

  registerWebSocketRoutes(app);
}

export function registerSessionMutationRoutes(app: Hono) {
  /**
   * @swagger
   * /api/v1/sessions/{sessionId}:
   *   patch:
   *     summary: 更新会话标题
   *     tags: [Sessions]
   *     security:
   *       - bearerAuth: []
   *     description: 更新标题并将 title_source 标记为 user。
   *     responses:
   *       200:
   *         description: 更新成功。
   *       400:
   *         description: 标题长度不合法。
   *       404:
   *         description: 会话不存在或无访问权限。
   */
  app.patch('/api/v1/sessions/:sessionId', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const userId = (c as any).get('userId') as string;
    const body = await c.req.json().catch(() => ({}));
    const title = String((body as { title?: string }).title ?? '').trim();

    if (!title || title.length > 200) {
      return c.json({ error: { code: 'INVALID_TITLE', message: 'Title must be 1-200 characters' } }, 400);
    }

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!session) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const [project] = await db.select({ id: projects.id, createdBy: projects.createdBy, projectPath: projects.projectPath }).from(projects).where(eq(projects.id, session.projectId)).limit(1);
    if (!project || project.createdBy !== userId) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const now = nextMessageTime();
    await db.update(sessions).set({ title, titleSource: 'user', updatedAt: now }).where(eq(sessions.id, sessionId));
    await createAuditService(db).record(userId, "title.changed", "session", sessionId, { old_title: session.title, new_title: title });

    socketHub.broadcast(createEvent('session.updated', { session_id: sessionId }, { project_id: session.projectId, session_id: sessionId }));
    socketHub.broadcast(createEvent('tree.changed', { project_id: session.projectId }, { project_id: session.projectId }));

    return c.json({ session_id: sessionId, title, title_source: 'user' });
  });
}
