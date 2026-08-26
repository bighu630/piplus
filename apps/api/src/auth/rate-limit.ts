/**
 * In-memory fixed-window rate limiter for login brute-force protection.
 * Module-level singleton; no persistence required.
 *
 * Tracks two dimensions per window:
 * - per-key failures (default max 5) so individual clients get locked out;
 * - a global failure counter (default max 100, key '__global__') so an
 *   attacker rotating spoofed IPs cannot brute-force at full speed.
 */

import { DEFAULT_LOGIN_GLOBAL_MAX_ATTEMPTS, getServerConfig } from '../server-config';

export interface LoginRateLimiterOptions {
  /** Window size in ms (default 15 minutes). */
  windowMs?: number;
  /** Max failed attempts per window per key (default 5). */
  maxAttempts?: number;
  /**
   * Max failed attempts per window across all keys (default 100). Pass
   * `null` to disable global tracking (used by focused unit tests).
   */
  globalMaxAttempts?: number | null;
  /** Key under which the global failure counter is tracked. */
  globalKey?: string;
  /** Max concurrently tracked keys before eviction kicks in (default 10_000). */
  maxTrackedKeys?: number;
  /** Number of recordFailure writes between periodic sweeps (default 32). */
  sweepInterval?: number;
  /** Clock injection for tests. */
  now?: () => number;
}

const DEFAULT_MAX_TRACKED_KEYS = 10_000;
const DEFAULT_SWEEP_INTERVAL = 32;

export const GLOBAL_RATE_LIMIT_KEY = '__global__';

interface WindowEntry {
  count: number;
  windowStart: number;
}

export interface LoginRateLimiter {
  /** Whether this key — or the global counter — is currently blocked. */
  isLimited(key: string): boolean;
  /** Records a failed attempt for this key (and the global counter). */
  recordFailure(key: string): void;
  /** Clears failure state for this key (e.g. after successful login). */
  reset(key: string): void;
  /**
   * Milliseconds until the current block on this key ends, 0 if not limited.
   * When the key itself is fine but the global counter is exhausted, returns
   * the remaining time of the global window.
   */
  retryAfterMs(key: string): number;
  /** Clears all tracked keys. */
  clear(): void;
}

export function createLoginRateLimiter(options: LoginRateLimiterOptions = {}): LoginRateLimiter {
  const windowMs = options.windowMs ?? 15 * 60 * 1000;
  const maxAttempts = options.maxAttempts ?? 5;
  const globalMaxAttempts = options.globalMaxAttempts === undefined
    ? DEFAULT_LOGIN_GLOBAL_MAX_ATTEMPTS
    : options.globalMaxAttempts;
  const globalKey = options.globalKey ?? GLOBAL_RATE_LIMIT_KEY;
  const maxTrackedKeys = options.maxTrackedKeys ?? DEFAULT_MAX_TRACKED_KEYS;
  const sweepInterval = options.sweepInterval ?? DEFAULT_SWEEP_INTERVAL;
  const now = options.now ?? Date.now;
  const windows = new Map<string, WindowEntry>();

  // Bounded-memory guard: keys are only removed lazily when the same key is
  // revisited after its window expires, so an attacker rotating spoofed
  // x-forwarded-for values could otherwise grow the map without limit.
  // We sweep expired entries periodically and cap the map size (evicting the
  // least-recently-inserted entry when still full).
  let writesSinceSweep = 0;

  function sweepExpired(current: number): void {
    for (const [key, entry] of windows) {
      if (current - entry.windowStart >= windowMs) windows.delete(key);
    }
  }

  function maybeSweep(): void {
    if (writesSinceSweep < sweepInterval && windows.size < maxTrackedKeys) return;
    sweepExpired(now());
    writesSinceSweep = 0;
  }

  /** Live window entry for a key; deletes and returns null when expired. */
  function liveEntry(key: string): WindowEntry | null {
    const entry = windows.get(key);
    if (!entry) return null;
    if (now() - entry.windowStart >= windowMs) {
      windows.delete(key);
      return null;
    }
    return entry;
  }

  /** Max attempts allowed for a given tracked key. */
  function limitFor(key: string): number | null {
    if (globalMaxAttempts === null) return key === globalKey ? null : maxAttempts;
    return key === globalKey ? globalMaxAttempts : maxAttempts;
  }

  function isKeyLimited(key: string): boolean {
    maybeSweep();
    const entry = liveEntry(key);
    const limit = limitFor(key);
    if (entry === null || limit === null) return false;
    return entry.count >= limit;
  }

  function recordInto(key: string, current: number): void {
    let entry = windows.get(key);
    if (!entry || current - entry.windowStart >= windowMs) {
      if (!entry && windows.size >= maxTrackedKeys) {
        // Still full after sweeping (flood of unique keys inside a single
        // window): evict the least-recently-inserted entry so memory stays
        // bounded while keeping the limiter functional.
        const oldest = windows.keys().next();
        if (!oldest.done) windows.delete(oldest.value);
      }
      entry = { count: 0, windowStart: current };
      windows.set(key, entry);
    }
    entry.count += 1;
  }

  return {
    isLimited(key: string): boolean {
      if (isKeyLimited(key)) return true;
      if (key !== globalKey && isKeyLimited(globalKey)) return true;
      return false;
    },

    recordFailure(key: string): void {
      const current = now();
      writesSinceSweep += 1;
      maybeSweep();
      recordInto(key, current);
      // Feed the shared global counter so distributed/rotating-IP attacks
      // still hit a ceiling. Only reset clears it (successful logins do not),
      // otherwise one valid login would re-arm a brute-force campaign.
      if (key !== globalKey && globalMaxAttempts !== null) {
        recordInto(globalKey, current);
      }
    },

    reset(key: string): void {
      windows.delete(key);
    },

    retryAfterMs(key: string): number {
      maybeSweep();
      let entry = liveEntry(key);
      if (entry === null || !isKeyLimited(key)) {
        if (key === globalKey) return 0;
        entry = liveEntry(globalKey);
        if (entry === null || !isKeyLimited(globalKey)) return 0;
      }
      return Math.max(0, entry.windowStart + windowMs - now());
    },

    clear(): void {
      windows.clear();
    },
  };
}

/**
 * Shared limiter used by the auth routes. The global failure ceiling is
 * wired to LOGIN_GLOBAL_MAX_ATTEMPTS via getServerConfig() so operators can
 * tune brute-force protection without a code change. server-config has no
 * import cycle with this module (it only pulls node:path), and it is imported
 * eagerly here at module-init time; env is stable for the process lifetime.
 */
export const loginRateLimiter = createLoginRateLimiter({
  globalMaxAttempts: getServerConfig().loginGlobalMaxAttempts,
});
