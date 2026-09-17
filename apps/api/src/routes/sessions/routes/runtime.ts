import type { Hono } from 'hono';
import { createDb } from '@piplus/db/client';
import { sessions, projects } from '@piplus/db/schema';
import type { PiClient } from '@piplus/pi-client';
import { parseLocator } from '@piplus/pi-client/locator';
import { eq } from 'drizzle-orm';
import { getDbPath } from '../../../db-context';
import { socketHub } from '../../../ws/server';
import { createEvent } from '../../../ws/protocol';
import { createAuditService, clearIdleRuntimeCleanup, finalizeSessionStop } from '@piplus/domain';
import { nextMessageTime, log } from '../shared';

/** stop / archive（原注册顺序位于 files/git 路由之前，由 routes/index.ts 先行调用本函数保持顺序）。 */
export function registerSessionControlRoutes(app: Hono, piClient: PiClient) {

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
    // 收尾：等 agent 真正停止（带超时），无论结果都收敛回 idle，避免永久卡 stopping。
    void finalizeSessionStop({
      db,
      piClient,
      sessionId,
      projectId: session.projectId,
      onRuntimeStatusChange: async ({ sessionId: sId, projectId }) => {
        socketHub.sendToSession(sId, createEvent('session.runtime_status_changed', { runtime_status: 'idle' }, { project_id: projectId, session_id: sId }));
      },
    }).catch((err) => {
      log.warn('session stop finalization failed', { sessionId, error: String(err) });
    });
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
    // 归档后会话不可用，runtime 与回收定时器一并释放；
    // 若未来支持取消归档，ensureRuntime 可基于仍在磁盘的 session 文件完整重建。
    try {
      clearIdleRuntimeCleanup(sessionId);
      await piClient.disposeSession(sessionId, parseLocator(session.piSessionLocatorJson));
    } catch (err) {
      log.warn('archive: runtime cleanup failed', { sessionId, error: String(err) });
    }
    await db.update(sessions).set({ status: 'archived', archivedAt: now, archivedBy: userId, updatedAt: now }).where(eq(sessions.id, sessionId));
    log.info('session archived', { sessionId });
    await createAuditService(db).record(userId, "session.archived", "session", sessionId);
    socketHub.broadcast(createEvent('session.archived', { session_id: sessionId }, { project_id: session.projectId, session_id: sessionId }));
    socketHub.broadcast(createEvent('tree.changed', { project_id: session.projectId }, { project_id: session.projectId }));
    return c.json({ session_id: sessionId, status: 'archived' }, 200);
  });
}

/** context-usage、compact、restore-runtime、commands。 */
export function registerRuntimeRoutes(app: Hono, piClient: PiClient) {

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

  app.post('/api/v1/sessions/:sessionId/restore-runtime', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!session) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);
    const [project] = await db.select({ id: projects.id, createdBy: projects.createdBy, projectPath: projects.projectPath })
      .from(projects).where(eq(projects.id, session.projectId)).limit(1);
    if (!project || project.createdBy !== userId) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);
    const locator = parseLocator(session.piSessionLocatorJson);
    piClient.restoreRuntime(sessionId, locator, project.projectPath).then(() => {
      log.info('runtime restored on demand', { sessionId });
      socketHub.sendToSession(sessionId, createEvent('runtime.restored', {}, { project_id: session.projectId, session_id: sessionId }));
    }).catch((err) => {
      log.warn('runtime restore on demand failed', { sessionId, error: String(err) });
    });
    return c.json({ session_id: sessionId, accepted: true }, 202);
  });

  /**
   * @swagger
   * /api/v1/sessions/{sessionId}/commands:
   *   get:
   *     summary: 获取会话可用的 slash commands
   *     tags: [Sessions]
   *     security:
   *       - bearerAuth: []
   *     description: 返回当前会话可用的 slash commands，包括扩展命令、prompt templates 和 skills。
   *     responses:
   *       200:
   *         description: 查询成功。
   *       404:
   *         description: 会话不存在或无访问权限。
   */
  app.get('/api/v1/sessions/:sessionId/commands', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);

    if (!session) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const [project] = await db.select({ id: projects.id, createdBy: projects.createdBy }).from(projects).where(eq(projects.id, session.projectId)).limit(1);
    if (!project || project.createdBy !== userId) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const commands = await piClient.getCommands(sessionId);
    return c.json({ commands });
  });
}
