import { afterEach, describe, expect, test } from 'bun:test';
import { createApp } from '../app';

describe('auth status', () => {
  const originalPassword = Bun.env.APP_PASSWORD;
  afterEach(() => {
    if (originalPassword === undefined) delete Bun.env.APP_PASSWORD;
    else Bun.env.APP_PASSWORD = originalPassword;
  });

  test('requiresPassword=false when APP_PASSWORD is unset', async () => {
    delete Bun.env.APP_PASSWORD;
    const app = createApp();
    const res = await app.request('/api/v1/auth/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ requiresPassword: false });
  });

  test('requiresPassword=true when APP_PASSWORD is set', async () => {
    Bun.env.APP_PASSWORD = 'test-secret';
    const app = createApp();
    const res = await app.request('/api/v1/auth/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ requiresPassword: true });
  });

  test('requireAuth allows anonymous access in no-auth mode', async () => {
    delete Bun.env.APP_PASSWORD;
    const app = createApp();
    const res = await app.request('/api/v1/tree');
    expect(res.status).toBe(200);
  });

  test('requireAuth rejects anonymous access when password auth is enabled', async () => {
    Bun.env.APP_PASSWORD = 'test-secret';
    const app = createApp();
    const res = await app.request('/api/v1/tree');
    expect(res.status).toBe(401);
  });
});
