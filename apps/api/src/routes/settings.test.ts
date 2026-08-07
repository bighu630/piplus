import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createDb } from '@piplus/db/client';
import { createSeedDb } from '@piplus/db/init';
import { settings } from '@piplus/db/schema';
import { createApp } from '../app';

function makeDbPath() {
  return `/tmp/piplus-api-settings-${crypto.randomUUID()}.sqlite`;
}

const AUTH_HEADERS = { 'content-type': 'application/json', 'x-user-id': 'user_seed' };

describe('settings routes', () => {
  test('GET returns empty object when table is empty', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const res = await app.request('/api/v1/settings', {
      method: 'GET',
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  test('PUT with unknown key returns 400', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const res = await app.request('/api/v1/settings', {
      method: 'PUT',
      headers: AUTH_HEADERS,
      body: JSON.stringify({ some_unknown_key: 1 }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'VALIDATION_ERROR', message: '未知设置项: some_unknown_key' },
    });
  });

  test('PUT with invalid values returns 400 (no loose coercion)', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const invalidValues: Array<unknown> = ['1e3', '1.5', '-1', true, null, '', '0x10', '  '];
    for (const raw of invalidValues) {
      const res = await app.request('/api/v1/settings', {
        method: 'PUT',
        headers: AUTH_HEADERS,
        body: JSON.stringify({ subagent_timeout_minutes: raw }),
      });
      expect(res.status, `expected 400 for ${JSON.stringify(raw)}`).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  test('PUT with valid values (number, string, zero) returns 200 with stored value', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    for (const raw of [30, '30', 0]) {
      const res = await app.request('/api/v1/settings', {
        method: 'PUT',
        headers: AUTH_HEADERS,
        body: JSON.stringify({ subagent_timeout_minutes: raw }),
      });
      expect(res.status, `expected 200 for ${JSON.stringify(raw)}`).toBe(200);
      const body = await res.json() as Record<string, string>;
      // Number 30 与字符串 '30' 均统一存为 String 形式 '30'
      expect(body.subagent_timeout_minutes).toBe(String(raw));
    }
  });

  test('PUT upserts a single row and returns the raw string form', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    await app.request('/api/v1/settings', {
      method: 'PUT',
      headers: AUTH_HEADERS,
      body: JSON.stringify({ subagent_timeout_minutes: 30 }),
    });

    const res = await app.request('/api/v1/settings', {
      method: 'PUT',
      headers: AUTH_HEADERS,
      body: JSON.stringify({ subagent_timeout_minutes: 0 }),
    });
    expect(res.status).toBe(200);

    const db = createDb(`file:${path}`);
    const rows = await db.select().from(settings);
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe('subagent_timeout_minutes');
    expect(rows[0].value).toBe('0');

    const get = await app.request('/api/v1/settings', { method: 'GET', headers: AUTH_HEADERS });
    expect(await get.json()).toEqual({ subagent_timeout_minutes: '0' });
  });

  test('validation failure causes no partial write', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    // 先写入合法值
    const ok = await app.request('/api/v1/settings', {
      method: 'PUT',
      headers: AUTH_HEADERS,
      body: JSON.stringify({ subagent_timeout_minutes: 30 }),
    });
    expect(ok.status).toBe(200);

    // 混合 body：合法 key + 非法 key → 400，且不写入任何行
    const mixed = await app.request('/api/v1/settings', {
      method: 'PUT',
      headers: AUTH_HEADERS,
      body: JSON.stringify({ subagent_timeout_minutes: 45, some_unknown_key: 1 }),
    });
    expect(mixed.status).toBe(400);

    // 非法 value → 400，值不变
    const badVal = await app.request('/api/v1/settings', {
      method: 'PUT',
      headers: AUTH_HEADERS,
      body: JSON.stringify({ subagent_timeout_minutes: '1e5' }),
    });
    expect(badVal.status).toBe(400);

    // 原值仍为 '30'，且表里只有一行
    const db = createDb(`file:${path}`);
    const [row] = await db.select().from(settings).where(eq(settings.key, 'subagent_timeout_minutes'));
    expect(row?.value).toBe('30');

    const rows = await db.select().from(settings);
    expect(rows).toHaveLength(1);

    const get = await app.request('/api/v1/settings', { method: 'GET', headers: AUTH_HEADERS });
    expect(await get.json()).toEqual({ subagent_timeout_minutes: '30' });
  });

  test('PUT accepts vision_enabled boolean and model refs', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const res = await app.request('/api/v1/settings', {
      method: 'PUT',
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        vision_enabled: 'true',
        vision_model: 'anthropic/claude-sonnet-4-5',
        vision_fallback_model: 'openai/gpt-4o',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.vision_enabled).toBe('true');
    expect(body.vision_model).toBe('anthropic/claude-sonnet-4-5');

    const db = createDb(`file:${path}`);
    const rows = await db.select().from(settings);
    expect(rows).toHaveLength(3);
  });

  test('PUT rejects invalid vision_enabled / model ref values', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    for (const [body, needle] of [
      [{ vision_enabled: 1 }, 'vision_enabled'],
      [{ vision_enabled: 'yes' }, 'vision_enabled'],
      [{ vision_model: 'no-slash-here' }, 'vision_model'],
      [{ vision_model: 42 }, 'vision_model'],
      [{ vision_fallback_model: '/leading-slash' }, 'vision_fallback_model'],
    ] as const) {
      const res = await app.request('/api/v1/settings', {
        method: 'PUT',
        headers: AUTH_HEADERS,
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain(needle);
    }
  });

  test('PUT allows clearing vision model refs with empty string', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const res = await app.request('/api/v1/settings', {
      method: 'PUT',
      headers: AUTH_HEADERS,
      body: JSON.stringify({ vision_model: '' }),
    });
    expect(res.status).toBe(200);
  });
});