import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createApp } from '../app';
import { loginRateLimiter } from './rate-limit';

const originalPassword = Bun.env.APP_PASSWORD;
const originalTrustProxyCidrs = Bun.env.TRUST_PROXY_CIDRS;

beforeEach(() => {
  loginRateLimiter.clear();
});

afterEach(() => {
  if (originalPassword === undefined) delete Bun.env.APP_PASSWORD;
  else Bun.env.APP_PASSWORD = originalPassword;
  if (originalTrustProxyCidrs === undefined) delete Bun.env.TRUST_PROXY_CIDRS;
  else Bun.env.TRUST_PROXY_CIDRS = originalTrustProxyCidrs;
});

function makeApp() {
  Bun.env.APP_PASSWORD = 'test-secret';
  return createApp();
}

async function login(
  app: ReturnType<typeof createApp>,
  password: string,
  ip = '10.0.0.1',
) {
  return app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ password }),
  });
}

describe('auth routes', () => {
  describe('refresh', () => {
    test('exchanges a valid token for a new different token', async () => {
      const app = makeApp();
      const loginRes = await login(app, 'test-secret');
      expect(loginRes.status).toBe(200);
      const { token } = await loginRes.json();

      // Ensure the refresh happens in a later millisecond so the new token's
      // iat/exp (ms precision) differ from the original one.
      await Bun.sleep(5);

      const res = await app.request('/api/v1/auth/refresh', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.token).toBeTruthy();
      expect(typeof body.token).toBe('string');
      expect(body.token).not.toBe(token);
      expect(body.user).toEqual({ id: 'local-user', name: 'Piplus' });

      // New token must itself be usable.
      const check = await app.request('/api/v1/auth/check', {
        headers: { Authorization: `Bearer ${body.token}` },
      });
      expect(check.status).toBe(200);
    });

    test('rejects an invalid token with 401 UNAUTHENTICATED', async () => {
      const app = makeApp();
      const res = await app.request('/api/v1/auth/refresh', {
        method: 'POST',
        headers: { Authorization: 'Bearer not-a-real-token' },
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe('UNAUTHENTICATED');
    });

    test('rejects an expired token', async () => {
      Bun.env.APP_PASSWORD = 'test-secret';
      Bun.env.APP_TOKEN_TTL = '0.000001'; // ~3.6ms
      try {
        const { createToken } = await import('./token');
        const expired = createToken(Date.now() - 1000);
        const app = createApp();
        const res = await app.request('/api/v1/auth/refresh', {
          method: 'POST',
          headers: { Authorization: `Bearer ${expired}` },
        });
        expect(res.status).toBe(401);
      } finally {
        delete Bun.env.APP_TOKEN_TTL;
      }
    });
  });

  describe('login rate limiting', () => {
    test('blocks after 5 failed attempts even with the correct password', async () => {
      const app = makeApp();
      for (let i = 0; i < 5; i++) {
        const res = await login(app, 'wrong-password');
        expect(res.status).toBe(401);
      }
      const blocked = await login(app, 'test-secret');
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('retry-after')).toBeTruthy();
      // Retry-After must be a positive number of seconds.
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      const body = await blocked.json();
      expect(body.error.code).toBe('RATE_LIMITED');
      expect(body.error.message).toBe('Too many attempts, try again later');

      // Blocked requests must not extend the block window with more failures:
      // another wrong attempt still yields 429, not a new counter entry.
      const stillBlocked = await login(app, 'wrong-password');
      expect(stillBlocked.status).toBe(429);
    });

    test('a successful login resets the failure counter', async () => {
      const app = makeApp();
      for (let i = 0; i < 4; i++) {
        const res = await login(app, 'wrong-password', '10.0.0.2');
        expect(res.status).toBe(401);
      }
      const ok = await login(app, 'test-secret', '10.0.0.2');
      expect(ok.status).toBe(200);

      // Counter was reset: 4 more failures stay under the limit of 5...
      for (let i = 0; i < 4; i++) {
        const res = await login(app, 'wrong-password', '10.0.0.2');
        expect(res.status).toBe(401);
      }
      // ...and the 5th failure trips the limiter again.
      const fifth = await login(app, 'wrong-password', '10.0.0.2');
      expect(fifth.status).toBe(401);
      const blocked = await login(app, 'test-secret', '10.0.0.2');
      expect(blocked.status).toBe(429);
    });

    test('spoofed x-forwarded-for values share one bucket without trusted proxies', async () => {
      // TRUST MODEL under test: app.request() has no socket peer address, and
      // TRUST_PROXY_CIDRS is unset here, so resolveClientIp ignores XFF
      // entirely and every request resolves to 'unknown' → a single shared
      // limiter bucket. Rotating spoofed XFF values must NOT evade the limit.
      // (Trusted-proxy XFF parsing itself is covered by ip.test.ts pure
      // function tests; it cannot be exercised through app.request() because
      // Bun's Request carries no controllable peer address.)
      const app = makeApp();
      delete Bun.env.TRUST_PROXY_CIDRS;
      for (let i = 0; i < 5; i++) {
        await login(app, 'wrong-password', `10.0.0.${i}`);
      }
      // A "different" IP via forged XFF hits the same exhausted bucket.
      const spoofed = await login(app, 'test-secret', '10.9.9.9');
      expect(spoofed.status).toBe(429);
    });
  });
});
