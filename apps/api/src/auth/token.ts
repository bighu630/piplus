import { createHmac } from 'node:crypto';

const DEFAULT_PASSWORD = 'piplus-local';
const APP_PASSWORD = Bun.env.APP_PASSWORD ?? DEFAULT_PASSWORD;

if (!Bun.env.APP_PASSWORD) {
  console.warn('[auth] APP_PASSWORD not set, using default: piplus-local');
}

export function verifyPassword(password: string) {
  return password === APP_PASSWORD;
}

export function createToken() {
  const timestamp = Date.now().toString(36);
  const hmac = createHmac('sha256', APP_PASSWORD)
    .update(timestamp)
    .digest('base64url');
  return `${timestamp}.${hmac}`;
}

export function verifyToken(token: string) {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [timestamp, hmac] = parts;
  const expected = createHmac('sha256', APP_PASSWORD)
    .update(timestamp)
    .digest('base64url');
  return hmac === expected;
}
