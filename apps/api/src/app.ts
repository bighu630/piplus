import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { cors } from 'hono/cors';
import { registerAuthRoutes } from './auth/routes';
import { requireAuth } from './middleware/auth';
import { registerProjectRoutes } from './routes/projects';
import { registerSessionRoutes, registerSessionMutationRoutes } from './routes/sessions';
import { registerModelRoutes } from './routes/models';
import { registerTreeRoutes } from './routes/tree';

function normalizeOrigin(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed.replace(/\/+$/, '');
  }
  return 'https://' + trimmed;
}

export function createApp() {
  const app = new Hono();
  const configuredOrigin = normalizeOrigin(process.env.PUBLIC_WEB_ORIGIN);

  app.use(
    '*',
    cors({
      origin: (origin) => {
        if (!configuredOrigin) return origin ?? '*';
        if (!origin) return configuredOrigin;
        return origin === configuredOrigin ? configuredOrigin : '';
      },
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

  // Serve web static files with runtime config injection (Docker/production mode)
  if (process.env.PIPLUS_SERVE_WEB === '1') {
    const webRoot = process.env.PIPLUS_WEB_DIST;
    if (webRoot) {
      app.use('/*', async (c, next) => {
        await next();
        if (c.res.headers.get('content-type')?.startsWith('text/html')) {
          c.res.headers.set(
            'Content-Security-Policy',
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws:; img-src 'self' data:; font-src 'self'"
          );
        }
      });
      app.use('/assets/*', serveStatic({ root: webRoot }));
      app.get('*', async (c, next) => {
        const path = c.req.path;
        if (path.startsWith('/api/') || path === '/ws' || path === '/health') {
          await next();
          return;
        }
        const publicOrigin = normalizeOrigin(process.env.PUBLIC_WEB_ORIGIN);
        const indexPath = join(webRoot, 'index.html');
        let html: string;
        try {
          html = readFileSync(indexPath, 'utf-8');
        } catch {
          return c.notFound();
        }
        if (publicOrigin) {
          const apiBaseUrl = publicOrigin;
          const wsBaseUrl = publicOrigin.startsWith('https://')
            ? 'wss://' + publicOrigin.slice(8)
            : publicOrigin.startsWith('http://')
            ? 'ws://' + publicOrigin.slice(7)
            : '';
          const configScript = `<script>window.piplusConfig={apiBaseUrl:"${apiBaseUrl}",wsBaseUrl:"${wsBaseUrl}"}</script>`;
          html = html.replace('</head>', configScript + '</head>');
        }
        return c.html(html);
      });
    }
  }

  return app;
}
