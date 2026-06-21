import { upgradeWebSocket } from 'hono/bun';
import type { Hono } from 'hono';
import { createEvent, parseClientMessage } from './protocol';
import { registerSocket } from './session';
import { verifyToken } from '../auth/token';

const socketHub = registerSocket();

export function registerWebSocketRoutes(app: Hono) {
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
    onMessage(evt, ws) {
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
    },
    onClose(_evt, ws) {
      socketHub.detach(ws);
    },
  })));
}

export { socketHub };
