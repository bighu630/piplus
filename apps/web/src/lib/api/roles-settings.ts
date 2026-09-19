import { request } from './client';

export type RoleTemplateDTO = {
  id: string;
  key: string;
  version: string;
  name: string;
  description: string;
  basePrompt: string;
  icon: string | null;
  isBuiltin: boolean;
  created_at: string;
  updated_at: string;
};

export function getRoleTemplates() {
  return request<RoleTemplateDTO[]>('/api/v1/role-templates');
}

export function getRoleTemplate(id: string) {
  return request<RoleTemplateDTO>(`/api/v1/role-templates/${id}`);
}

export function createRoleTemplate(payload: { key: string; version: string; basePrompt?: string; name?: string; description?: string; icon?: string }) {
  return request<RoleTemplateDTO>('/api/v1/role-templates', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function updateRoleTemplate(id: string, payload: { basePrompt?: string; name?: string; description?: string; icon?: string }) {
  return request<RoleTemplateDTO>(`/api/v1/role-templates/${id}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function deleteRoleTemplate(id: string) {
  return request<{ ok: boolean }>(`/api/v1/role-templates/${id}`, {
    method: 'DELETE',
  });
}

// ── Project Role Config ─────────────────────────────────────────────

export type RoleConfigEntry = {
  enabled?: boolean;
  version?: string;
};

export function getProjectRoleConfig(projectId: string) {
  return request<Record<string, RoleConfigEntry | null>>(`/api/v1/projects/${projectId}/role-config`);
}

export function setProjectRoleConfig(projectId: string, config: Record<string, RoleConfigEntry | null>) {
  return request<{ ok: boolean }>(`/api/v1/projects/${projectId}/role-config`, {
    method: 'PUT',
    body: JSON.stringify(config),
  });
}

// ── Settings ──────────────────────────────────────────────────────

export function getSettings() {
  return request<Record<string, string>>('/api/v1/settings');
}

export function putSettings(patch: Record<string, number | string>) {
  return request<Record<string, string>>('/api/v1/settings', {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}
