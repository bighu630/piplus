import { request } from './client';

export type PiPackageScope = 'user' | 'project';

export type PiPackageListItem = {
  source: string;
  scope: PiPackageScope;
  filtered: boolean;
  installedPath?: string;
};

export type PiPackageUpdate = {
  source: string;
  displayName: string;
  type: 'npm' | 'git';
  scope: 'user' | 'project';
};

export function getPackages(projectId?: string) {
  const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
  return request<{ packages: PiPackageListItem[] }>(`/api/v1/packages${query}`);
}

export function installPackage(source: string, local?: boolean, projectId?: string) {
  return request<{ ok: boolean }>('/api/v1/packages/install', {
    method: 'POST',
    body: JSON.stringify({ source, local, project_id: projectId }),
  });
}

export function removePackage(source: string, local?: boolean, projectId?: string) {
  return request<{ ok: boolean }>('/api/v1/packages/remove', {
    method: 'POST',
    body: JSON.stringify({ source, local, project_id: projectId }),
  });
}

export function updatePackages(source?: string, projectId?: string) {
  return request<{ ok: boolean }>('/api/v1/packages/update', {
    method: 'POST',
    body: JSON.stringify({ source, local: !!projectId, project_id: projectId }),
  });
}

export function togglePackage(source: string, filtered: boolean, local?: boolean, projectId?: string) {
  return request<{ ok: boolean }>('/api/v1/packages/toggle', {
    method: 'POST',
    body: JSON.stringify({ source, filtered, local, project_id: projectId }),
  });
}

export function getPackageUpdates(projectId?: string) {
  const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
  return request<{ updates: PiPackageUpdate[] }>(`/api/v1/packages/updates${query}`);
}
