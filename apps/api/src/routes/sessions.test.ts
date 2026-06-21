import { describe, expect, test } from 'bun:test';
import { createSeedDb } from '@piplus/db/init';
import { createApp } from '../app';

function makeDbPath() {
  return `/tmp/piplus-api-session-${crypto.randomUUID()}.sqlite`;
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

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'LLM History Project', mode: 'existing', path: '/tmp' }),
    });
    const projectBody = await projectRes.json();
    const sessionId = projectBody.sessionId as string;

    const sendRes = await app.request(`/api/v1/sessions/${sessionId}/chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ content: 'hello from api test' }),
    });
    expect(sendRes.status).toBe(202);

    const pageRes = await app.request(`/api/v1/sessions/${sessionId}/chat/messages?limit=10&cursor=0`, {
      headers: { 'x-user-id': 'user_seed' },
    });
    expect(pageRes.status).toBe(200);
    const page = await pageRes.json();
    expect(Array.isArray(page.messages)).toBe(true);
  });

  test('stop endpoint returns stopping and persists runtime state transition', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Stop Project', mode: 'existing', path: '/tmp' }),
    });
    const projectBody = await projectRes.json();

    const stopRes = await app.request(`/api/v1/sessions/${projectBody.sessionId}/stop`, {
      method: 'POST',
      headers: { 'x-user-id': 'user_seed' },
    });

    expect(stopRes.status).toBe(202);
    const stopBody = await stopRes.json();
    expect(stopBody).toEqual({ session_id: projectBody.sessionId, status: 'stopping' });
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
