import type { Hono } from 'hono';
import { createDb } from '@piplus/db/client';
import { projects, sessions } from '@piplus/db/schema';
import type { PiClient } from '@piplus/pi-client';
import { parseLocator } from '@piplus/pi-client/locator';
import { eq } from 'drizzle-orm';
import { getDbPath } from '../../../db-context';
import { log } from '../shared';

export function registerModelConfigRoutes(app: Hono, piClient: PiClient) {

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
   * /api/v1/sessions/{sessionId}/thinking-level:
   *   get:
   *     summary: 获取会话当前 thinking level 及可用 levels
   *     tags: [Sessions]
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: 查询成功。
   *       404:
   *         description: 会话不存在或无访问权限。
   */
  app.get('/api/v1/sessions/:sessionId/thinking-level', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!session) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const [project] = await db.select({ id: projects.id, createdBy: projects.createdBy, projectPath: projects.projectPath }).from(projects).where(eq(projects.id, session.projectId)).limit(1);
    if (!project || project.createdBy !== userId) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const locator = parseLocator(session.piSessionLocatorJson);
    let currentLevel: string | null = null;
    let availableLevels: string[] = [];
    try {
      currentLevel = await piClient.getThinkingLevel(sessionId, locator, project.projectPath);
      availableLevels = await piClient.getAvailableThinkingLevels(sessionId, locator, project.projectPath);
    } catch (err) {
      log.warn('thinking-level get failed, returning defaults', { sessionId, error: String(err) });
    }

    return c.json({
      session_id: sessionId,
      current_level: currentLevel,
      available_levels: availableLevels,
    });
  });

  /**
   * @swagger
   * /api/v1/sessions/{sessionId}/thinking-level:
   *   put:
   *     summary: 设置会话 thinking level
   *     tags: [Sessions]
   *     security:
   *       - bearerAuth: []
   *     description: 仅允许在会话 idle 时切换 thinking level。
   *     responses:
   *       200:
   *         description: 设置成功。
   *       400:
   *         description: level 参数缺失。
   *       404:
   *         description: 会话不存在或无访问权限。
   *       409:
   *         description: 会话繁忙。
   */
  app.put('/api/v1/sessions/:sessionId/thinking-level', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const body = await c.req.json().catch(() => ({}));
    const level = String((body as { level?: string }).level ?? '');

    if (!level) return c.json({ error: { code: 'INVALID_LEVEL', message: 'Thinking level is required' } }, 400);

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!session) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const [project] = await db.select({ id: projects.id, createdBy: projects.createdBy, projectPath: projects.projectPath }).from(projects).where(eq(projects.id, session.projectId)).limit(1);
    if (!project || project.createdBy !== userId) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    if (session.runtimeStatus === 'running') {
      return c.json({ error: { code: 'SESSION_BUSY', message: 'Session is currently busy' } }, 409);
    }

    const locator = parseLocator(session.piSessionLocatorJson);
    try {
      const currentLevel = await piClient.setThinkingLevel(sessionId, locator, level, project.projectPath);
      return c.json({ session_id: sessionId, current_level: currentLevel });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown';
      if (message === 'pi_session_busy') {
        return c.json({ error: { code: 'SESSION_BUSY', message: 'Session is currently busy' } }, 409);
      }
      return c.json({ error: { code: 'SET_THINKING_LEVEL_FAILED', message } }, 500);
    }
  });
}
