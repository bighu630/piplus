import type { Context, Next } from 'hono';
import { verifyToken } from '../auth/token';
import { getServerConfig } from '../server-config';

export async function requireAuth(c: Context, next: Next) {
  const header = c.req.header('Authorization') ?? '';
  const token = header.replace(/^Bearer\s+/i, '') || c.req.query('token') || '';

  if (token && verifyToken(token)) {
    c.set('userId', 'local-user');
    c.set('userName', 'Piplus');
    return await next();
  }

  // Fallback: allow x-user-id for dev / test
  const headerUserId = c.req.header('x-user-id');
  if (headerUserId && getServerConfig().nodeEnv !== 'production') {
    c.set('userId', headerUserId);
    c.set('userName', headerUserId);
    return await next();
  }

  return c.json({ error: { code: 'UNAUTHENTICATED', message: 'Missing or invalid token' } }, 401);
}
