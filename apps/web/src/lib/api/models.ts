import { request } from './client';

export type ModelInfo = {
  provider: string;
  id: string;
  label: string;
  reasoning?: boolean;
  input?: string[];
  thinkingLevelMap?: Record<string, string | null>;
  availableThinkingLevels?: string[];
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

export type ProviderListItemModel = {
  id: string;
  name?: string;
  api?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: ProviderFormModel['cost'];
  compat?: Record<string, unknown>;
  thinkingLevelMap?: Record<string, string | null>;
};

export type ProviderListItem = {
  providerKey: string;
  baseUrl: string;
  api?: string;
  authHeader: boolean;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models: ProviderListItemModel[];
};

export type ProviderUpdatePayload = Omit<ProviderFormPayload, 'providerKey'>;

export function getModelProviders() {
  return request<{ ok: boolean; providers: ProviderListItem[] }>('/api/v1/models/providers');
}

export function updateModelProvider(providerKey: string, payload: ProviderUpdatePayload) {
  return request<{ ok: boolean; providerKey: string; models: ModelInfo[] }>(`/api/v1/models/providers/${encodeURIComponent(providerKey)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function deleteModelProvider(providerKey: string) {
  return request<{ ok: boolean; providerKey: string }>(`/api/v1/models/providers/${encodeURIComponent(providerKey)}`, {
    method: 'DELETE',
  });
}

export function setSessionModel(sessionId: string, model: { provider: string; id: string }) {
  return request<{ session_id: string; model: ModelInfo }>(`/api/v1/sessions/${sessionId}/model`, {
    method: 'POST',
    body: JSON.stringify(model),
  });
}

export type ThinkingLevelResponse = {
  session_id: string;
  current_level: string | null;
  available_levels: string[];
};

export function getSessionThinkingLevel(sessionId: string) {
  return request<ThinkingLevelResponse>(`/api/v1/sessions/${sessionId}/thinking-level`);
}

export function setSessionThinkingLevel(sessionId: string, level: string) {
  return request<{ session_id: string; current_level: string }>(
    `/api/v1/sessions/${sessionId}/thinking-level`,
    { method: 'PUT', body: JSON.stringify({ level }) },
  );
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

// ── Package Management ───────────────────────────────────────────────
