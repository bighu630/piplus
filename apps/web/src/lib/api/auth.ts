import { request } from './client';

/**
 * Login with the dashboard password.
 * Resolves `{ token, user: { id, name } }` where `token` is a v2 token carrying an exp.
 * Rejects with the server-provided error message, e.g. wrong password (401)
 * or rate-limited attempts (429 RATE_LIMITED) — surface `error.message` to the UI.
 */
export function login(password: string) {
  return request<{ token: string; user: { id: string; name: string } }>('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

export function checkAuth(token: string) {
  return request<{ ok: true; user: { id: string; name: string } }>('/api/v1/auth/check', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function getAuthStatus() {
  return request<{ requiresPassword: boolean }>('/api/v1/auth/status');
}
