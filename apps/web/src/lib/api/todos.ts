import { request } from './client';
import type { ProjectTodoDTO } from '@piplus/shared';

export function getProjectTodos(projectId: string) {
  return request<ProjectTodoDTO[]>(`/api/v1/projects/${projectId}/todos`);
}

export function createProjectTodo(projectId: string, text: string) {
  return request<ProjectTodoDTO>(`/api/v1/projects/${projectId}/todos`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
}

export function updateProjectTodo(projectId: string, todoId: string, patch: { text?: string; done?: boolean; sort_order?: number }) {
  return request<ProjectTodoDTO>(`/api/v1/projects/${projectId}/todos/${todoId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function deleteProjectTodo(projectId: string, todoId: string) {
  return request<{ ok: boolean }>(`/api/v1/projects/${projectId}/todos/${todoId}`, {
    method: 'DELETE',
  });
}

// ── Role Templates ──────────────────────────────────────────────────
