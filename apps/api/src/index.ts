import { createApp } from './app';
import { websocket } from 'hono/bun';
import { ensureSeedDb } from './db-context';
import { createLogger } from './lib/logger';

const log = createLogger('api');

ensureSeedDb();
log.info('database seeded');

const app = createApp();
const port = Number(Bun.env.API_PORT ?? 3001);

Bun.serve({
  port,
  fetch: app.fetch,
  websocket,
});

log.info('server started', { port });
