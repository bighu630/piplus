import { createSeedDb } from '@piplus/db/init';
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createDb } from '@piplus/db/client';
import { messages, sessions } from '@piplus/db/schema';
import { createPiClient } from '@piplus/pi-client';
import { createApp } from '../app';

const imageCapableModelPromise = createPiClient().listAvailableModels().then((models) => models.at(-1) ?? models[0]);

function makeDbPath() {
  return `/tmp/piplus-api-session-${crypto.randomUUID()}.sqlite`;
}

async function createImageCapableSession(app: ReturnType<typeof createApp>, name: string) {
  const target = await imageCapableModelPromise;
  expect(target).toBeTruthy();

  const projectRes = await app.request('/api/v1/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
    body: JSON.stringify({
      name,
      mode: 'existing',
      path: '/tmp',
      model: { provider: target.provider, id: target.id },
    }),
  });
  expect(projectRes.status).toBe(201);
  return projectRes.json();
}

describe('session routes', () => {
  test('chat message history requires authentication', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Private Session Project', mode: 'existing', path: '/tmp' }),
    });
    const projectBody = await projectRes.json();

    const historyRes = await app.request(`/api/v1/sessions/${projectBody.sessionId}/chat/messages?limit=2&cursor=0`);
    expect(historyRes.status).toBe(401);
  });

  test('message history returns user and assistant messages from pi session file', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const projectBody = await createImageCapableSession(app, 'LLM History Project');
    const sessionId = projectBody.sessionId as string;

    const sendRes = await app.request(`/api/v1/sessions/${sessionId}/chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({
        content: 'hello from api test',
        attachments: [{
          type: 'image',
          mime_type: 'image/png',
          data_base64: Buffer.from('fake-image').toString('base64'),
          filename: 'test.png',
        }],
      }),
    });
    expect(sendRes.status).toBe(202);

    const pageRes = await app.request(`/api/v1/sessions/${sessionId}/chat/messages?limit=10&cursor=0`, {
      headers: { 'x-user-id': 'user_seed' },
    });
    expect(pageRes.status).toBe(200);
    const page = await pageRes.json();
    expect(Array.isArray(page.messages)).toBe(true);
    for (const message of page.messages) {
      expect(message).toHaveProperty('content_text');
      expect(message).toHaveProperty('content_blocks');
    }

    const db = createDb(`file:${path}`);
    const rows = await db.select().from(messages).where(eq(messages.sessionId, sessionId));
    const userMessage = rows.find((row) => row.role === 'user' && row.contentText === 'hello from api test');
    expect(userMessage?.contentBlocksJson).toContain('hello from api test');
    expect(userMessage?.contentBlocksJson).toContain('image/png');
    expect(userMessage?.contentBlocksJson).toContain('test.png');
  });

  test('chat messages accept image-only content and persist structured blocks', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const projectBody = await createImageCapableSession(app, 'Image Only Project');
    const sessionId = projectBody.sessionId as string;

    const sendRes = await app.request(`/api/v1/sessions/${sessionId}/chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({
        content: '',
        attachments: [{
          type: 'image',
          mime_type: 'image/png',
          data_base64: Buffer.from('image-only').toString('base64'),
          filename: 'only.png',
        }],
      }),
    });
    expect(sendRes.status).toBe(202);

    const db = createDb(`file:${path}`);
    const rows = await db.select().from(messages).where(eq(messages.sessionId, sessionId));
    const userMessage = rows.find((row) => row.role === 'user');
    expect(userMessage?.contentText).toBe('');
    expect(userMessage?.contentBlocksJson).toContain('image');
  });

  test('chat messages reject more than four image attachments', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Attachment Limit Project', mode: 'existing', path: '/tmp' }),
    });
    const projectBody = await projectRes.json();
    const sessionId = projectBody.sessionId as string;

    const attachments = Array.from({ length: 5 }, (_, index) => ({
      type: 'image',
      mime_type: 'image/png',
      data_base64: Buffer.from(`img-${index}`).toString('base64'),
      filename: `img-${index}.png`,
    }));

    const sendRes = await app.request(`/api/v1/sessions/${sessionId}/chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ content: 'too many', attachments }),
    });
    expect(sendRes.status).toBe(400);
    expect(await sendRes.json()).toMatchObject({ error: { code: 'TOO_MANY_ATTACHMENTS' } });
  });

  test('chat messages reject images for models without image support', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Text Only Model Project', mode: 'existing', path: '/tmp' }),
    });
    const projectBody = await projectRes.json();
    const sessionId = projectBody.sessionId as string;

    const sendRes = await app.request(`/api/v1/sessions/${sessionId}/chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({
        content: 'describe this',
        attachments: [{
          type: 'image',
          mime_type: 'image/png',
          data_base64: Buffer.from('blocked').toString('base64'),
          filename: 'blocked.png',
        }],
      }),
    });
    expect(sendRes.status).toBe(400);
    expect(await sendRes.json()).toMatchObject({ error: { code: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } });
  });

  test('create top-level session inherits project planner model', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();
    const models = await createPiClient().listAvailableModels();
    const target = models.at(-1) ?? models[0];
    expect(target).toBeTruthy();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({
        name: 'Inherited Session Project',
        mode: 'existing',
        path: '/tmp',
        model: { provider: target.provider, id: target.id },
      }),
    });
    const projectBody = await projectRes.json();

    const createSessionRes = await app.request(`/api/v1/projects/${projectBody.projectId}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({}),
    });
    expect(createSessionRes.status).toBe(201);
    const createdSession = await createSessionRes.json();

    const infoRes = await app.request(`/api/v1/sessions/${createdSession.session_id}/info`, {
      headers: { 'x-user-id': 'user_seed' },
    });
    expect(infoRes.status).toBe(200);
    const info = await infoRes.json();
    expect(info.session.current_model).toMatchObject({
      provider: target.provider,
      id: target.id,
    });

    const db = createDb(`file:${path}`);
    const [createdRow] = await db.select().from(sessions).where(eq(sessions.id, createdSession.session_id)).limit(1);
    expect(createdRow?.currentModelProvider).toBe(target.provider);
    expect(createdRow?.currentModelId).toBe(target.id);
  });

  test('set session model persists DB mirror and is returned by session info', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Model Mirror Project', mode: 'existing', path: '/tmp' }),
    });
    const projectBody = await projectRes.json();
    const sessionId = projectBody.sessionId as string;

    const modelsRes = await app.request('/api/v1/models', {
      headers: { 'x-user-id': 'user_seed' },
    });
    expect(modelsRes.status).toBe(200);
    const modelsBody = await modelsRes.json();
    const target = modelsBody.models.at(-1) ?? modelsBody.models[0];
    expect(target).toBeTruthy();

    const setModelRes = await app.request(`/api/v1/sessions/${sessionId}/model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ provider: target.provider, id: target.id }),
    });
    expect(setModelRes.status).toBe(200);

    const infoRes = await app.request(`/api/v1/sessions/${sessionId}/info`, {
      headers: { 'x-user-id': 'user_seed' },
    });
    expect(infoRes.status).toBe(200);
    const info = await infoRes.json();
    expect(info.session.current_model).toMatchObject({
      provider: target.provider,
      id: target.id,
    });
  });

  test('patch session title updates the title', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Title Project', mode: 'existing', path: '/tmp' }),
    });
    const projectBody = await projectRes.json();

    const patchRes = await app.request(`/api/v1/sessions/${projectBody.sessionId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ title: 'Renamed Session' }),
    });
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json();
    expect(patchBody.title).toBe('Renamed Session');
    expect(patchBody.title_source).toBe('user');

    const infoRes = await app.request(`/api/v1/sessions/${projectBody.sessionId}/info`, {
      headers: { 'x-user-id': 'user_seed' },
    });
    const info = await infoRes.json();
    expect(info.session.title).toBe('Renamed Session');
  });

  test('patch session title requires authentication', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const res = await app.request('/api/v1/sessions/session_nonexistent', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'No Auth' }),
    });
    expect(res.status).toBe(401);
  });
});
