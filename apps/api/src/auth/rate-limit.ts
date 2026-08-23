/**
 * In-memory fixed-window rate limiter for login brute-force protection.
 * Module-level singleton; no persistence required.
 */

export interface LoginRateLimiterOptions {
  /** Window size in ms (default 15 minutes). */
  windowMs?: number;
  /** Max failed attempts per window (default 5). */
  maxAttempts?: number;
  /** Max concurrently tracked keys before eviction kicks in (default 10_000). */
  maxTrackedKeys?: number;
  /** Number of recordFailure writes between periodic sweeps (default 32). */
  sweepInterval?: number;
  /** Clock injection for tests. */
  now?: () => number;
}

const DEFAULT_MAX_TRACKED_KEYS = 10_000;
const DEFAULT_SWEEP_INTERVAL = 32;

interface WindowEntry {
  count: number;
  windowStart: number;
}

export interface LoginRateLimiter {
  /** Whether this key is currently blocked (too many failures in the window). */
  isLimited(key: string): boolean;
  /** Records a failed attempt for this key. */
  recordFailure(key: string): void;
  /** Clears failure state for this key (e.g. after successful login). */
  reset(key: string): void;
  /** Clears all tracked keys. */
  clear(): void;
}

export function createLoginRateLimiter(options: LoginRateLimiterOptions = {}): LoginRateLimiter {
  const windowMs = options.windowMs ?? 15 * 60 * 1000;
  const maxAttempts = options.maxAttempts ?? 5;
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

  return {
    isLimited(key: string): boolean {
      maybeSweep();
      const entry = windows.get(key);
      if (!entry) return false;
      if (now() - entry.windowStart >= windowMs) {
        windows.delete(key);
        return false;
      }
      return entry.count >= maxAttempts;
    },

    recordFailure(key: string): void {
      const current = now();
      writesSinceSweep += 1;
      maybeSweep();
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
    },

    reset(key: string): void {
      windows.delete(key);
    },

    clear(): void {
      windows.clear();
    },
  };
}

/**
 * Extracts a client IP key from an x-forwarded-for header and remote address.
 *
 * TRUST MODEL: `x-forwarded-for` is client-controlled and trivially spoofed,
 * so this rate limiting is only effective behind a trusted reverse proxy that
 * overwrites the header, or in local/loopback deployments where clients are
 * trusted. When exposed directly to the public internet, rely on network-level
 * protections instead; the remoteAddress fallback here is best-effort only.
 */
export function getClientIp(
  xForwardedFor: string | undefined,
  remoteAddress: string | undefined,
): string {
  if (xForwardedFor) {
    const first = xForwardedFor.split(',')[0]?.trim();
    if (first) return first;
  }
  return remoteAddress ?? 'unknown';
}

/** Shared limiter used by the auth routes. */
export const loginRateLimiter = createLoginRateLimiter();
