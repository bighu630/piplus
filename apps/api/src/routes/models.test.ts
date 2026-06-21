import { describe, expect, test } from 'bun:test';
import { createSeedDb } from '@piplus/db/init';
import { createApp } from '../app';

function makeDbPath() {
  return `/tmp/piplus-models-${crypto.randomUUID()}.sqlite`;
}

describe('model routes', () => {
  test('returns available models', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const tokenRes = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: Bun.env.APP_PASSWORD ?? 'piplus-local' }),
    });
    const { token } = await tokenRes.json();

    const res = await app.request('/api/v1/models', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.models)).toBe(true);
    expect(body.models.length).toBeGreaterThan(0);
  });
});
