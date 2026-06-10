import { upgradeWebSocket } from 'hono/bun';
import type { Hono } from 'hono';
import { createEvent, parseClientMessage } from './protocol';
import { registerSocket } from './session';
import { getAuth } from '../auth/better-auth';

const socketHub = registerSocket();

export function registerWebSocketRoutes(app: Hono) {
  app.get('/ws', upgradeWebSocket((c) => ({
    async onOpen(_evt, ws) {
      // validate session
      const auth = getAuth();
      if (auth) {
        const session = await (auth as any).api.getSession({ headers: c.req.raw.headers }).catch(() => null);
        const userId = session?.user?.id ?? c.req.header('x-user-id');
        if (userId) {
          (ws as any).__userId = userId;
        }
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
