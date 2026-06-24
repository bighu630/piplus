import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
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
  registerTreeRoutes(app);
  registerProjectRoutes(app);
  registerSessionRoutes(app);
  registerSessionMutationRoutes(app);
  registerModelRoutes(app);

  // Serve web static files when running in desktop mode
  if (process.env.PIPLUS_SERVE_WEB === '1') {
    const webRoot = process.env.PIPLUS_WEB_DIST;
    if (webRoot) {
      app.use('/*', async (c, next) => {
        await next();
        c.res.headers.set(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws:; img-src 'self' data:; font-src 'self'"
        );
      });
      app.use('/*', serveStatic({ root: webRoot }));
    }
  }

  return app;
}
