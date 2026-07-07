import { upgradeWebSocket } from 'hono/bun';
import type { Hono } from 'hono';
import { createEvent, parseClientMessage } from './protocol';
import { registerSocket } from './session';
import { verifyToken } from '../auth/token';
import { TerminalManager } from '../lib/terminal-manager';
import { createDb } from '@piplus/db/client';
import { projects, sessions } from '@piplus/db/schema';
import { eq, and } from 'drizzle-orm';
import { getDbPath } from '../db-context';

const socketHub = registerSocket();

// Track which terminal sessions belong to each WebSocket connection
// so we can clean up per-connection on disconnect
const connectionTerminals = new WeakMap<object, Set<string>>();

const terminalManager = new TerminalManager(
  (sessionId, data) => {
    // Broadcast terminal_output to all connected sockets
    socketHub.broadcast({
      kind: 'terminal',
      type: 'terminal_output',
      payload: { sessionId, data },
    });
  },
  (sessionId, code) => {
    socketHub.broadcast({
      kind: 'terminal',
      type: 'terminal_exit',
      payload: { sessionId, code },
    });
  },
);

export function registerWebSocketRoutes(app: Hono) {
  /**
   * @swagger
   * /ws:
   *   get:
   *     summary: 建立 WebSocket 实时连接
   *     tags: [WebSocket]
   *     description: |
   *       连接建立后会立即下发 connection.opened 事件。
   *       客户端可发送 hello、set_context、ping 三类消息。
   *       服务端会下发 event 与 chat_stream 两类消息。
   */
  app.get('/ws', upgradeWebSocket((c) => ({
    async onOpen(_evt, ws) {
      const rawHeaders = c.req.raw.headers;
      const header = rawHeaders.get('Authorization') ?? '';
      const token = header.replace(/^Bearer\s+/i, '');
      const userId = verifyToken(token) ? 'local-user' : c.req.header('x-user-id');
      if (userId) {
        (ws as any).__userId = userId;
      }
      socketHub.attach(ws);
      ws.send(JSON.stringify(createEvent('connection.opened', { status: 'ok' })));
    },
    async onMessage(evt, ws) {
      const raw = typeof evt.data === 'string' ? evt.data : '';
      const parsed = parseClientMessage(raw);
      if (!parsed) return;
      socketHub.handleClientMessage(ws, parsed);

      if (parsed.type === 'hello') {
        ws.send(JSON.stringify(createEvent('connection.hello', { user_agent: parsed.payload.user_agent ?? null })));
      }

      if (parsed.type === 'set_context') {
        socketHub.setContext(ws, parsed.payload);
        ws.send(JSON.stringify(createEvent('context.updated', parsed.payload)));
      }

      if (parsed.type === 'ping') {
        ws.send(JSON.stringify(createEvent('connection.pong', { timestamp: parsed.payload.timestamp })));
      }

      // Terminal message handling
      if (parsed.type === 'terminal_start') {
        try {
          const { sessionId, cols, rows } = (parsed as any).payload as { sessionId: string; cols: number; rows: number };
          const db = createDb(`file:${getDbPath()}`);
          const [row] = await db
            .select({ projectPath: projects.projectPath })
            .from(projects)
            .innerJoin(sessions, eq(sessions.projectId, projects.id))
            .where(and(eq(sessions.id, sessionId), eq(projects.createdBy, (ws as any).__userId ?? 'local-user')))
            .limit(1);
          if (row) {
            // Security: restrict cwd to allowed workspace paths
            const allowedPrefixes = ['/workspace', '/data/code'].filter(Boolean);
            const isAllowed = allowedPrefixes.some(prefix => row.projectPath.startsWith(prefix));
            if (isAllowed) {
              terminalManager.start(sessionId, row.projectPath, cols, rows);
              // Track this terminal session for this connection
              let sessions = connectionTerminals.get(ws);
              if (!sessions) {
                sessions = new Set();
                connectionTerminals.set(ws, sessions);
              }
              sessions.add(sessionId);
            }
          }
        } catch (err) {
          console.error('[Terminal] Failed to start terminal:', err);
        }
      }

      if (parsed.type === 'terminal_input') {
        const { sessionId, data } = (parsed as any).payload as { sessionId: string; data: string };
        terminalManager.write(sessionId, data);
      }

      if (parsed.type === 'terminal_resize') {
        const { sessionId, cols, rows } = (parsed as any).payload as { sessionId: string; cols: number; rows: number };
        terminalManager.resize(sessionId, cols, rows);
      }

      if (parsed.type === 'terminal_stop') {
        const { sessionId } = (parsed as any).payload as { sessionId: string };
        terminalManager.stop(sessionId);
        // Remove from per-connection tracking
        const sessions = connectionTerminals.get(ws);
        if (sessions) {
          sessions.delete(sessionId);
        }
      }
    },
    onClose(_evt, ws) {
      socketHub.detach(ws);
      // Clean up only this connection's terminal sessions
      const terminalSessionIds = connectionTerminals.get(ws);
      if (terminalSessionIds) {
        for (const sessionId of terminalSessionIds) {
          terminalManager.stop(sessionId);
        }
        connectionTerminals.delete(ws);
      }
    },
  })));
}

export { socketHub, terminalManager };
