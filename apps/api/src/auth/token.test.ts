import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  createToken,
  decodeToken,
  verifyPassword,
  verifyToken,
} from './token';
import { DEFAULT_TOKEN_TTL_HOURS, getServerConfig } from '../server-config';

// NOTE: these tests use static imports and synchronous bodies on purpose.
// bun test runs all files in one process, and async gaps inside a test would
// let other files observe (or overwrite) our temporary Bun.env values.

const TEST_PASSWORD = 'test-secret'; // same value other test files use
const originalPassword = Bun.env.APP_PASSWORD;
const originalTtl = Bun.env.APP_TOKEN_TTL;

afterEach(() => {
  if (originalPassword === undefined) delete Bun.env.APP_PASSWORD;
  else Bun.env.APP_PASSWORD = originalPassword;
  if (originalTtl === undefined) delete Bun.env.APP_TOKEN_TTL;
  else Bun.env.APP_TOKEN_TTL = originalTtl;
});

describe('auth token v2', () => {
  test('creates a v2 token that verifies', () => {
    Bun.env.APP_PASSWORD = TEST_PASSWORD;
    const token = createToken();
    expect(token.startsWith('v2.')).toBe(true);
    expect(token.split('.')).toHaveLength(3);
    expect(verifyToken(token)).toBe(true);
  });

  test('payload contains iat and exp (default TTL 7 days)', () => {
    Bun.env.APP_PASSWORD = TEST_PASSWORD;
    const before = Date.now();
    const token = createToken(before);
    const payload = decodeToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.iat).toBe(before);
    expect(payload!.exp - payload!.iat).toBe(DEFAULT_TOKEN_TTL_HOURS * 60 * 60 * 1000);
  });

  test('verifyToken(token, now) rejects once now reaches exp', () => {
    Bun.env.APP_PASSWORD = TEST_PASSWORD;
    const iat = Date.now();
    const token = createToken(iat);
    const ttlMs = DEFAULT_TOKEN_TTL_HOURS * 60 * 60 * 1000;
    expect(verifyToken(token, iat)).toBe(true);
    expect(verifyToken(token, iat + ttlMs - 1)).toBe(true);
    expect(verifyToken(token, iat + ttlMs)).toBe(false);
  });

  test('APP_TOKEN_TTL shortens the token lifetime', () => {
    Bun.env.APP_PASSWORD = TEST_PASSWORD;
    Bun.env.APP_TOKEN_TTL = '0.000001'; // ~3.6ms
    const iat = Date.now();
    const token = createToken(iat);
    expect(verifyToken(token, iat)).toBe(true);
    expect(verifyToken(token, iat + 100)).toBe(false);
    expect(decodeToken(token)!.exp - iat).toBeCloseTo(0.000001 * 60 * 60 * 1000, 2);
  });

  test('legacy (pre-v2) tokens are rejected', () => {
    Bun.env.APP_PASSWORD = TEST_PASSWORD;
    const timestamp = Date.now().toString(36);
    const legacyHmac = createHmac('sha256', TEST_PASSWORD)
      .update(timestamp)
      .digest('base64url');
    const legacy = `${timestamp}.${legacyHmac}`;
    expect(legacy.startsWith('v2.')).toBe(false);
    expect(legacy.split('.')).toHaveLength(2);
    expect(verifyToken(legacy)).toBe(false);
  });

  test('tampered payload is rejected', () => {
    Bun.env.APP_PASSWORD = TEST_PASSWORD;
    const token = createToken();
    const [, , hmac] = token.split('.');
    // Valid-looking payload signed by nobody.
    const forgedPayload = Buffer.from(JSON.stringify({ iat: 1, exp: Number.MAX_SAFE_INTEGER }))
      .toString('base64url');
    expect(verifyToken(`v2.${forgedPayload}.${hmac}`)).toBe(false);
    // Byte-flipped original payload breaks the signature.
    const [, payload] = token.split('.');
    const flippedPayload = Buffer.from(
      Buffer.from(payload, 'base64url').toString('utf8').replace('}', 'x}'),
    ).toString('base64url');
    expect(verifyToken(`v2.${flippedPayload}.${hmac}`)).toBe(false);
  });

  test('tampered hmac and wrong-secret signatures are rejected', () => {
    Bun.env.APP_PASSWORD = TEST_PASSWORD;
    const token = createToken();
    const [version, payload, hmac] = token.split('.');
    const flipped = (hmac[0] === 'A' ? 'B' : 'A') + hmac.slice(1);
    expect(flipped).not.toBe(hmac);
    expect(verifyToken(`${version}.${payload}.${flipped}`)).toBe(false);

    const otherSecret = createHmac('sha256', 'wrong-secret').update(payload).digest('base64url');
    expect(otherSecret).not.toBe(hmac);
    expect(verifyToken(`${version}.${payload}.${otherSecret}`)).toBe(false);
  });

  test('APP_TOKEN_TTL parsing falls back to the default on invalid input', () => {
    Bun.env.APP_PASSWORD = TEST_PASSWORD;
    Bun.env.APP_TOKEN_TTL = '24.5';
    expect(getServerConfig().appTokenTtlHours).toBe(24.5);
    Bun.env.APP_TOKEN_TTL = 'not-a-number';
    expect(getServerConfig().appTokenTtlHours).toBe(168);
    Bun.env.APP_TOKEN_TTL = '-5';
    expect(getServerConfig().appTokenTtlHours).toBe(168);
    Bun.env.APP_TOKEN_TTL = '0';
    expect(getServerConfig().appTokenTtlHours).toBe(168);
    delete Bun.env.APP_TOKEN_TTL;
    expect(getServerConfig().appTokenTtlHours).toBe(168);
  });

  test('login is unavailable without APP_PASSWORD (no fallback password)', () => {
    delete Bun.env.APP_PASSWORD;
    expect(verifyPassword('piplus-local')).toBe(false);
    expect(verifyPassword('')).toBe(false);
    expect(() => createToken()).toThrow();
  });
});
