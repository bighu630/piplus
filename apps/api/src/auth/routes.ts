import type { Context, Hono } from 'hono';
import { createToken, isAuthEnabled, verifyPassword, verifyToken } from './token';
import { getClientIp, loginRateLimiter } from './rate-limit';

function getLoginKey(c: Context): string {
  const env = c.env as Record<string, unknown> | undefined;
  let remoteAddress: string | undefined;
  if (typeof env?.remoteAddress === 'string') {
    remoteAddress = env.remoteAddress;
  } else if (
    typeof (env as { req?: { remoteAddress?: unknown } } | undefined)?.req?.remoteAddress === 'string'
  ) {
    remoteAddress = (env as { req: { remoteAddress: string } }).req.remoteAddress;
  }
  // TRUST MODEL: x-forwarded-for can be spoofed by the client, so this rate
  // limiting key is only reliable behind a trusted reverse proxy (which
  // overwrites the header) or for local/loopback deployments. When exposed
  // directly to the public internet, rely on network-level protections.
  return getClientIp(c.req.header('x-forwarded-for'), remoteAddress);
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
    const key = getLoginKey(c);
    if (loginRateLimiter.isLimited(key)) {
      return c.json(
        { error: { code: 'RATE_LIMITED', message: 'Too many attempts, try again later' } },
        429,
      );
    }
    const body = await c.req.json().catch(() => ({}));
    const password = String((body as { password?: string }).password ?? '');
    if (!verifyPassword(password)) {
      loginRateLimiter.recordFailure(key);
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
