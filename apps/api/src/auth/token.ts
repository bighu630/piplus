import { createHmac } from 'node:crypto';
import { getServerConfig } from '../server-config';

const DEFAULT_PASSWORD = 'piplus-local';

function getAppPassword() {
  return getServerConfig().appPassword ?? DEFAULT_PASSWORD;
}

export function isAuthEnabled(): boolean {
  const password = getServerConfig().appPassword;
  return password !== undefined && password !== '';
}

export function verifyPassword(password: string) {
  return password === getAppPassword();
}

export function createToken() {
  const timestamp = Date.now().toString(36);
  const hmac = createHmac('sha256', getAppPassword())
    .update(timestamp)
    .digest('base64url');
  return `${timestamp}.${hmac}`;
}

export function verifyToken(token: string) {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [timestamp, hmac] = parts;
  const expected = createHmac('sha256', getAppPassword())
    .update(timestamp)
    .digest('base64url');
  return hmac === expected;
}
