import { createApp } from './app';
import { websocket } from 'hono/bun';
import { ensureSeedDb, recoverStuckSessions } from './db-context';
import { createLogger } from './lib/logger';
import { getServerConfig } from './server-config';

const log = createLogger('api');

ensureSeedDb();
log.info('database seeded');

recoverStuckSessions();
log.info('stuck sessions recovered');

const app = createApp();
const config = getServerConfig();

Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch: app.fetch,
  websocket,
});

log.info('server started', {
  host: config.host,
  port: config.port,
  databasePath: config.databasePath,
  projectsRoot: config.projectsRoot,
});
