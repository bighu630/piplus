import type { Hono } from 'hono';
import { createDb } from '@piplus/db/client';
import { sessions, projects } from '@piplus/db/schema';
import { eq } from 'drizzle-orm';
import { getDbPath } from '../../../db-context';
import { socketHub } from '../../../ws/server';
import { createEvent } from '../../../ws/protocol';
import { createAuditService } from '@piplus/domain';
import { nextMessageTime } from '../shared';

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
    const title = (body as { title?: string }).title;
    const pinned: boolean | undefined = (body as { pinned?: boolean }).pinned;

    // Only validate title when it is provided
    if (title !== undefined) {
      const trimmed = String(title).trim();
      if (!trimmed || trimmed.length > 200) {
        return c.json({ error: { code: 'INVALID_TITLE', message: 'Title must be 1-200 characters' } }, 400);
      }
    }

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!session) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const [project] = await db.select({ id: projects.id, createdBy: projects.createdBy, projectPath: projects.projectPath }).from(projects).where(eq(projects.id, session.projectId)).limit(1);
    if (!project || project.createdBy !== userId) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const now = nextMessageTime();
    const updates: Record<string, any> = {};
    if (title !== undefined) {
      const trimmed = String(title).trim();
      updates.title = trimmed;
      updates.titleSource = 'user';
    }
    if (pinned === true) {
      updates.pinnedAt = new Date();
    } else if (pinned === false) {
      updates.pinnedAt = null;
    }

    if (Object.keys(updates).length === 0) {
      // nothing to update, but still return success
      return c.json({ session_id: sessionId, title: session.title, title_source: session.titleSource, pinned_at: session.pinnedAt ? new Date(session.pinnedAt).toISOString() : null });
    }

    updates.updatedAt = now;
    await db.update(sessions).set(updates).where(eq(sessions.id, sessionId));

    if (title !== undefined) {
      await createAuditService(db).record(userId, "title.changed", "session", sessionId, { old_title: session.title, new_title: updates.title });
    }
    if (pinned !== undefined) {
      const wasPinned = session.pinnedAt !== null;
      if (pinned && !wasPinned) {
        await createAuditService(db).record(userId, "session.pinned", "session", sessionId);
      } else if (!pinned && wasPinned) {
        await createAuditService(db).record(userId, "session.unpinned", "session", sessionId);
      }
    }

    socketHub.broadcast(createEvent('session.updated', { session_id: sessionId }, { project_id: session.projectId, session_id: sessionId }));
    socketHub.broadcast(createEvent('tree.changed', { project_id: session.projectId }, { project_id: session.projectId }));

    const updatedTitle = title !== undefined ? String(title).trim() : session.title;
    const updatedPinnedAt = pinned === true ? new Date() : pinned === false ? null : session.pinnedAt;
    return c.json({
      session_id: sessionId,
      title: updatedTitle,
      title_source: title !== undefined ? 'user' : session.titleSource,
      pinned_at: updatedPinnedAt ? new Date(updatedPinnedAt).toISOString() : null,
    });
  });

}
