import type { Context, Next } from 'hono';
import { isAuthEnabled, verifyToken } from '../auth/token';
import { getServerConfig } from '../server-config';

export async function requireAuth(c: Context, next: Next) {
  const header = c.req.header('Authorization') ?? '';
  const token = header.replace(/^Bearer\s+/i, '') || c.req.query('token') || '';

  if (token && verifyToken(token)) {
    c.set('userId', 'local-user');
    c.set('userName', 'Piplus');
    return await next();
  }

  // No-auth mode: when APP_PASSWORD is not explicitly set, allow anonymous
  // access immediately so local users pay no extra cost or behavior change.
  if (!isAuthEnabled()) {
    c.set('userId', 'local-user');
    c.set('userName', 'Piplus');
    return await next();
  }

  // Dev-only fallback: allow x-user-id, but ONLY when explicitly opted in via
  // PIPLUS_DEV_AUTH=1 AND not running in production. Without the explicit
  // opt-in flag this was an auth bypass on Docker deployments where NODE_ENV
  // is unset (treated as non-production).
  const config = getServerConfig();
  const headerUserId = c.req.header('x-user-id');
  // Case-insensitive so e.g. NODE_ENV=Production still counts as production.
  if (config.devAuth && (config.nodeEnv ?? '').toLowerCase() !== 'production' && headerUserId) {
    c.set('userId', headerUserId);
    c.set('userName', headerUserId);
    return await next();
  }

  return c.json({ error: { code: 'UNAUTHENTICATED', message: 'Missing or invalid token' } }, 401);
}
