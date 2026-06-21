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
  const authHeaders = getAuthHeaders() as Record<string, string>;
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    cache: 'no-store',
    ...init,
    headers: {
      'content-type': 'application/json',
      ...authHeaders,
      ...(init?.headers as Record<string, string> ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`request_failed:${response.status}`);
  }
  return response.json() as Promise<T>;
}

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

function getAuthHeaders() {
  const token = typeof window !== 'undefined' ? localStorage.getItem('piplus_token') : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export type ModelInfo = {
  provider: string;
  id: string;
  label: string;
};

export function getModels() {
  return request<{ models: ModelInfo[] }>('/api/v1/models');
}

export function setSessionModel(sessionId: string, model: { provider: string; id: string }) {
  return request<{ session_id: string; model: ModelInfo }>(`/api/v1/sessions/${sessionId}/model`, {
    method: 'POST',
    body: JSON.stringify(model),
  });
}

export function archiveProject(projectId: string) {
  return request<{ project_id: string; status: string }>(`/api/v1/projects/${projectId}/archive`, {
    method: 'POST',
  });
}

export function deleteProject(projectId: string) {
  return request<{ project_id: string; status: string }>(`/api/v1/projects/${projectId}`, {
    method: 'DELETE',
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
  return request<{ accepted: boolean; session_id: string; run_id: string; message_id: string }>(`/api/v1/sessions/${sessionId}/chat/messages`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
}

export function createProject(name: string, mode?: string, path?: string, repoUrl?: string) {
  return request<{ projectId: string; sessionId?: string; piSessionId?: string }>(`/api/v1/projects`, {
    method: 'POST',
    body: JSON.stringify({ name, mode: mode ?? 'existing', path: path ?? '', repo_url: repoUrl ?? '' }),
  });
}

export function createProjectSession(projectId: string, inheritModel?: { provider: string; id: string } | null) {
  return request<{ session_id: string; project_id: string }>(`/api/v1/projects/${projectId}/sessions`, {
    method: 'POST',
    body: JSON.stringify({ inherit_model: inheritModel ?? null }),
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
