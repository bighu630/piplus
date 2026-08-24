import { createHmac, timingSafeEqual } from 'node:crypto';
import { DEFAULT_TOKEN_TTL_HOURS, getServerConfig } from '../server-config';

const TOKEN_VERSION = 'v2';

type TokenPayload = { iat: number; exp: number };

function getAppPassword(): string | undefined {
  return getServerConfig().appPassword;
}

export function isAuthEnabled(): boolean {
  const password = getAppPassword();
  return password !== undefined && password !== '';
}

export function verifyPassword(password: string) {
  const appPassword = getAppPassword();
  // No fallback password: when APP_PASSWORD is unset, login always fails.
  if (appPassword === undefined || appPassword === '') return false;
  return password === appPassword;
}

function sign(payloadBase64url: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadBase64url).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function getTokenTtlMs(): number {
  const hours = getServerConfig().appTokenTtlHours ?? DEFAULT_TOKEN_TTL_HOURS;
  return hours * 60 * 60 * 1000;
}

/**
 * Creates a v2 token: `v2.<payloadBase64url>.<hmacBase64url>` where payload is
 * a JSON `{ iat, exp }` (ms timestamps) signed with HMAC-SHA256 over the
 * base64url-encoded payload using APP_PASSWORD as the key.
 */
export function createToken(now: number = Date.now()): string {
  const secret = getAppPassword();
  if (!secret) {
    throw new Error('APP_PASSWORD must be configured to create tokens');
  }
  const payload: TokenPayload = { iat: now, exp: now + getTokenTtlMs() };
  const payloadBase64url = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const hmac = sign(payloadBase64url, secret);
  return `${TOKEN_VERSION}.${payloadBase64url}.${hmac}`;
}

function decodePayload(payloadBase64url: string): TokenPayload | null {
  try {
    const raw = Buffer.from(payloadBase64url, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as TokenPayload).iat !== 'number' ||
      typeof (parsed as TokenPayload).exp !== 'number' ||
      !Number.isFinite((parsed as TokenPayload).exp)
    ) {
      return null;
    }
    return parsed as TokenPayload;
  } catch {
    return null;
  }
}

/**
 * Decodes a token's payload after verifying its signature. Returns the
 * `{ iat, exp }` payload, or null for malformed / forged tokens. Does NOT
 * check expiry — use verifyToken for that.
 */
export function decodeToken(token: string): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;
  const [, payloadBase64url, hmac] = parts;
  const secret = getAppPassword();
  if (!secret) return null;
  const expected = sign(payloadBase64url, secret);
  if (!safeEqual(hmac, expected)) return null;
  return decodePayload(payloadBase64url);
}

/**
 * Verifies signature and expiry of a v2 token. Legacy (pre-v2) tokens are no
 * longer accepted and always fail.
 */
export function verifyToken(token: string, now: number = Date.now()): boolean {
  const payload = decodeToken(token);
  if (!payload) return false;
  return payload.exp > now;
}
