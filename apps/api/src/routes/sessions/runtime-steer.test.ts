import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createDb } from '@piplus/db/client';
import { createSeedDb } from '@piplus/db/init';
import { messages, sessions } from '@piplus/db/schema';
import { createPiClient } from '@piplus/pi-client';
import { createApp } from '../../app';

/**
 * 运行中插话（steer）路由行为：
 * - 开关关闭 + running → 保持 409 SESSION_BUSY（不破坏既有契约）
 * - 开关开启 + running → steer 入队并返回 202，且不落 messages 表
 * - stopping → 一律 409，不注入
 * - 运行中带图片 → 400（本期只支持纯文本）
 * - runtime 缺失（重启后 DB 仍 running）→ 409 SESSION_RUNTIME_UNAVAILABLE
 */

function makeDbPath() {
  return `/tmp/piplus-api-runtime-steer-${crypto.randomUUID()}.sqlite`;
}

const AUTH_HEADERS = { 'content-type': 'application/json', 'x-user-id': 'user_seed' };

type SteerCall = { sessionId: string; content: string };

async function setup(opts: { runtimeStatus?: string; steerError?: string } = {}) {
  const path = makeDbPath();
  createSeedDb(path);
  Bun.env.DATABASE_URL = `file:${path}`;

  const steers: SteerCall[] = [];
  const realClient = createPiClient();
  const stubClient = new Proxy(realClient, {
    get(target, prop, receiver) {
      if (prop === 'steerSession') {
        return async (sessionId: string, content: string) => {
          if (opts.steerError) {
            throw new Error(opts.steerError);
          }
          steers.push({ sessionId, content });
          return { sessionId, queued: steers.length };
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const app = createApp({ piClient: stubClient });
  const projectRes = await app.request('/api/v1/projects', {
    method: 'POST',
    headers: AUTH_HEADERS,
    body: JSON.stringify({ name: 'Runtime Steer', mode: 'existing', path: '/tmp' }),
  });
  expect(projectRes.status).toBe(201);
  const sessionId = (await projectRes.json()).sessionId as string;

  if (opts.runtimeStatus && opts.runtimeStatus !== 'idle') {
    const db = createDb(`file:${path}`);
    await db.update(sessions).set({ runtimeStatus: opts.runtimeStatus }).where(eq(sessions.id, sessionId));
  }

  return { app, sessionId, steers, dbPath: path };
}

function sendBody(content = '插一句话') {
  return {
    method: 'POST',
    headers: AUTH_HEADERS,
    body: JSON.stringify({ content }),
  };
}

async function enableSetting(app: ReturnType<typeof createApp>) {
  const res = await app.request('/api/v1/settings', {
    method: 'PUT',
    headers: AUTH_HEADERS,
    body: JSON.stringify({ allow_runtime_message_injection: 'true' }),
  });
  expect(res.status).toBe(200);
}

describe('runtime message injection (steer)', () => {
  test('running + setting off → 409 SESSION_BUSY, no steer', async () => {
    const { app, sessionId, steers } = await setup({ runtimeStatus: 'running' });

    const res = await app.request(`/api/v1/sessions/${sessionId}/chat/messages`, sendBody());

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('SESSION_BUSY');
    expect(steers).toHaveLength(0);
  });

  test('running + setting explicitly false → 409 SESSION_BUSY, no steer', async () => {
    const { app, sessionId, steers } = await setup({ runtimeStatus: 'running' });
    const res0 = await app.request('/api/v1/settings', {
      method: 'PUT',
      headers: AUTH_HEADERS,
      body: JSON.stringify({ allow_runtime_message_injection: 'false' }),
    });
    expect(res0.status).toBe(200);

    const res = await app.request(`/api/v1/sessions/${sessionId}/chat/messages`, sendBody());

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('SESSION_BUSY');
    expect(steers).toHaveLength(0);
  });

  test('running + setting on + slash command → 400, not steered as literal text', async () => {
    const { app, sessionId, steers } = await setup({ runtimeStatus: 'running' });
    await enableSetting(app);

    const res = await app.request(`/api/v1/sessions/${sessionId}/chat/messages`, sendBody('/compact'));

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('RUNTIME_SLASH_COMMAND_UNSUPPORTED');
    expect(steers).toHaveLength(0);
  });

  test('running + setting on → 202 steered, message not persisted', async () => {
    const { app, sessionId, steers, dbPath } = await setup({ runtimeStatus: 'running' });
    await enableSetting(app);

    const res = await app.request(`/api/v1/sessions/${sessionId}/chat/messages`, sendBody('改成用 steer'));

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.steered).toBe(true);
    expect(body.session_id).toBe(sessionId);
    expect(steers).toEqual([{ sessionId, content: '改成用 steer' }]);

    // steer 走 pi 队列，不落 messages 表（避免 GET /chat/messages 出现重复行）
    const db = createDb(`file:${dbPath}`);
    const rows = await db.select().from(messages).where(eq(messages.sessionId, sessionId));
    expect(rows).toHaveLength(0);
  });

  test('stopping + setting on → 409 SESSION_BUSY, no steer', async () => {
    const { app, sessionId, steers } = await setup({ runtimeStatus: 'stopping' });
    await enableSetting(app);

    const res = await app.request(`/api/v1/sessions/${sessionId}/chat/messages`, sendBody());

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('SESSION_BUSY');
    expect(steers).toHaveLength(0);
  });

  test('running + setting on + image attachment → 400 text-only', async () => {
    const { app, sessionId, steers } = await setup({ runtimeStatus: 'running' });
    await enableSetting(app);

    const res = await app.request(`/api/v1/sessions/${sessionId}/chat/messages`, {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        content: '带图插话',
        attachments: [{
          type: 'image',
          mime_type: 'image/png',
          data_base64: Buffer.from('x').toString('base64'),
          filename: 'x.png',
        }],
      }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('RUNTIME_INJECTION_TEXT_ONLY');
    expect(steers).toHaveLength(0);
  });

  test('running + setting on but no live runtime → 409 SESSION_RUNTIME_UNAVAILABLE', async () => {
    const { app, sessionId, steers } = await setup({
      runtimeStatus: 'running',
      steerError: 'pi_session_runtime_unavailable',
    });
    await enableSetting(app);

    const res = await app.request(`/api/v1/sessions/${sessionId}/chat/messages`, sendBody());

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('SESSION_RUNTIME_UNAVAILABLE');
    expect(steers).toHaveLength(0);
  });

  test('running + setting on but stop was requested → 409 SESSION_BUSY', async () => {
    const { app, sessionId, steers } = await setup({ runtimeStatus: 'running', steerError: 'session_stopped' });
    await enableSetting(app);

    const res = await app.request(`/api/v1/sessions/${sessionId}/chat/messages`, sendBody());

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('SESSION_BUSY');
    expect(steers).toHaveLength(0);
  });

  test('running + setting on but run already ended → 409 SESSION_NOT_STREAMING', async () => {
    const { app, sessionId, steers } = await setup({ runtimeStatus: 'running', steerError: 'session_not_streaming' });
    await enableSetting(app);

    const res = await app.request(`/api/v1/sessions/${sessionId}/chat/messages`, sendBody());

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('SESSION_NOT_STREAMING');
    expect(steers).toHaveLength(0);
  });
});
