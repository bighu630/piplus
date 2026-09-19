import { getApiBaseUrl } from '../runtime-config';
import { getToken, notifyLoggedOut } from '../auth-session';

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    cache: 'no-store',
    ...init,
    headers: {
      'content-type': 'application/json',
      ...authHeaders(),
      ...(init?.headers as Record<string, string> ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    // A 401 on a protected endpoint means the token is expired/invalid:
    // clear it and broadcast logout. Skip /api/v1/auth/* itself to avoid
    // re-entrant logout loops (e.g. failed refresh/check calls).
    if (response.status === 401 && !path.startsWith('/api/v1/auth/')) {
      notifyLoggedOut();
    }
    throw new Error((body as { error?: { message?: string } }).error?.message ?? `request_failed:${response.status}`);
  }
  return response.json() as Promise<T>;
}
