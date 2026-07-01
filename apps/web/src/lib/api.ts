import { getApiBaseUrl } from './runtime-config';
import type {
  SessionInfoDTO,
  SessionContextUsageDTO,
  TreeResponse,
  ChatMessageDTO,
  ChatImageContentBlockDTO,
  SessionFileTreeResponseDTO,
  SessionFileContentResponseDTO,
  SessionFileSaveResponseDTO,
} from '@piplus/shared';

export type ModelInfo = {
  provider: string;
  id: string;
  label: string;
  input?: string[];
};

export type ProviderFormModel = {
  id: string;
  name?: string;
  reasoning: boolean;
  inputImage: boolean;
  input?: string[];
  api?: string;
  contextWindow?: number;
  maxTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  compat?: string;
  thinkingLevelMap?: string;
};

export type ProviderFormPayload = {
  providerKey: string;
  baseUrl: string;
  apiKey: string;
  authHeader: boolean;
  api?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models: ProviderFormModel[];
};

export type ProviderTestResponse = {
  ok: boolean;
  models?: Array<{ id: string; name?: string }>;
  error?: string;
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

export function getModelsStatus() {
  return request<{ ok: boolean; count: number; models: ModelInfo[] }>('/api/v1/models/status');
}

export function getModels() {
  return request<{ models: ModelInfo[] }>('/api/v1/models');
}

export function testModelProvider(payload: Omit<ProviderFormPayload, 'compat' | 'models'>) {
  return request<ProviderTestResponse>('/api/v1/models/providers/test', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function createModelProvider(payload: ProviderFormPayload) {
  return request<{ ok: boolean; providerKey: string; models: ModelInfo[] }>('/api/v1/models/providers', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function setSessionModel(sessionId: string, model: { provider: string; id: string }) {
  return request<{ session_id: string; model: ModelInfo }>(`/api/v1/sessions/${sessionId}/model`, {
    method: 'POST',
    body: JSON.stringify(model),
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

export function getPlannerRolePrompt(sessionId: string) {
  return request<{ session_id: string; prompt: string; prompt_length: number }>(`/api/v1/sessions/${sessionId}/planner-role-prompt`);
}

export type SessionMessageImageAttachment = {
  type: 'image';
  mime_type: string;
  data_base64: string;
  filename?: string | null;
};

export type SendSessionMessagePayload = {
  content: string;
  attachments?: SessionMessageImageAttachment[];
};

export type OptimisticImageContentBlock = ChatImageContentBlockDTO;

export function sendSessionMessage(sessionId: string, payload: SendSessionMessagePayload) {
  return request<{ accepted: boolean; session_id: string; run_id: string; message_id: string }>(
    `/api/v1/sessions/${sessionId}/chat/messages`,
    { method: 'POST', body: JSON.stringify(payload) },
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

export function getSessionFileTree(sessionId: string) {
  return request<SessionFileTreeResponseDTO>(`/api/v1/sessions/${sessionId}/files/tree`);
}

export function getSessionFileContent(sessionId: string, path: string) {
  const params = new URLSearchParams({ path });
  return request<SessionFileContentResponseDTO>(`/api/v1/sessions/${sessionId}/files/content?${params.toString()}`);
}

export function saveSessionFileContent(sessionId: string, path: string, content: string) {
  return request<SessionFileSaveResponseDTO>(`/api/v1/sessions/${sessionId}/files/content`, {
    method: 'PUT',
    body: JSON.stringify({ path, content }),
  });
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

export function addGitignore(sessionId: string, path: string) {
  return request<{ session_id: string; path: string; result: string }>(
    `/api/v1/sessions/${sessionId}/git/gitignore`,
    { method: 'POST', body: JSON.stringify({ path }) },
  );
}

export function getGitBranches(sessionId: string) {
  return request<{ session_id: string; cwd: string; current_branch: string; branches: Array<{ name: string; is_current: boolean }> }>(
    `/api/v1/sessions/${sessionId}/git/branches`,
  );
}

export function gitCheckout(sessionId: string, branch: string) {
  return request<GitActionResult & { branch: string }>(
    `/api/v1/sessions/${sessionId}/git/checkout`,
    { method: 'POST', body: JSON.stringify({ branch }) },
  );
}

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

export function getSessionContextUsage(sessionId: string) {
  return request<SessionContextUsageDTO>(`/api/v1/sessions/${sessionId}/context-usage`);
}

export function compactSession(sessionId: string) {
  return request<{ session_id: string; accepted: boolean }>(`/api/v1/sessions/${sessionId}/compact`, {
    method: 'POST',
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

export function getProjectRoleModels(projectId: string) {
  return request<Record<string, { provider: string; id: string } | null>>(`/api/v1/projects/${projectId}/role-models`);
}

export function setProjectRoleModels(projectId: string, models: Record<string, { provider: string; id: string } | null>) {
  return request<{ ok: boolean; role_default_models: Record<string, { provider: string; id: string } | null> }>(`/api/v1/projects/${projectId}/role-models`, {
    method: 'PUT',
    body: JSON.stringify(models),
  });
}

export function getNativeModelProviders() {
  return request<{ providers: Array<{ provider: string; label: string; env: string; hasAuth: boolean }> }>('/api/v1/models/native-providers');
}

export function setNativeProviderApiKey(provider: string, apiKey: string) {
  return request<{ ok: boolean; provider: string }>('/api/v1/models/native-providers/auth', {
    method: 'POST',
    body: JSON.stringify({ provider, apiKey }),
  });
}
