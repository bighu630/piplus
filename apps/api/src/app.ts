import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { registerAuthRoutes } from './auth/routes';
import { requireAuth } from './middleware/auth';
import { registerProjectRoutes } from './routes/projects';
import { registerSessionRoutes, registerSessionMutationRoutes } from './routes/sessions';
import { registerModelRoutes } from './routes/models';
import { registerTreeRoutes } from './routes/tree';

export function createApp() {
  const app = new Hono();

  app.use(
    '*',
    cors({
      origin: (origin) => origin ?? '*',
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'x-user-id', 'Authorization'],
      credentials: false,
    }),
  );

  app.get('/health', (c) => c.json({ ok: true }));
  registerAuthRoutes(app);
  app.use('/api/v1/tree', requireAuth);
  app.use('/api/v1/projects', requireAuth);
  app.use('/api/v1/projects/*', requireAuth);
  app.use('/api/v1/sessions/*', requireAuth);
  app.use('/api/v1/models', requireAuth);
  registerTreeRoutes(app);
  registerProjectRoutes(app);
  registerSessionRoutes(app);
  registerSessionMutationRoutes(app);
  registerModelRoutes(app);
  return app;
}
