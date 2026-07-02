import type { Hono } from 'hono';
import { createDb } from '@piplus/db/client';
import { createAuditService } from '@piplus/domain';
import { messages, projects, projectTodos, sessionEvents, sessionSyncStates, sessions } from '@piplus/db/schema';
import { createProjectWithPlanner } from '@piplus/domain/project/service';
import { createTopLevelSession } from '@piplus/domain/session/service';
import { createPiClient } from '@piplus/pi-client';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getDbPath } from '../db-context';
import { getServerConfig } from '../server-config';
import { createEvent } from '../ws/protocol';
import { socketHub } from '../ws/server';
import { and, desc, eq, inArray } from 'drizzle-orm';

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
    const requestedModel = (body as { model?: { provider?: string; id?: string } | null }).model;
    const plannerModel = requestedModel?.provider && requestedModel?.id
      ? { provider: requestedModel.provider, id: requestedModel.id }
      : null;

    if (mode === 'existing') {
      if (!path) return c.json({ error: { code: 'INVALID_PATH', message: 'Path is required' } }, 400);
      if (!existsSync(path) || !statSync(path).isDirectory()) {
        return c.json({ error: { code: 'PATH_NOT_FOUND', message: 'Directory not found' } }, 400);
      }
    }

    if (mode === 'git_clone') {
      if (!repoUrl) return c.json({ error: { code: 'INVALID_URL', message: 'Repository URL is required' } }, 400);
      const root = getServerConfig().projectsRoot;
      const repoName = repoUrl.split('/').pop()?.replace('.git', '') ?? 'repo';
      const targetPath = join(root, repoName);
      if (existsSync(targetPath)) {
        return c.json({ error: { code: 'PATH_EXISTS', message: 'Target directory already exists' } }, 409);
      }
      const proc = Bun.spawnSync(['git', 'clone', repoUrl, targetPath], { stdout: 'pipe', stderr: 'pipe' });
      if (proc.exitCode !== 0) {
        return c.json({ error: { code: 'CLONE_FAILED', message: 'Git clone failed' } }, 500);
      }
      const result = await createProjectWithPlanner(db, piClient, repoName, userId, targetPath, 'git_clone', repoUrl, plannerModel);
      await createAuditService(db).record(userId, "project.created", "project", result.projectId, { name: repoName, path: targetPath, sourceType: 'git_clone', sourceUrl: repoUrl });
      await createAuditService(db).record(userId, "session.created", "session", result.sessionId, { role: "planner", project_id: result.projectId });
      socketHub.broadcast(createEvent('project.created', { project_id: result.projectId }, { project_id: result.projectId }));
      socketHub.broadcast(createEvent('session.created', { session_id: result.sessionId }, { project_id: result.projectId, session_id: result.sessionId }));
      socketHub.broadcast(createEvent('tree.changed', { project_id: result.projectId }, { project_id: result.projectId }));
      return c.json(result, 201);
    }

    // existing mode
    const result = await createProjectWithPlanner(db, piClient, name, userId, path, 'existing', '', plannerModel);
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
  app.get('/api/v1/projects/:projectId/role-models', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const projectId = c.req.param('projectId');
    const userId = (c as any).get('userId') as string;

    const [project] = await db.select({ id: projects.id, createdBy: projects.createdBy, roleDefaultModels: projects.roleDefaultModels }).from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project) return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
    if (project.createdBy !== userId) return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);

    try {
      const parsed = JSON.parse(project.roleDefaultModels ?? '{}');
      return c.json(parsed);
    } catch {
      return c.json({});
    }
  });

  app.put('/api/v1/projects/:projectId/role-models', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const projectId = c.req.param('projectId');
    const userId = (c as any).get('userId') as string;
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;

    const [project] = await db.select({ id: projects.id, createdBy: projects.createdBy }).from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project) return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
    if (project.createdBy !== userId) return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);

    // Validate: each value must be null or an object with non-empty string provider and id
    const validated: Record<string, { provider: string; id: string } | null> = {};
    for (const [key, value] of Object.entries(body)) {
      if (value === null) {
        validated[key] = null;
      } else if (typeof value === 'object' && value !== null) {
        const v = value as Record<string, unknown>;
        if (typeof v.provider !== 'string' || !v.provider || typeof v.id !== 'string' || !v.id) {
          return c.json({ error: { code: 'VALIDATION_ERROR', message: `Invalid entry for role '${key}': provider and id must be non-empty strings` } }, 400);
        }
        validated[key] = { provider: v.provider, id: v.id };
      } else {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: `Invalid entry for role '${key}': must be null or an object with provider and id` } }, 400);
      }
    }

    await db.update(projects).set({ roleDefaultModels: JSON.stringify(validated) }).where(eq(projects.id, projectId));
    socketHub.broadcast(createEvent('tree.changed', { project_id: projectId }, { project_id: projectId }));
    return c.json({ ok: true, role_default_models: validated });
  });

  app.get('/api/v1/projects/:projectId/todos', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const projectId = c.req.param('projectId');
    const userId = (c as any).get('userId') as string;

    const [project] = await db.select({ id: projects.id, createdBy: projects.createdBy })
      .from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project || project.createdBy !== userId) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
    }

    const todos = await db.select()
      .from(projectTodos)
      .where(eq(projectTodos.projectId, projectId))
      .orderBy(projectTodos.done, projectTodos.sortOrder, projectTodos.createdAt);

    return c.json(todos.map((t) => ({
      id: t.id,
      project_id: t.projectId,
      text: t.text,
      done: t.done,
      sort_order: t.sortOrder,
      created_at: new Date(t.createdAt).toISOString(),
      updated_at: new Date(t.updatedAt).toISOString(),
    })));
  });

  app.post('/api/v1/projects/:projectId/todos', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const projectId = c.req.param('projectId');
    const userId = (c as any).get('userId') as string;
    const body = await c.req.json().catch(() => ({}));
    const text = String((body as { text?: string }).text ?? '').trim();

    if (!text || text.length > 500) {
      return c.json({ error: { code: 'INVALID_TEXT', message: 'Text must be 1-500 characters' } }, 400);
    }

    const [project] = await db.select({ id: projects.id, createdBy: projects.createdBy })
      .from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project || project.createdBy !== userId) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
    }

    // Get max sort_order
    const [maxRow] = await db.select({ maxOrder: projectTodos.sortOrder })
      .from(projectTodos)
      .where(eq(projectTodos.projectId, projectId))
      .orderBy(desc(projectTodos.sortOrder))
      .limit(1);

    const now = new Date();
    const id = `todo_${crypto.randomUUID().slice(0, 12)}`;
    const sortOrder = (maxRow?.maxOrder ?? -1) + 1;

    await db.insert(projectTodos).values({
      id,
      projectId,
      text,
      done: false,
      sortOrder,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    } as any);

    return c.json({
      id,
      project_id: projectId,
      text,
      done: false,
      sort_order: sortOrder,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    }, 201);
  });

  app.patch('/api/v1/projects/:projectId/todos/:todoId', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const projectId = c.req.param('projectId');
    const todoId = c.req.param('todoId');
    const userId = (c as any).get('userId') as string;
    const body = await c.req.json().catch(() => ({}));

    const [project] = await db.select({ id: projects.id, createdBy: projects.createdBy })
      .from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project || project.createdBy !== userId) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
    }

    const [todo] = await db.select()
      .from(projectTodos)
      .where(and(eq(projectTodos.id, todoId), eq(projectTodos.projectId, projectId)))
      .limit(1);
    if (!todo) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Todo not found' } }, 404);
    }

    const patch: Record<string, unknown> = {};
    const updates = body as { text?: string; done?: boolean; sort_order?: number };

    if (typeof updates.text === 'string') {
      const trimmed = updates.text.trim();
      if (!trimmed || trimmed.length > 500) {
        return c.json({ error: { code: 'INVALID_TEXT', message: 'Text must be 1-500 characters' } }, 400);
      }
      patch.text = trimmed;
    }
    if (typeof updates.done === 'boolean') {
      patch.done = updates.done;
    }
    if (typeof updates.sort_order === 'number') {
      patch.sortOrder = updates.sort_order;
    }

    if (Object.keys(patch).length === 0) {
      return c.json({ error: { code: 'INVALID_PATCH', message: 'No valid fields to update' } }, 400);
    }

    const now = new Date();
    patch.updatedAt = now;

    await db.update(projectTodos).set(patch as any)
      .where(and(eq(projectTodos.id, todoId), eq(projectTodos.projectId, projectId)));

    // Fetch updated
    const [updated] = await db.select()
      .from(projectTodos)
      .where(eq(projectTodos.id, todoId))
      .limit(1);

    return c.json({
      id: updated!.id,
      project_id: updated!.projectId,
      text: updated!.text,
      done: updated!.done,
      sort_order: updated!.sortOrder,
      created_at: new Date(updated!.createdAt).toISOString(),
      updated_at: new Date(updated!.updatedAt).toISOString(),
    });
  });

  app.delete('/api/v1/projects/:projectId/todos/:todoId', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const projectId = c.req.param('projectId');
    const todoId = c.req.param('todoId');
    const userId = (c as any).get('userId') as string;

    const [project] = await db.select({ id: projects.id, createdBy: projects.createdBy })
      .from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project || project.createdBy !== userId) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
    }

    const [todo] = await db.select({ id: projectTodos.id })
      .from(projectTodos)
      .where(and(eq(projectTodos.id, todoId), eq(projectTodos.projectId, projectId)))
      .limit(1);
    if (!todo) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Todo not found' } }, 404);
    }

    await db.delete(projectTodos)
      .where(and(eq(projectTodos.id, todoId), eq(projectTodos.projectId, projectId)));

    return c.json({ ok: true });
  });

  app.delete('/api/v1/projects/:projectId', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const projectId = c.req.param('projectId');
    const userId = (c as any).get('userId') as string;

    const [project] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), eq(projects.createdBy, userId))).limit(1);
    if (!project) return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);

    const sessionRows = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.projectId, projectId));
    const sessionIds = sessionRows.map((s) => s.id);

    // Delete project todos
    await db.delete(projectTodos).where(eq(projectTodos.projectId, projectId));

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
