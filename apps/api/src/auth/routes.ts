import type { Hono } from 'hono';
import { getAuth } from './better-auth';

export function registerAuthRoutes(app: Hono) {
  const auth = getAuth();
  if (!auth) return;
  app.all('/api/v1/auth/*', (c) => auth.handler(c.req.raw));
}
