import type { ChatMessageDTO, SessionInfoDTO, TreeResponse } from '@piplus/shared';
import { getApiBaseUrl } from './runtime-endpoints';

export type SessionMessagesPage = {
  session_id: string;
  cursor: string | null;
  next_cursor: string | null;
  messages: ChatMessageDTO[];
};

export type SessionResponse = {
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
  };
  session: {
    id: string;
    expiresAt: string;
  };
};

export type LoginResponse = SessionResponse;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    cache: 'no-store',
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`request_failed:${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function login(email: string, password: string) {
  return request<SessionResponse>('/api/v1/auth/sign-in/email', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function getSession() {
  return request<SessionResponse>('/api/v1/auth/session');
}

export function logout() {
  return request<{ ok: true }>('/api/v1/auth/sign-out', {
    method: 'POST',
  });
}

export function getTree() {
  return request<TreeResponse>('/api/v1/tree');
}

export function getSessionInfo(sessionId: string) {
  return request<SessionInfoDTO>(`/api/v1/sessions/${sessionId}/info`);
}

export function getSessionMessages(sessionId: string, options?: { cursor?: string | null; limit?: number }) {
  const params = new URLSearchParams();
  if (options?.cursor) params.set('cursor', options.cursor);
  if (options?.limit) params.set('limit', String(options.limit));
  const query = params.toString();
  return request<SessionMessagesPage>(`/api/v1/sessions/${sessionId}/chat/messages${query ? `?${query}` : ''}`);
}

export function sendSessionMessage(sessionId: string, content: string) {
  return request<{ accepted: boolean; session_id: string; message_id: string }>(`/api/v1/sessions/${sessionId}/chat/messages`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
}

export function createProject(name: string) {
  return request<{ projectId: string; sessionId?: string; piSessionId?: string }>(`/api/v1/projects`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export function createProjectSession(projectId: string) {
  return request<{ session_id: string; project_id: string }>(`/api/v1/projects/${projectId}/sessions`, {
    method: 'POST',
  });
}

export function stopSession(sessionId: string) {
  return request<{ session_id: string; status: string }>(`/api/v1/sessions/${sessionId}/stop`, {
    method: 'POST',
  });
}

export function archiveSession(sessionId: string) {
  return request<{ session_id: string; status: string }>(`/api/v1/sessions/${sessionId}/archive`, {
    method: 'POST',
  });
}

export function updateSessionTitle(sessionId: string, title: string) {
  return request<{ session_id: string; title: string; title_source: string }>(`/api/v1/sessions/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
}
