import type { Hono } from 'hono';
import { createPiClient } from '@piplus/pi-client';

export function registerModelRoutes(app: Hono) {
  const piClient = createPiClient();
  app.get('/api/v1/models', async (c) => {
    const models = await piClient.listAvailableModels();
    return c.json({ models });
  });
}
