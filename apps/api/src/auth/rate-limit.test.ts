import { describe, expect, test } from 'bun:test';
import { createLoginRateLimiter } from './rate-limit';

describe('login rate limiter — singleton wiring', () => {
  test('shared singleton honors LOGIN_GLOBAL_MAX_ATTEMPTS from the environment', async () => {
    const saved = Bun.env.LOGIN_GLOBAL_MAX_ATTEMPTS;
    Bun.env.LOGIN_GLOBAL_MAX_ATTEMPTS = '2';
    try {
      // The unique query string busts Bun's module cache, forcing a fresh
      // evaluation of the module-level singleton against the current env.
      const specifier = `./rate-limit?wiring-${Date.now()}`;
      const mod = (await import(specifier)) as unknown as typeof import('./rate-limit');
      const limiter = mod.loginRateLimiter;

      // Per-key budget keeps its default of 5; only the global ceiling
      // should drop to 2 failures across all keys.
      limiter.recordFailure('a');
      expect(limiter.isLimited('a')).toBe(false);
      expect(limiter.isLimited('b')).toBe(false);
      limiter.recordFailure('b');
      // Global counter exhausted → even a brand-new key is blocked.
      expect(limiter.isLimited('c')).toBe(true);
      expect(limiter.retryAfterMs('c')).toBeGreaterThan(0);
    } finally {
      if (saved === undefined) delete Bun.env.LOGIN_GLOBAL_MAX_ATTEMPTS;
      else Bun.env.LOGIN_GLOBAL_MAX_ATTEMPTS = saved;
    }
  });
});

describe('login rate limiter — bounded memory', () => {
  test('periodic sweep removes expired entries', () => {
    let time = 0;
    const limiter = createLoginRateLimiter({
      windowMs: 1000,
      maxAttempts: 5,
      globalMaxAttempts: null,
      sweepInterval: 4,
      now: () => time,
    });

    for (let i = 0; i < 4; i++) {
      limiter.recordFailure(`key-${i}`);
    }
    // Advance past the window so all entries are expired, then trigger a sweep
    // with more writes.
    time = 2000;
    for (let i = 0; i < 4; i++) {
      limiter.recordFailure(`flood-${i}`);
    }

    // All original keys must have been swept away (not limited anymore).
    expect(limiter.isLimited('key-0')).toBe(false);
    expect(limiter.isLimited('key-3')).toBe(false);
    // New keys still tracked correctly.
    expect(limiter.isLimited('flood-0')).toBe(false);
    limiter.recordFailure('flood-0');
    limiter.recordFailure('flood-0');
    expect(limiter.isLimited('flood-0')).toBe(false);
  });

  test('map size is capped at maxTrackedKeys (evicts oldest when full)', () => {
    let time = 0;
    const limiter = createLoginRateLimiter({
      windowMs: 60_000,
      maxAttempts: 100,
      // Global tracking disabled so the flood of unique keys below does not
      // trip the shared counter and mask the eviction behavior under test.
      globalMaxAttempts: null,
      maxTrackedKeys: 3,
      sweepInterval: 1_000_000, // disable periodic sweep for this test
      now: () => time,
    });

    // Insert far more unique keys than the cap, within one window.
    for (let i = 0; i < 50; i++) {
      limiter.recordFailure(`rotating-${i}`);
    }
    // No way to observe map size directly; verify via behavior: the first keys
    // were evicted and re-inserted, so none of them should be limited with
    // maxAttempts=100, and the limiter remains functional.
    expect(limiter.isLimited('rotating-0')).toBe(false);
    expect(limiter.isLimited('rotating-49')).toBe(false);

    // A key recorded maxAttempts times becomes limited.
    for (let i = 0; i < 100; i++) {
      limiter.recordFailure('attacker');
    }
    expect(limiter.isLimited('attacker')).toBe(true);
    // Cap still respected afterwards: new keys can be recorded without error.
    limiter.recordFailure('another');
    expect(limiter.isLimited('another')).toBe(false);
  });

  test('sweep + cap keeps limiter functional across window rollover', () => {
    let time = 0;
    const limiter = createLoginRateLimiter({
      windowMs: 1000,
      maxAttempts: 2,
      maxTrackedKeys: 2,
      sweepInterval: 2,
      now: () => time,
    });

    limiter.recordFailure('a');
    limiter.recordFailure('a');
    expect(limiter.isLimited('a')).toBe(true);

    // Window expires; sweeps triggered by subsequent writes clear 'a'.
    time = 5000;
    limiter.recordFailure('b');
    limiter.recordFailure('c');
    expect(limiter.isLimited('a')).toBe(false);

    // After rollover the same key can be limited again in its new window.
    limiter.recordFailure('a');
    limiter.recordFailure('a');
    expect(limiter.isLimited('a')).toBe(true);
  });
});

describe('login rate limiter — global counter', () => {
  test('trips after globalMaxAttempts failures across many keys and resets with the window', () => {
    let time = 0;
    const limiter = createLoginRateLimiter({
      windowMs: 1000,
      maxAttempts: 5,
      globalMaxAttempts: 3,
      sweepInterval: 1_000_000, // deterministic: no periodic sweep mid-test
      now: () => time,
    });

    // Three different keys, one failure each → the shared counter is full.
    limiter.recordFailure('ip-1');
    limiter.recordFailure('ip-2');
    expect(limiter.isLimited('ip-9')).toBe(false);
    limiter.recordFailure('ip-3');

    // Even a brand-new key is blocked by the global ceiling.
    expect(limiter.isLimited('ip-9')).toBe(true);
    expect(limiter.retryAfterMs('ip-9')).toBeGreaterThan(0);

    // Window rollover clears the global counter too.
    time = 1500;
    expect(limiter.isLimited('ip-9')).toBe(false);
    expect(limiter.retryAfterMs('ip-9')).toBe(0);
  });

  test('per-key and global limits are independent dimensions', () => {
    let time = 0;
    const limiter = createLoginRateLimiter({
      windowMs: 1000,
      maxAttempts: 2,
      globalMaxAttempts: 10,
      now: () => time,
    });

    // Key exhausts its own budget (2) while the global counter sits at 2/10.
    limiter.recordFailure('a');
    limiter.recordFailure('a');
    expect(limiter.isLimited('a')).toBe(true);
    expect(limiter.isLimited('b')).toBe(false);

    // Filling the global counter blocks every key, even untouched ones.
    for (let i = 0; i < 8; i++) limiter.recordFailure(`rotating-${i}`);
    expect(limiter.isLimited('b')).toBe(true);
    expect(limiter.isLimited('never-seen')).toBe(true);
  });

  test('reset(key) clears the per-key bucket but keeps the global counter armed', () => {
    const limiter = createLoginRateLimiter({
      windowMs: 60_000,
      maxAttempts: 5,
      globalMaxAttempts: 4,
    });

    for (let i = 0; i < 4; i++) limiter.recordFailure('attacker');
    // A single successful login clears the attacker's own bucket...
    limiter.reset('attacker');
    expect(limiter.isLimited('attacker')).toBe(true); // ...but the global cap holds.
    expect(limiter.isLimited('victim')).toBe(true);
  });
});

describe('login rate limiter — retryAfterMs', () => {
  test('returns the remaining window time for a limited key (injected clock)', () => {
    let time = 0;
    const limiter = createLoginRateLimiter({
      windowMs: 1000,
      maxAttempts: 2,
      globalMaxAttempts: null,
      now: () => time,
    });

    expect(limiter.retryAfterMs('k')).toBe(0);
    limiter.recordFailure('k');
    limiter.recordFailure('k');
    expect(limiter.isLimited('k')).toBe(true);
    expect(limiter.retryAfterMs('k')).toBe(1000);

    time = 400;
    expect(limiter.retryAfterMs('k')).toBe(600);

    // Past the window the key is no longer limited → retryAfterMs back to 0.
    time = 1500;
    expect(limiter.retryAfterMs('k')).toBe(0);
  });

  test('reports the global remaining time when only the global counter is limited', () => {
    let time = 0;
    const limiter = createLoginRateLimiter({
      windowMs: 2000,
      maxAttempts: 100,
      globalMaxAttempts: 1,
      now: () => time,
    });

    limiter.recordFailure('one-off');
    // 'other' itself is fine but the global counter is exhausted.
    expect(limiter.isLimited('other')).toBe(true);
    expect(limiter.retryAfterMs('other')).toBe(2000);
    time = 500;
    expect(limiter.retryAfterMs('other')).toBe(1500);
  });
});
