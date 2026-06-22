import type { Hono } from 'hono';
import { createPiClient } from '@piplus/pi-client';

export function registerModelRoutes(app: Hono) {
  const piClient = createPiClient();

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
