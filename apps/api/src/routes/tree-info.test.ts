import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createDb } from '@piplus/db/client';
import { createSeedDb } from '@piplus/db/init';
import { sessions } from '@piplus/db/schema';
import { createApp } from '../app';

function makeDbPath(label: string) {
  return `/tmp/piplus-${label}-${crypto.randomUUID()}.sqlite`;
}

describe('tree and session info routes', () => {
  test('tree requires authentication', async () => {
    const path = makeDbPath('tree-auth');
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const treeRes = await app.request('/api/v1/tree');
    expect(treeRes.status).toBe(401);
  });

  test('manual session creation creates a top-level blank session and tree stays backend-shaped', async () => {
    const path = makeDbPath('tree');
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Tree Project', mode: 'existing', path: '/tmp' }),
    });
    const projectBody = await projectRes.json();

    const createBlankRes = await app.request(`/api/v1/projects/${projectBody.projectId}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
    });
    expect(createBlankRes.status).toBe(201);
    const blankBody = await createBlankRes.json();
    expect(blankBody.project_id).toBe(projectBody.projectId);
    expect(blankBody.session_id).toMatch(/^session_/);

    const treeRes = await app.request('/api/v1/tree', {
      headers: { 'x-user-id': 'user_seed' },
    });
    expect(treeRes.status).toBe(200);
    const treeBody = await treeRes.json();
    expect(treeBody.projects).toHaveLength(1);
    expect(treeBody.projects[0].id).toBe(projectBody.projectId);
    expect(treeBody.projects[0].sessions).toHaveLength(2);

    const topLevelIds = treeBody.projects[0].sessions.map((row: { id: string }) => row.id);
    expect(topLevelIds).toContain(projectBody.sessionId);
    expect(topLevelIds).toContain(blankBody.session_id);

    const db = createDb(`file:${path}`);
    const [blankSession] = await db.select().from(sessions).where(eq(sessions.id, blankBody.session_id)).limit(1);
    expect(blankSession?.parentSessionId).toBeNull();
    expect(blankSession?.depth).toBe(0);
    expect(blankSession?.title).toBe('Blank Session');
  });

  test('session info returns the aggregate payload expected by Session Info', async () => {
    const path = makeDbPath('info');
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Info Project', mode: 'existing', path: '/tmp' }),
    });
    const projectBody = await projectRes.json();

    const unauthenticatedRes = await app.request(`/api/v1/sessions/${projectBody.sessionId}/info`);
    expect(unauthenticatedRes.status).toBe(401);

    const infoRes = await app.request(`/api/v1/sessions/${projectBody.sessionId}/info`, {
      headers: { 'x-user-id': 'user_seed' },
    });
    expect(infoRes.status).toBe(200);
    const info = await infoRes.json();

    expect(info.session.id).toBe(projectBody.sessionId);
    expect(info.project.id).toBe(projectBody.projectId);
    expect(info.role_template.key).toBe('planner');
    expect(typeof info.prompts.role_base_prompt_snapshot).toBe('string');
    expect(typeof info.prompts.compiled_prompt).toBe('string');
    expect(info.lineage.root_session.id).toBe(projectBody.sessionId);
    expect(Array.isArray(info.recent_events)).toBe(true);
    expect(info.sync).toEqual({
      sync_status: 'idle',
      last_synced_at: null,
      last_pi_message_id: null,
      last_error: null,
      retry_count: 0,
    });
  });
});
