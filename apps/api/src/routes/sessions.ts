import type { Hono } from 'hono';
import { createDb } from '@piplus/db/client';
import { messages, projects, roleTemplates, sessionEvents, sessionSyncStates, sessions } from '@piplus/db/schema';
import { and, desc, eq, lt, or } from 'drizzle-orm';
import { createPiClient } from '@piplus/pi-client';
import { getDbPath } from '../db-context';
import { registerWebSocketRoutes, socketHub } from '../ws/server';
import { createChatStreamFrame, createEvent } from '../ws/protocol';
import { createLogger } from '../lib/logger';
import { createAuditService } from '@piplus/domain';

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

  app.get('/api/v1/sessions/:sessionId/info', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);

    if (!session) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const [project] = await db.select({ id: projects.id, name: projects.name, createdBy: projects.createdBy }).from(projects).where(eq(projects.id, session.projectId)).limit(1);
    if (!project || project.createdBy !== userId) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const [rt] = await db.select({ key: roleTemplates.key, version: roleTemplates.version, name: roleTemplates.name })
      .from(roleTemplates).where(eq(roleTemplates.id, session.roleTemplateId)).limit(1);

    const [parent] = await db.select({ id: sessions.id, title: sessions.title }).from(sessions).where(eq(sessions.id, session.parentSessionId ?? '')).limit(1);
    const [root] = await db.select({ id: sessions.id, title: sessions.title }).from(sessions).where(eq(sessions.id, session.rootSessionId)).limit(1);
    const [sync] = await db.select().from(sessionSyncStates).where(eq(sessionSyncStates.sessionId, sessionId)).limit(1);

    const events = await db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, sessionId)).orderBy(desc(sessionEvents.createdAt)).limit(20);

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
        status: session.status,
        runtime_status: session.runtimeStatus,
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

  app.get('/api/v1/sessions/:sessionId/chat/messages', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!session) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const [project] = await db.select({ id: projects.id, createdBy: projects.createdBy }).from(projects).where(eq(projects.id, session.projectId)).limit(1);
    if (!project || project.createdBy !== userId) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const limit = Math.min(Number(c.req.query('limit') ?? '50') || 50, 100);
    const cursor = c.req.query('cursor');
    const piPage = await piClient.listMessages(session.piSessionId, cursor ?? null, limit);
    const pageRows = piPage.messages;

    return c.json({
      session_id: sessionId,
      cursor: cursor ?? null,
      next_cursor: piPage.nextCursor,
      messages: pageRows.map((row) => ({
        id: row.id,
        role: row.role,
        message_kind: 'normal',
        source_session_id: null,
        content_text: row.text,
        created_at: null,
      })),
    });
  });

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

    const [project] = await db.select({ id: projects.id, createdBy: projects.createdBy }).from(projects).where(eq(projects.id, session.projectId)).limit(1);
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

    await piClient.sendMessage(session.piSessionId, content);

    await db.update(sessions).set({ runtimeStatus: 'running', lastActivityAt: now, lastRunAt: now, updatedAt: now }).where(eq(sessions.id, sessionId));

    socketHub.broadcast(createEvent('session.updated', { session_id: sessionId }, { project_id: session.projectId, session_id: sessionId }));
    socketHub.broadcast(createEvent('tree.changed', { project_id: session.projectId }, { project_id: session.projectId }));
    socketHub.sendToSession(sessionId, createEvent('session.runtime_status_changed', { runtime_status: 'running' }, { project_id: session.projectId, session_id: sessionId }));
    socketHub.sendToSession(sessionId, createChatStreamFrame(sessionId, 'start', randomId('stream'), messageId));
    socketHub.sendToSession(sessionId, createChatStreamFrame(sessionId, 'delta', randomId('stream'), messageId, content));
    socketHub.sendToSession(sessionId, createChatStreamFrame(sessionId, 'complete', randomId('stream'), messageId));

    await db.update(sessions).set({ runtimeStatus: 'idle', lastActivityAt: now, updatedAt: now }).where(eq(sessions.id, sessionId));
    socketHub.sendToSession(sessionId, createEvent('session.runtime_status_changed', { runtime_status: 'idle' }, { project_id: session.projectId, session_id: sessionId }));

    return c.json({ accepted: true, session_id: sessionId, message_id: messageId }, 202);
  });

  app.post('/api/v1/sessions/:sessionId/stop', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!session) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const [project] = await db.select({ id: projects.id, createdBy: projects.createdBy }).from(projects).where(eq(projects.id, session.projectId)).limit(1);
    if (!project || project.createdBy !== userId) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    await piClient.stopSession(session.piSessionId);
    log.info('session stopping', { sessionId });
    await createAuditService(db).record(userId, "session.stopped", "session", sessionId);

    const now = nextMessageTime();
    await db.update(sessions).set({ runtimeStatus: 'stopping', lastStopAt: now, updatedAt: now }).where(eq(sessions.id, sessionId));
    socketHub.sendToSession(sessionId, createEvent('session.runtime_status_changed', { runtime_status: 'stopping' }, { project_id: session.projectId, session_id: sessionId }));
    return c.json({ session_id: sessionId, status: 'stopping' }, 202);
  });

  app.post('/api/v1/sessions/:sessionId/archive', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const userId = (c as any).get('userId') as string;
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!session) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const [project] = await db.select({ id: projects.id, createdBy: projects.createdBy }).from(projects).where(eq(projects.id, session.projectId)).limit(1);
    if (!project || project.createdBy !== userId) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const now = nextMessageTime();
    await db.update(sessions).set({ status: 'archived', archivedAt: now, archivedBy: userId, updatedAt: now }).where(eq(sessions.id, sessionId));
    log.info('session archived', { sessionId });
    await createAuditService(db).record(userId, "session.archived", "session", sessionId);
    socketHub.broadcast(createEvent('session.archived', { session_id: sessionId }, { project_id: session.projectId, session_id: sessionId }));
    socketHub.broadcast(createEvent('tree.changed', { project_id: session.projectId }, { project_id: session.projectId }));
    return c.json({ session_id: sessionId, status: 'archived' }, 200);
  });

  registerWebSocketRoutes(app);
}

export function registerSessionMutationRoutes(app: Hono) {
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

    const [project] = await db.select({ id: projects.id, createdBy: projects.createdBy }).from(projects).where(eq(projects.id, session.projectId)).limit(1);
    if (!project || project.createdBy !== userId) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const now = nextMessageTime();
    await db.update(sessions).set({ title, titleSource: 'user', updatedAt: now }).where(eq(sessions.id, sessionId));
    await createAuditService(db).record(userId, "title.changed", "session", sessionId, { old_title: session.title, new_title: title });

    socketHub.broadcast(createEvent('session.updated', { session_id: sessionId }, { project_id: session.projectId, session_id: sessionId }));
    socketHub.broadcast(createEvent('tree.changed', { project_id: session.projectId }, { project_id: session.projectId }));

    return c.json({ session_id: sessionId, title, title_source: 'user' });
  });
}
