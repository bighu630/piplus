import type { Hono } from 'hono';
import { createDb } from '@piplus/db/client';
import { createAuditService } from '@piplus/domain';
import { messages, projects, sessionEvents, sessionSyncStates, sessions } from '@piplus/db/schema';
import { createProjectWithPlanner } from '@piplus/domain/project/service';
import { createTopLevelSession } from '@piplus/domain/session/service';
import { createPiClient } from '@piplus/pi-client';
import { join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { getDbPath } from '../db-context';
import { createEvent } from '../ws/protocol';
import { socketHub } from '../ws/server';
import { and, eq, inArray } from 'drizzle-orm';

export function registerProjectRoutes(app: Hono) {
  const piClient = createPiClient();

  /**
   * @swagger
   * /api/v1/projects:
   *   post:
   *     summary: 创建项目并自动创建 planner 会话
   *     tags: [Projects]
   *     security:
   *       - bearerAuth: []
   *     description: 支持 existing 模式导入本地目录，或 git_clone 模式克隆远端仓库。
   *     responses:
   *       201:
   *         description: 返回 projectId 与自动创建的 sessionId。
   *       400:
   *         description: 参数错误或路径不存在。
   *       409:
   *         description: clone 目标目录已存在。
   */
  app.post('/api/v1/projects', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const body = await c.req.json().catch(() => ({}));
    const name = (body as { name?: string }).name ?? 'Untitled Project';
    const userId = (c as any).get('userId') as string;
    const mode = (body as { mode?: string }).mode ?? 'existing';
    const path = (body as { path?: string }).path ?? '';
    const repoUrl = (body as { repo_url?: string }).repo_url ?? '';

    if (mode === 'existing') {
      if (!path) return c.json({ error: { code: 'INVALID_PATH', message: 'Path is required' } }, 400);
      if (!existsSync(path) || !statSync(path).isDirectory()) {
        return c.json({ error: { code: 'PATH_NOT_FOUND', message: 'Directory not found' } }, 400);
      }
    }

    if (mode === 'git_clone') {
      if (!repoUrl) return c.json({ error: { code: 'INVALID_URL', message: 'Repository URL is required' } }, 400);
      const root = Bun.env.PROJECTS_ROOT ?? join(Bun.env.HOME ?? '~', 'projects');
      const repoName = repoUrl.split('/').pop()?.replace('.git', '') ?? 'repo';
      const targetPath = join(root, repoName);
      if (existsSync(targetPath)) {
        return c.json({ error: { code: 'PATH_EXISTS', message: 'Target directory already exists' } }, 409);
      }
      const proc = Bun.spawnSync(['git', 'clone', repoUrl, targetPath], { stdout: 'pipe', stderr: 'pipe' });
      if (proc.exitCode !== 0) {
        return c.json({ error: { code: 'CLONE_FAILED', message: 'Git clone failed' } }, 500);
      }
      const result = await createProjectWithPlanner(db, piClient, repoName, userId, targetPath, 'git_clone', repoUrl);
      await createAuditService(db).record(userId, "project.created", "project", result.projectId, { name: repoName, path: targetPath, sourceType: 'git_clone', sourceUrl: repoUrl });
      await createAuditService(db).record(userId, "session.created", "session", result.sessionId, { role: "planner", project_id: result.projectId });
      socketHub.broadcast(createEvent('project.created', { project_id: result.projectId }, { project_id: result.projectId }));
      socketHub.broadcast(createEvent('session.created', { session_id: result.sessionId }, { project_id: result.projectId, session_id: result.sessionId }));
      socketHub.broadcast(createEvent('tree.changed', { project_id: result.projectId }, { project_id: result.projectId }));
      return c.json(result, 201);
    }

    // existing mode
    const result = await createProjectWithPlanner(db, piClient, name, userId, path, 'existing', '');
    await createAuditService(db).record(userId, "project.created", "project", result.projectId, { name });
    await createAuditService(db).record(userId, "session.created", "session", result.sessionId, { role: "planner", project_id: result.projectId });
    socketHub.broadcast(createEvent('project.created', { project_id: result.projectId }, { project_id: result.projectId }));
    socketHub.broadcast(createEvent('session.created', { session_id: result.sessionId }, { project_id: result.projectId, session_id: result.sessionId }));
    socketHub.broadcast(createEvent('tree.changed', { project_id: result.projectId }, { project_id: result.projectId }));

    return c.json(result, 201);
  });

  /**
   * @swagger
   * /api/v1/projects/{projectId}/sessions:
   *   post:
   *     summary: 在项目下创建新的顶层会话
   *     tags: [Projects, Sessions]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: projectId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       201:
   *         description: 返回新创建的 session_id 和 project_id。
   *       404:
   *         description: 项目不存在。
   */
  app.post('/api/v1/projects/:projectId/sessions', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const projectId = c.req.param('projectId');
    const userId = (c as any).get('userId') as string;
    const body = await c.req.json().catch(() => ({}));
    const inheritModel = (body as { inherit_model?: { provider?: string; id?: string } | null }).inherit_model;

    const [project] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), eq(projects.createdBy, userId))).limit(1);
    if (!project) return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);

    const result = await createTopLevelSession(db, piClient, {
      projectId,
      createdBy: userId,
      inheritModel: inheritModel?.provider && inheritModel?.id
        ? { provider: inheritModel.provider, id: inheritModel.id }
        : null,
    });
    await createAuditService(db).record(userId, "session.created", "session", result.sessionId, { role: "blank", project_id: projectId });
    socketHub.broadcast(createEvent('session.created', { session_id: result.sessionId }, { project_id: result.projectId, session_id: result.sessionId }));
    socketHub.broadcast(createEvent('tree.changed', { project_id: result.projectId }, { project_id: result.projectId }));

    return c.json({ session_id: result.sessionId, project_id: result.projectId }, 201);
  });

  /**
   * @swagger
   * /api/v1/projects/{projectId}/archive:
   *   post:
   *     summary: 归档项目
   *     tags: [Projects]
   *     security:
   *       - bearerAuth: []
   *     description: 归档项目，同时归档该项目下所有会话。
   *     responses:
   *       200:
   *         description: 归档成功。
   *       404:
   *         description: 项目不存在。
   */
  app.post('/api/v1/projects/:projectId/archive', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const projectId = c.req.param('projectId');
    const userId = (c as any).get('userId') as string;

    const [project] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), eq(projects.createdBy, userId))).limit(1);
    if (!project) return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);

    const now = new Date();
    await db.update(projects).set({ status: 'archived', archivedAt: now, archivedBy: userId, updatedAt: now }).where(eq(projects.id, projectId));
    await db.update(sessions).set({ status: 'archived', archivedAt: now, archivedBy: userId }).where(eq(sessions.projectId, projectId));
    socketHub.broadcast(createEvent('tree.changed', { project_id: projectId }, { project_id: projectId }));
    return c.json({ project_id: projectId, status: 'archived' }, 200);
  });

  /**
   * @swagger
   * /api/v1/projects/{projectId}:
   *   delete:
   *     summary: 删除项目
   *     tags: [Projects]
   *     security:
   *       - bearerAuth: []
   *     description: 删除项目及其关联会话、消息、会话事件和同步状态。
   *     responses:
   *       200:
   *         description: 删除成功。
   *       404:
   *         description: 项目不存在。
   */
  app.delete('/api/v1/projects/:projectId', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const projectId = c.req.param('projectId');
    const userId = (c as any).get('userId') as string;

    const [project] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), eq(projects.createdBy, userId))).limit(1);
    if (!project) return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);

    const sessionRows = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.projectId, projectId));
    const sessionIds = sessionRows.map((s) => s.id);

    if (sessionIds.length) {
      await db.delete(messages).where(inArray(messages.sessionId, sessionIds));
      await db.delete(sessionEvents).where(inArray(sessionEvents.sessionId, sessionIds));
      await db.delete(sessionSyncStates).where(inArray(sessionSyncStates.sessionId, sessionIds));
    }
    await db.delete(sessions).where(eq(sessions.projectId, projectId));
    await db.delete(projects).where(eq(projects.id, projectId));
    socketHub.broadcast(createEvent('tree.changed', { project_id: projectId }, { project_id: projectId }));
    return c.json({ project_id: projectId, status: 'deleted' }, 200);
  });
}
