import type { Hono } from 'hono';
import { createToken, isAuthEnabled, verifyPassword, verifyToken } from './token';

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
   */
  app.post('/api/v1/auth/login', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const password = String((body as { password?: string }).password ?? '');
    if (!verifyPassword(password)) {
      return c.json({ error: { code: 'INVALID_PASSWORD', message: 'Invalid password' } }, 401);
    }
    const token = createToken();
    return c.json({ token, user: { id: 'local-user', name: 'Piplus' } });
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
