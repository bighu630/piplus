import type { Hono } from 'hono';
import { createDb } from '@piplus/db/client';
import { messages, projects, roleTemplates, sessionEvents, sessionSyncStates, sessions } from '@piplus/db/schema';
import { and, desc, eq, lt, or } from 'drizzle-orm';
import { createPiClient } from '@piplus/pi-client';
import { parseLocator } from '@piplus/pi-client/locator';
import { getDbPath } from '../db-context';
import { registerWebSocketRoutes, socketHub } from '../ws/server';
import { createEvent } from '../ws/protocol';
import { mapPiStreamEventToFrames } from '../lib/pi-stream-bridge';
import { createLogger } from '../lib/logger';
import { createAuditService, startSessionRun } from '@piplus/domain';
import { execSync } from 'node:child_process';

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
    const currentModel = runtimeModel ?? (
      session.currentModelProvider && session.currentModelId
        ? { provider: session.currentModelProvider, id: session.currentModelId, label: `${session.currentModelProvider}/${session.currentModelId}` }
        : null
    );

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
        message_kind: 'normal',
        source_session_id: null,
        content_text: row.text,
        created_at: row.createdAt,
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

    if (!content) {
      return c.json({ error: { code: 'EMPTY_MESSAGE', message: 'Message content is required' } }, 400);
    }

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!session) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const [project] = await db.select({ id: projects.id, createdBy: projects.createdBy, projectPath: projects.projectPath }).from(projects).where(eq(projects.id, session.projectId)).limit(1);
    if (!project || project.createdBy !== userId) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    if (session.runtimeStatus === 'running' || session.runtimeStatus === 'stopping') {
      return c.json({ error: { code: 'SESSION_BUSY', message: 'Session is currently busy' } }, 409);
    }

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
      contentBlocksJson: null,
      contentVersion: 1,
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
      startedAt: now,
      onStreamEvent: async (event) => {
        console.log('[api/ws] stream event', { sessionId, type: event.type, delta: (event as any).delta ?? null });
        for (const frame of mapPiStreamEventToFrames(sessionId, event)) {
          socketHub.sendToSession(sessionId, frame);
        }
      },
      onRuntimeStatusChange: async ({ projectId, runtimeStatus }) => {
        socketHub.sendToSession(sessionId, createEvent('session.runtime_status_changed', { runtime_status: runtimeStatus }, { project_id: projectId, session_id: sessionId }));
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

    if (session.runtimeStatus !== 'idle') {
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

    await piClient.stopSession(sessionId);
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

  function execGit(cwd: string, ...args: string[]) {
    const stdout = execSync(`git ${args.join(' ')}`, { cwd, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }).toString();
    return stdout;
  }

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
