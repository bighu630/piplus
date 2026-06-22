import { getApiBaseUrl } from './constants';
import type { SessionInfoDTO, TreeResponse, ChatMessageDTO } from '@piplus/shared';

export type ModelInfo = {
  provider: string;
  id: string;
  label: string;
};

export type SessionMessagesPage = {
  session_id: string;
  cursor: string | null;
  next_cursor: string | null;
  messages: ChatMessageDTO[];
};

function authHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('piplus_token') : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
    throw new Error((body as { error?: { message?: string } }).error?.message ?? `request_failed:${response.status}`);
  }
  return response.json() as Promise<T>;
}

// Auth
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

// Models
export function getModels() {
  return request<{ models: ModelInfo[] }>('/api/v1/models');
}

export function setSessionModel(sessionId: string, model: { provider: string; id: string }) {
  return request<{ session_id: string; model: ModelInfo }>(`/api/v1/sessions/${sessionId}/model`, {
    method: 'POST',
    body: JSON.stringify(model),
  });
}

// Tree
export function getTree() {
  return request<TreeResponse>('/api/v1/tree');
}

// Sessions
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
  return request<{ accepted: boolean; session_id: string; run_id: string; message_id: string }>(
    `/api/v1/sessions/${sessionId}/chat/messages`,
    { method: 'POST', body: JSON.stringify({ content }) },
  );
}

export function stopSession(sessionId: string) {
  return request<{ session_id: string; status: string }>(`/api/v1/sessions/${sessionId}/stop`, { method: 'POST' });
}

export function archiveSession(sessionId: string) {
  return request<{ session_id: string; status: string }>(`/api/v1/sessions/${sessionId}/archive`, { method: 'POST' });
}

export function updateSessionTitle(sessionId: string, title: string) {
  return request<{ session_id: string; title: string; title_source: string }>(`/api/v1/sessions/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
}

export function getSessionGitDiff(sessionId: string) {
  return request<{ session_id: string; diff: string; cwd: string }>(`/api/v1/sessions/${sessionId}/git-diff`);
}

export type GitActionResult = {
  session_id: string;
  cwd: string;
  result: 'ok' | 'error';
  stdout?: string;
  stderr?: string;
};

export function gitPull(sessionId: string) {
  return request<GitActionResult>(`/api/v1/sessions/${sessionId}/git/pull`, { method: 'POST' });
}

export function gitPush(sessionId: string) {
  return request<GitActionResult>(`/api/v1/sessions/${sessionId}/git/push`, { method: 'POST' });
}

export function gitCommit(sessionId: string, message: string) {
  return request<GitActionResult>(`/api/v1/sessions/${sessionId}/git/commit`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
}

// Projects
export function createProject(
  name: string,
  mode?: string,
  path?: string,
  repoUrl?: string,
  model?: { provider: string; id: string } | null,
) {
  return request<{ projectId: string; sessionId?: string; piSessionId?: string }>('/api/v1/projects', {
    method: 'POST',
    body: JSON.stringify({
      name,
      mode: mode ?? 'existing',
      path: path ?? '',
      repo_url: repoUrl ?? '',
      model: model ?? null,
    }),
  });
}

export function createProjectSession(projectId: string) {
  return request<{ session_id: string; project_id: string }>(`/api/v1/projects/${projectId}/sessions`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function archiveProject(projectId: string) {
  return request<{ project_id: string; status: string }>(`/api/v1/projects/${projectId}/archive`, { method: 'POST' });
}

export function deleteProject(projectId: string) {
  return request<{ project_id: string; status: string }>(`/api/v1/projects/${projectId}`, { method: 'DELETE' });
}
