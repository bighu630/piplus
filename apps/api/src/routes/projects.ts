import type { Hono } from 'hono';
import { createDb } from '@piplus/db/client';
import { createAuditService } from '@piplus/domain';
import { projects } from '@piplus/db/schema';
import { createProjectWithPlanner } from '@piplus/domain/project/service';
import { createTopLevelSession } from '@piplus/domain/session/service';
import { createPiClient } from '@piplus/pi-client';
import { getDbPath } from '../db-context';
import { createEvent } from '../ws/protocol';
import { socketHub } from '../ws/server';
import { and, eq } from 'drizzle-orm';

export function registerProjectRoutes(app: Hono) {
  const piClient = createPiClient();

  app.post('/api/v1/projects', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const body = await c.req.json().catch(() => ({}));
    const name = (body as { name?: string }).name ?? 'Untitled Project';
    const userId = (c as any).get('userId') as string;

    const result = await createProjectWithPlanner(db, piClient, name, userId);
    await createAuditService(db).record(userId, "project.created", "project", result.projectId, { name });
    await createAuditService(db).record(userId, "session.created", "session", result.sessionId, { role: "planner", project_id: result.projectId });
    socketHub.broadcast(createEvent('project.created', { project_id: result.projectId }, { project_id: result.projectId }));
    socketHub.broadcast(createEvent('session.created', { session_id: result.sessionId }, { project_id: result.projectId, session_id: result.sessionId }));
    socketHub.broadcast(createEvent('tree.changed', { project_id: result.projectId }, { project_id: result.projectId }));

    return c.json(result, 201);
  });

  app.post('/api/v1/projects/:projectId/sessions', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const projectId = c.req.param('projectId');
    const userId = (c as any).get('userId') as string;

    const [project] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), eq(projects.createdBy, userId))).limit(1);
    if (!project) return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);

    const result = await createTopLevelSession(db, piClient, { projectId, createdBy: userId });
    await createAuditService(db).record(userId, "session.created", "session", result.sessionId, { role: "blank", project_id: projectId });
    socketHub.broadcast(createEvent('session.created', { session_id: result.sessionId }, { project_id: result.projectId, session_id: result.sessionId }));
    socketHub.broadcast(createEvent('tree.changed', { project_id: result.projectId }, { project_id: result.projectId }));

    return c.json({ session_id: result.sessionId, project_id: result.projectId }, 201);
  });
}
