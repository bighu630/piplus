import type { Hono } from 'hono';
import { createToken, verifyPassword, verifyToken } from './token';

export function registerAuthRoutes(app: Hono) {
  app.post('/api/v1/auth/login', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const password = String((body as { password?: string }).password ?? '');
    if (!verifyPassword(password)) {
      return c.json({ error: { code: 'INVALID_PASSWORD', message: 'Invalid password' } }, 401);
    }
    const token = createToken();
    return c.json({ token, user: { id: 'local-user', name: 'Piplus' } });
  });

  app.get('/api/v1/auth/check', async (c) => {
    const header = c.req.header('Authorization') ?? '';
    const token = header.replace(/^Bearer\s+/i, '');
    if (!token || !verifyToken(token)) {
      return c.json({ error: { code: 'UNAUTHENTICATED', message: 'Invalid token' } }, 401);
    }
    return c.json({ ok: true, user: { id: 'local-user', name: 'Piplus' } });
  });
}
