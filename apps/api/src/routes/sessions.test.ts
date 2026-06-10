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
      body: JSON.stringify({ name: 'Private Session Project' }),
    });
    const projectBody = await projectRes.json();

    const historyRes = await app.request(`/api/v1/sessions/${projectBody.sessionId}/chat/messages?limit=2&cursor=0`);
    expect(historyRes.status).toBe(401);
  });

  test('message history supports cursor pagination', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Paged Project' }),
    });
    const projectBody = await projectRes.json();
    const sessionId = projectBody.sessionId as string;

    const sendOne = await app.request(`/api/v1/sessions/${sessionId}/chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ content: 'one' }),
    });
    const sendTwo = await app.request(`/api/v1/sessions/${sessionId}/chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ content: 'two' }),
    });
    const sendThree = await app.request(`/api/v1/sessions/${sessionId}/chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ content: 'three' }),
    });
    expect(sendOne.status).toBe(202);
    expect(sendTwo.status).toBe(202);
    expect(sendThree.status).toBe(202);

    const page1Res = await app.request(`/api/v1/sessions/${sessionId}/chat/messages?limit=2&cursor=0`, {
      headers: { 'x-user-id': 'user_seed' },
    });
    expect(page1Res.status).toBe(200);
    const page1 = await page1Res.json();
    expect(page1.messages).toHaveLength(2);
    expect(page1.messages.map((row: { content_text: string }) => row.content_text)).toEqual(['one', 'one']);
    expect(page1.next_cursor).toBeTruthy();

    const page2Res = await app.request(`/api/v1/sessions/${sessionId}/chat/messages?limit=2&cursor=${encodeURIComponent(page1.next_cursor)}`, {
      headers: { 'x-user-id': 'user_seed' },
    });
    const page2 = await page2Res.json();
    expect(page2.messages).toHaveLength(2);
    expect(page2.messages.map((row: { content_text: string }) => row.content_text)).toEqual(['two', 'two']);
    expect(page2.next_cursor).toBeTruthy();

    const page3Res = await app.request(`/api/v1/sessions/${sessionId}/chat/messages?limit=2&cursor=${encodeURIComponent(page2.next_cursor)}`, {
      headers: { 'x-user-id': 'user_seed' },
    });
    const page3 = await page3Res.json();
    expect(page3.messages).toHaveLength(2);
    expect(page3.messages.map((row: { content_text: string }) => row.content_text)).toEqual(['three', 'three']);
    expect(page3.next_cursor).toBeNull();
  });

  test('stop endpoint returns stopping and persists runtime state transition', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Stop Project' }),
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
      body: JSON.stringify({ name: 'Title Project' }),
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
