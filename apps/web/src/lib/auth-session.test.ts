import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  clearToken,
  decodeTokenExpiry,
  getToken,
  isTokenExpiringSoon,
  setToken,
  TOKEN_STORAGE_KEY,
} from './auth-session';

// Minimal localStorage stub (bun test has no DOM storage).
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null; }
  setItem(key: string, value: string) { this.map.set(key, String(value)); }
  removeItem(key: string) { this.map.delete(key); }
  clear() { this.map.clear(); }
}

function makeV2Token(payload: { iat: number; exp: number }): string {
  const json = JSON.stringify(payload);
  const b64 = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `v2.${b64}.c2lnbmF0dXJl`; // fake hmac segment
}

describe('auth-session', () => {
  const originalStorage = (globalThis as Record<string, unknown>).localStorage;

  beforeEach(() => {
    (globalThis as Record<string, unknown>).localStorage = new MemoryStorage();
    (globalThis as Record<string, unknown>).window = { localStorage: (globalThis as Record<string, unknown>).localStorage };
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).localStorage = originalStorage;
    if (originalStorage === undefined) delete (globalThis as Record<string, unknown>).window;
    else (globalThis as Record<string, unknown>).window = { localStorage: originalStorage };
    clearToken();
  });

  describe('token storage', () => {
    test('set/get/clear roundtrip keeps piplus_token key', () => {
      expect(getToken()).toBeNull();
      setToken('v2.abc.sig');
      expect(getToken()).toBe('v2.abc.sig');
      clearToken();
      expect(getToken()).toBeNull();
    });
  });

  describe('decodeTokenExpiry', () => {
    const HOUR = 3600 * 1000;

    test('decodes exp from a valid v2 token', () => {
      const exp = Date.now() + 2 * 24 * HOUR;
      expect(decodeTokenExpiry(makeV2Token({ iat: Date.now(), exp }))).toBe(exp);
    });

    test('returns null for legacy / malformed formats', () => {
      expect(decodeTokenExpiry(null)).toBeNull();
      expect(decodeTokenExpiry(undefined)).toBeNull();
      expect(decodeTokenExpiry('')).toBeNull();
      expect(decodeTokenExpiry('legacy-opaque-token')).toBeNull();
      expect(decodeTokenExpiry('v1.abc.def')).toBeNull(); // wrong version prefix
      expect(decodeTokenExpiry('v2.only-two')).toBeNull(); // missing segments
    });

    test('returns null for undecodable payload or bad json', () => {
      expect(decodeTokenExpiry('v2.%%%not-base64%%%.sig')).toBeNull();
      expect(decodeTokenExpiry(`v2.${btoa('not-json{')}.sig`)).toBeNull();
    });

    test('returns null when payload lacks a numeric exp', () => {
      expect(decodeTokenExpiry(`v2.${btoa(JSON.stringify({ iat: 1 }))}.sig`)).toBeNull();
      expect(decodeTokenExpiry(`v2.${btoa(JSON.stringify({ iat: 1, exp: 'soon' }))}.sig`)).toBeNull();
    });
  });

  describe('isTokenExpiringSoon', () => {
    const DAY = 24 * 3600 * 1000;

    test('false when token is valid well beyond the window', () => {
      const token = makeV2Token({ iat: Date.now(), exp: Date.now() + 3 * DAY });
      expect(isTokenExpiringSoon(token)).toBe(false);
    });

    test('true when token expires within the window', () => {
      const token = makeV2Token({ iat: Date.now(), exp: Date.now() + DAY - 1000 });
      expect(isTokenExpiringSoon(token)).toBe(true);
    });

    test('true for already-expired tokens and undecodable input', () => {
      expect(isTokenExpiringSoon(makeV2Token({ iat: 0, exp: 1 }))).toBe(true);
      expect(isTokenExpiringSoon(null)).toBe(true);
      expect(isTokenExpiringSoon('garbage')).toBe(true);
    });

    test('honours custom window', () => {
      const token = makeV2Token({ iat: Date.now(), exp: Date.now() + 2 * DAY });
      expect(isTokenExpiringSoon(token, 3 * DAY)).toBe(true);
      expect(isTokenExpiringSoon(token, 1000)).toBe(false);
    });
  });
});
