import type { Context, Next } from 'hono';
import { getAuth } from '../auth/better-auth';

export async function requireAuth(c: Context, next: Next) {
  const auth = getAuth();
  if (!auth) {
    return c.json({ error: { code: 'UNAUTHENTICATED', message: 'Auth service unavailable' } }, 503);
  }
  let userId: string | undefined;
  let userName: string | undefined;

  const session = await (auth as any).api.getSession({ headers: c.req.raw.headers }).catch(() => null);
  if (session?.user?.id) {
    userId = session.user.id;
    userName = session.user.name ?? session.user.email;
  }

  // Fallback: allow x-user-id for dev / test
  if (!userId) {
    const headerUserId = c.req.header('x-user-id');
    if (headerUserId && Bun.env.NODE_ENV !== 'production') {
      userId = headerUserId;
      userName = headerUserId;
    }
  }

  if (!userId) {
    return c.json({ error: { code: 'UNAUTHENTICATED', message: 'Missing user session' } }, 401);
  }

  c.set('userId', userId);
  c.set('userName', userName ?? userId);
  await next();
}
