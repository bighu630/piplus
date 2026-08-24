import type { Context, Hono } from 'hono';
import { createToken, isAuthEnabled, verifyPassword, verifyToken } from './token';
import { loginRateLimiter } from './rate-limit';
import { resolveClientIp } from './ip';
import { getServerConfig } from '../server-config';
import { createLogger } from '../lib/logger';

const logger = createLogger('auth');

/**
 * Resolves the direct socket peer address of the request.
 *
 * Under Bun.serve({ fetch: app.fetch }) Hono's env is the Bun Server object,
 * so `requestIP(request)` returns the peer address. The legacy Node adapter
 * fields (`env.remoteAddress` / `env.req.remoteAddress`) are kept as a
 * harmless fallback for non-Bun runtimes.
 */
function getPeerIp(c: Context): string | undefined {
  const env = c.env as Record<string, unknown> | undefined;
  if (typeof env?.requestIP === 'function') {
    try {
      const peer = (env.requestIP as (req: unknown) => { address?: string } | null)(c.req.raw);
      if (peer?.address) return peer.address;
    } catch {
      // Fall through to legacy fields.
    }
  }
  if (typeof env?.remoteAddress === 'string') {
    return env.remoteAddress;
  }
  const nestedReq = (env as { req?: { remoteAddress?: unknown } } | undefined)?.req;
  if (typeof nestedReq?.remoteAddress === 'string') {
    return nestedReq.remoteAddress;
  }
  return undefined;
}

function getClientIp(c: Context): string {
  // TRUST MODEL: x-forwarded-for can be spoofed by the client, so it is only
  // honored when the direct peer is inside a trusted proxy network configured
  // via TRUST_PROXY_CIDRS. Without trusted proxies the peer IP (here: unknown
  // under app.request()-style callers) is used as-is and XFF is ignored.
  return resolveClientIp({
    xff: c.req.header('x-forwarded-for'),
    peerIp: getPeerIp(c),
    trustedCidrs: getServerConfig().trustProxyCidrs,
  });
}

export function registerAuthRoutes(app: Hono) {
  /**
   * @swagger
   * /api/v1/auth/status:
   *   get:
   *     summary: 查询是否启用密码登录
   *     tags: [Auth]
   *     description: 返回 requiresPassword 指示前端是否需要展示登录页。无需认证。
   *     responses:
   *       200:
   *         description: 认证模式。
   */
  app.get('/api/v1/auth/status', (c) => c.json({ requiresPassword: isAuthEnabled() }));

  /**
   * @swagger
   * /api/v1/auth/login:
   *   post:
   *     summary: 本地密码登录
   *     tags: [Auth]
   *     description: 使用本地密码换取访问 Token。
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               password:
   *                 type: string
   *     responses:
   *       200:
   *         description: 登录成功，返回 token 与用户信息。
   *       401:
   *         description: 密码错误。
   *       429:
   *         description: 失败次数过多，已被限流（15 分钟窗口内最多 5 次失败）。
   */
  app.post('/api/v1/auth/login', async (c) => {
    const clientIp = getClientIp(c);
    const key = clientIp;
    if (loginRateLimiter.isLimited(key)) {
      const retryAfterSec = Math.max(1, Math.ceil(loginRateLimiter.retryAfterMs(key) / 1000));
      logger.warn('auth_login_failure', { ip: clientIp, reason: 'rate_limited' });
      return c.json(
        { error: { code: 'RATE_LIMITED', message: 'Too many attempts, try again later' } },
        429,
        { 'Retry-After': String(retryAfterSec) },
      );
    }
    const body = await c.req.json().catch(() => ({}));
    const password = String((body as { password?: string }).password ?? '');
    if (!verifyPassword(password)) {
      loginRateLimiter.recordFailure(key);
      // Structured single-line log for fail2ban-style ingestion.
      logger.warn('auth_login_failure', { ip: clientIp, reason: 'invalid_password' });
      return c.json({ error: { code: 'INVALID_PASSWORD', message: 'Invalid password' } }, 401);
    }
    loginRateLimiter.reset(key);
    const token = createToken();
    return c.json({ token, user: { id: 'local-user', name: 'Piplus' } });
  });

  /**
   * @swagger
   * /api/v1/auth/refresh:
   *   post:
   *     summary: 刷新访问 Token
   *     tags: [Auth]
   *     security:
   *       - bearerAuth: []
   *     description: 使用仍有效的旧 Token 换取新签发的 Token，用于在过期前续期。
   *     responses:
   *       200:
   *         description: 刷新成功，返回新 token 与用户信息。
   *       401:
   *         description: Token 无效或已过期。
   */
  app.post('/api/v1/auth/refresh', async (c) => {
    const header = c.req.header('Authorization') ?? '';
    const token = header.replace(/^Bearer\s+/i, '');
    if (!token || !verifyToken(token)) {
      return c.json({ error: { code: 'UNAUTHENTICATED', message: 'Invalid or expired token' } }, 401);
    }
    const newToken = createToken();
    return c.json({ token: newToken, user: { id: 'local-user', name: 'Piplus' } });
  });

  /**
   * @swagger
   * /api/v1/auth/check:
   *   get:
   *     summary: 校验登录态
   *     tags: [Auth]
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: Token 有效。
   *       401:
   *         description: Token 无效或缺失。
   */
  app.get('/api/v1/auth/check', async (c) => {
    const header = c.req.header('Authorization') ?? '';
    const token = header.replace(/^Bearer\s+/i, '');
    if (!token || !verifyToken(token)) {
      return c.json({ error: { code: 'UNAUTHENTICATED', message: 'Invalid token' } }, 401);
    }
    return c.json({ ok: true, user: { id: 'local-user', name: 'Piplus' } });
  });
}
