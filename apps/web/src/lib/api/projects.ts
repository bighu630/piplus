import { request } from './client';
import type { TreeResponse } from '@piplus/shared';
import type { RoleConfigEntry } from './roles-settings';

export function getTree() {
  return request<TreeResponse>('/api/v1/tree');
}

export function createProject(
  name: string,
  mode?: string,
  path?: string,
  repoUrl?: string,
  model?: { provider: string; id: string } | null,
  gitConfig?: { userName?: string; userEmail?: string; token?: string } | null,
  roleConfig?: Record<string, RoleConfigEntry | null> | null,
) {
  return request<{ projectId: string; sessionId?: string; piSessionId?: string }>('/api/v1/projects', {
    method: 'POST',
    body: JSON.stringify({
      name,
      mode: mode ?? 'existing',
      path: path ?? '',
      repo_url: repoUrl ?? '',
      model: model ?? null,
      git_config: gitConfig ?? undefined,
      role_config: roleConfig ?? undefined,
    }),
  });
}

export function createProjectSession(projectId: string) {
  return request<{ session_id: string; project_id: string }>(`/api/v1/projects/${projectId}/sessions`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function setProjectPinned(projectId: string, pinned: boolean) {
  return request<{ project_id: string; pinned_at: string | null }>(`/api/v1/projects/${projectId}`, {
    method: 'PATCH',
    body: JSON.stringify({ pinned }),
  });
}

export function archiveProject(projectId: string) {
  return request<{ project_id: string; status: string }>(`/api/v1/projects/${projectId}/archive`, { method: 'POST' });
}

export function deleteProject(projectId: string) {
  return request<{ project_id: string; status: string }>(`/api/v1/projects/${projectId}`, { method: 'DELETE' });
}

export type RoleModelEntry = {
  provider: string;
  id: string;
  thinkingLevel?: string | null;
  candidateModels?: Array<{
    provider: string;
    id: string;
    thinkingLevel?: string | null;
  }>;
};

export function getProjectRoleModels(projectId: string) {
  return request<Record<string, RoleModelEntry | null>>(`/api/v1/projects/${projectId}/role-models`);
}

export function setProjectRoleModels(projectId: string, models: Record<string, RoleModelEntry | null>) {
  return request<{ ok: boolean; role_default_models: Record<string, RoleModelEntry | null> }>(`/api/v1/projects/${projectId}/role-models`, {
    method: 'PUT',
    body: JSON.stringify(models),
  });
}

export type ProjectGitConfig = {
  userName: string;
  userEmail: string;
  tokenConfigured: boolean;
};

export function getProjectGitConfig(projectId: string) {
  return request<ProjectGitConfig>(`/api/v1/projects/${projectId}/git-config`);
}

export function updateProjectGitConfig(projectId: string, config: { userName?: string; userEmail?: string; token?: string }) {
  return request<{ ok: boolean }>(`/api/v1/projects/${projectId}/git-config`, {
    method: 'PUT',
    body: JSON.stringify(config),
  });
}

export function deleteProjectGitConfig(projectId: string) {
  return request<{ ok: boolean }>(`/api/v1/projects/${projectId}/git-config`, {
    method: 'DELETE',
  });
}
