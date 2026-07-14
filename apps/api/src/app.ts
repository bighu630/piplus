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
import { registerPackagesRoutes } from './routes/packages';
import { registerRoleTemplateRoutes } from './routes/role-templates';
import { registerTreeRoutes } from './routes/tree';

function normalizeOrigin(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed === '*') return '*';
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed.replace(/\/+$/, '');
  }
  return 'https://' + trimmed;
}

function parseCorsOrigins(): string[] | undefined {
  const raw = process.env.CORS_ORIGINS;
  if (raw === undefined || raw === null) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed === '*') return ['*'];
  return trimmed.split(',')
    .map(s => normalizeOrigin(s.trim()))
    .filter((s): s is string => !!s);
}

export function createApp() {
  const app = new Hono();
  const corsOrigins = parseCorsOrigins();
  const hasWildcardCors = corsOrigins?.includes('*') ?? false;
  const configuredOrigin = normalizeOrigin(process.env.PUBLIC_WEB_ORIGIN);

  let originChecker: (origin: string | undefined) => string;
  if (corsOrigins !== undefined) {
    // CORS_ORIGINS 设置了值（包括空字符串或 *）
    if (hasWildcardCors || corsOrigins.length === 0) {
      // CORS_ORIGINS=* 或 CORS_ORIGINS=",,,"（空条目被过滤后无有效 origin）→ 全部允许
      originChecker = (origin) => origin ?? '*';
    } else {
      const allowedOrigins = corsOrigins;
      originChecker = (origin) => {
        if (!origin) return allowedOrigins[0];
        return allowedOrigins.includes(origin) ? origin : '';
      };
    }
  } else if (configuredOrigin) {
    // 仅设置 PUBLIC_WEB_ORIGIN → 向后兼容的单一 origin 匹配
    originChecker = (origin) => {
      if (!origin) return configuredOrigin;
      return origin === configuredOrigin ? configuredOrigin : '';
    };
  } else {
    // 都没设置 → 全部允许
    originChecker = (origin) => origin ?? '*';
  }

  app.use(
    '*',
    cors({
      origin: originChecker,
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
  app.use('/api/v1/packages/*', requireAuth);
  registerModelRoutes(app);
  app.use('/api/v1/role-templates', requireAuth);
  app.use('/api/v1/role-templates/*', requireAuth);
  registerRoleTemplateRoutes(app);
  registerPackagesRoutes(app);

  // Serve web static files with runtime config injection (Docker/production mode)
  if (process.env.PIPLUS_SERVE_WEB === '1') {
    const webRoot = process.env.PIPLUS_WEB_DIST;
    if (webRoot) {
      app.use('/*', async (c, next) => {
        await next();
        if (c.res.headers.get('content-type')?.startsWith('text/html')) {
          c.res.headers.set(
            'Content-Security-Policy',
            "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws:; img-src 'self' data:; font-src 'self'"
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
        // If a static asset under /assets/ wasn't found by serveStatic above,
        // return 404 instead of falling through to index.html. Returning HTML
        // for a missing JS/CSS file causes the browser to parse HTML as JS,
        // resulting in a silent white-screen.
        if (path.startsWith('/assets/')) {
          return c.notFound();
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
