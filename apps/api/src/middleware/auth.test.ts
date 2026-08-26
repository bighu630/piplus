import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { requireAuth } from './auth';

/**
 * Builds a minimal Hono app protected only by requireAuth so the middleware
 * behavior is tested in isolation (no DB/filesystem side effects).
 */
function makeApp() {
  const app = new Hono();
  app.use('*', requireAuth);
  app.get('/', (c) => c.json({ ok: true }));
  return app;
}

const request = (app: ReturnType<typeof makeApp>, headers: Record<string, string> = {}) =>
  app.request('/', { headers });

describe('requireAuth middleware', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {
      APP_PASSWORD: Bun.env.APP_PASSWORD,
      NODE_ENV: Bun.env.NODE_ENV,
      PIPLUS_DEV_AUTH: Bun.env.PIPLUS_DEV_AUTH,
    };
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
  });

  test('production mode rejects an invalid token with x-user-id (no dev bypass)', async () => {
    Bun.env.APP_PASSWORD = 'secret';
    Bun.env.NODE_ENV = 'production';
    delete Bun.env.PIPLUS_DEV_AUTH;
    const res = await request(makeApp(), { 'x-user-id': 'attacker' });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('UNAUTHENTICATED');
  });

  test('PIPLUS_DEV_AUTH=1 outside production lets x-user-id through', async () => {
    Bun.env.APP_PASSWORD = 'secret';
    Bun.env.NODE_ENV = 'development';
    Bun.env.PIPLUS_DEV_AUTH = '1';
    const res = await request(makeApp(), { 'x-user-id': 'dev-user' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('PIPLUS_DEV_AUTH=1 in production is still rejected', async () => {
    Bun.env.APP_PASSWORD = 'secret';
    Bun.env.NODE_ENV = 'production';
    Bun.env.PIPLUS_DEV_AUTH = '1';
    const res = await request(makeApp(), { 'x-user-id': 'attacker' });
    expect(res.status).toBe(401);
  });

  test('NODE_ENV comparison is case-insensitive (PRODUCTION also blocks dev bypass)', async () => {
    Bun.env.APP_PASSWORD = 'secret';
    Bun.env.NODE_ENV = 'PRODUCTION';
    Bun.env.PIPLUS_DEV_AUTH = '1';
    const res = await request(makeApp(), { 'x-user-id': 'attacker' });
    expect(res.status).toBe(401);
  });

  test('x-user-id alone (without the opt-in flag) never bypasses auth', async () => {
    Bun.env.APP_PASSWORD = 'secret';
    Bun.env.NODE_ENV = 'development';
    delete Bun.env.PIPLUS_DEV_AUTH;
    const res = await request(makeApp(), { 'x-user-id': 'attacker' });
    expect(res.status).toBe(401);
  });

  test('no-auth mode short-circuits every request including spoofed headers', async () => {
    delete Bun.env.APP_PASSWORD;
    Bun.env.NODE_ENV = 'production';
    delete Bun.env.PIPLUS_DEV_AUTH;
    const headerCases: Array<Record<string, string>> = [
      {},
      { 'x-user-id': 'anyone' },
      { Authorization: 'Bearer garbage-token' },
    ];
    for (const headers of headerCases) {
      const res = await request(makeApp(), headers);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
  });

  test('auth enabled + missing token → 401', async () => {
    Bun.env.APP_PASSWORD = 'secret';
    Bun.env.NODE_ENV = 'production';
    const res = await request(makeApp());
    expect(res.status).toBe(401);
  });

  test('a valid token passes regardless of dev-auth settings', async () => {
    Bun.env.APP_PASSWORD = 'secret';
    Bun.env.NODE_ENV = 'production';
    delete Bun.env.PIPLUS_DEV_AUTH;
    const { createToken } = await import('../auth/token');
    const res = await request(makeApp(), { Authorization: `Bearer ${createToken()}` });
    expect(res.status).toBe(200);
  });
});
