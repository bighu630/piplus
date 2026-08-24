import { getApiBaseUrl } from './runtime-config';

// ── Token lifecycle management ──────────────────────────────────────
// Central place for the client-side auth token: storage, decoding,
// proactive refresh and logout notification.
//
// Token format (v2): `v2.<payloadBase64url>.<hmacBase64url>` where the
// decoded payload is `{ iat: number, exp: number }` (millisecond timestamps).

export const TOKEN_STORAGE_KEY = 'piplus_token';
export const LOGOUT_EVENT_NAME = 'piplus:logout';

function safeStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    // localStorage can throw in some privacy modes
  }
  return null;
}

export function getToken(): string | null {
  try {
    return safeStorage()?.getItem(TOKEN_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    safeStorage()?.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // ignore storage failures (quota / privacy mode)
  }
}

export function clearToken(): void {
  try {
    safeStorage()?.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function base64UrlDecode(input: string): string | null {
  try {
    // Convert base64url -> base64, then decode.
    let base64 = input.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4 !== 0) base64 += '=';
    if (typeof atob === 'function') {
      return atob(base64);
    }
    // Node/Bun fallback
    const globalBuffer = (globalThis as { Buffer?: { from(s: string, enc: string): { toString(enc: string): string } } }).Buffer;
    if (globalBuffer) return globalBuffer.from(base64, 'base64').toString('utf8');
    return null;
  } catch {
    return null;
  }
}

/**
 * Decode the `exp` (ms timestamp) out of a v2 token.
 * Returns null for legacy formats, missing/expired input or malformed payloads.
 */
export function decodeTokenExpiry(token: string | null | undefined): number | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v2' || !parts[1]) return null;
  const json = base64UrlDecode(parts[1]);
  if (json == null) return null;
  try {
    const payload = JSON.parse(json) as { iat?: unknown; exp?: unknown };
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null;
    return payload.exp;
  } catch {
    return null;
  }
}

/** True when the token decodes to an expiry within `withinMs` of now (or is unreadable). */
export function isTokenExpiringSoon(
  token: string | null | undefined,
  withinMs: number = 24 * 3600 * 1000,
): boolean {
  const exp = decodeTokenExpiry(token);
  if (exp == null) return true; // treat undecodable tokens as needing refresh/re-auth
  return exp - Date.now() <= withinMs;
}

/**
 * Call POST /api/v1/auth/refresh with the current token.
 * On success stores the new token and returns true.
 */
export async function refreshToken(): Promise<boolean> {
  const token = getToken();
  if (!token) return false;
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/v1/auth/refresh`, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) return false;
    const data = (await response.json()) as { token?: string };
    if (typeof data?.token !== 'string' || !data.token) return false;
    setToken(data.token);
    return true;
  } catch {
    return false;
  }
}

let refreshInFlight: Promise<boolean> | null = null;

/**
 * Refresh only when the current token is expiring soon (or undecodable).
 * Concurrent callers share the same in-flight refresh promise.
 * Resolves true when a usable token is available afterwards.
 */
export function maybeRefreshToken(): Promise<boolean> {
  const token = getToken();
  if (!token) return Promise.resolve(false);
  if (!isTokenExpiringSoon(token)) return Promise.resolve(true);
  if (!refreshInFlight) {
    refreshInFlight = refreshToken().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/** Clear the stored token and broadcast a logout so hooks can reset app state. */
export function notifyLoggedOut(): void {
  // Guard: if the token is already cleared there is nothing to log out from —
  // skip cleanup and avoid dispatching a redundant logout event.
  if (getToken() === null) return;
  clearToken();
  try {
    if (typeof window !== 'undefined' && typeof window.CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent(LOGOUT_EVENT_NAME));
    }
  } catch {
    // ignore dispatch failures (non-browser env)
  }
}
