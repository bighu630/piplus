import type { Hono } from 'hono';
import { createPiClient } from '@piplus/pi-client';

export function registerModelRoutes(app: Hono) {
  const piClient = createPiClient();

  /**
   * @swagger
   * /api/v1/models/status:
   *   get:
   *     summary: 登录前检查模型状态
   *     tags: [Models]
   *     responses:
   *       200:
   *         description: 返回可用模型数量与列表。
   */
  app.get('/api/v1/models/status', async (c) => {
    const models = await piClient.listAvailableModels();
    return c.json({ ok: models.length > 0, count: models.length, models });
  });

  /**
   * @swagger
   * /api/v1/models:
   *   get:
   *     summary: 获取可用模型列表
   *     tags: [Models]
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: 返回可用模型列表。
   */
  app.get('/api/v1/models', async (c) => {
    const models = await piClient.listAvailableModels();
    return c.json({ models });
  });
}
