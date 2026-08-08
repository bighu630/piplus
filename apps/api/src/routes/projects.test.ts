import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createDb } from '@piplus/db/client';
import { createSeedDb } from '@piplus/db/init';
import { projects, sessions } from '@piplus/db/schema';
import { createApp } from '../app';
import { createPiClient } from '@piplus/pi-client';
import { getDbPath } from '../db-context';

async function withPasswordAuth<T>(fn: () => T | Promise<T>): Promise<T> {
  const prev = Bun.env.APP_PASSWORD;
  Bun.env.APP_PASSWORD = 'test-secret';
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete Bun.env.APP_PASSWORD;
    else Bun.env.APP_PASSWORD = prev;
  }
}

function makeDbPath() {
  return `/tmp/piplus-api-project-${crypto.randomUUID()}.sqlite`;
}

describe('project routes', () => {
  test('create project requires authentication', () =>
    withPasswordAuth(async () => {
      const path = makeDbPath();
      createSeedDb(path);
      Bun.env.DATABASE_URL = `file:${path}`;
      const app = createApp();

      const res = await app.request('/api/v1/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'API Project' }),
      });

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: { code: 'UNAUTHENTICATED', message: 'Missing or invalid token' },
      });
    }));

  test('create project auto-creates a planner session with requested model', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();
    const models = await createPiClient().listAvailableModels();
    const target = models.at(-1) ?? models[0];
    expect(target).toBeTruthy();
    const res = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({
        name: 'API Project',
        mode: 'existing',
        path: '/tmp',
        model: { provider: target.provider, id: target.id },
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.projectId).toMatch(/^project_/);
    expect(body.sessionId).toMatch(/^session_/);

    const db = createDb(`file:${path}`);
    const [project] = await db.select().from(projects).where(eq(projects.id, body.projectId)).limit(1);
    const [session] = await db.select().from(sessions).where(eq(sessions.id, body.sessionId)).limit(1);
    expect(project?.name).toBe('API Project');
    expect(session?.parentSessionId).toBeNull();
    expect(session?.currentModelProvider).toBe(target.provider);
    expect(session?.currentModelId).toBe(target.id);
    expect(session?.piSessionLocatorJson).toContain('sessionFile');
  });
});
