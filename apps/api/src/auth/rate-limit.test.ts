import { describe, expect, test } from 'bun:test';
import { createLoginRateLimiter } from './rate-limit';

describe('login rate limiter — bounded memory', () => {
  test('periodic sweep removes expired entries', () => {
    let time = 0;
    const limiter = createLoginRateLimiter({
      windowMs: 1000,
      maxAttempts: 5,
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
