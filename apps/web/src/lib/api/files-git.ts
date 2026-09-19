import { request } from './client';
import type {
  SessionFileTreeResponseDTO,
  SessionFileContentResponseDTO,
  SessionFileSaveResponseDTO,
  SessionFileDeleteResponseDTO,
} from '@piplus/shared';

export function getSessionGitDiff(sessionId: string) {
  return request<{ session_id: string; diff: string; cwd: string; missing_worktree_path?: string | null }>(`/api/v1/sessions/${sessionId}/git-diff`);
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

export function deleteSessionFile(sessionId: string, path: string) {
  return request<SessionFileDeleteResponseDTO>(`/api/v1/sessions/${sessionId}/files/content`, {
    method: 'DELETE',
    body: JSON.stringify({ path }),
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

export type GitRefType = 'branch' | 'tag';

export function getGitBranches(sessionId: string) {
  return request<{ session_id: string; cwd: string; current_branch: string; branches: Array<{ name: string; is_current: boolean; is_worktree: boolean; worktree_path: string | null }>; session_worktree_path: string | null; missing_worktree_path?: string | null; detached: boolean; detached_ref: string | null }>(
    `/api/v1/sessions/${sessionId}/git/branches`,
  );
}

export function getGitTags(sessionId: string) {
  return request<{
    session_id: string;
    cwd: string;
    detached: boolean;
    tags: Array<{ name: string; is_current: boolean; is_annotated: boolean; date: string; subject: string; sha: string }>;
  }>(`/api/v1/sessions/${sessionId}/git/tags`);
}

/**
 * Create a tag at HEAD. A non-empty `message` produces an annotated tag, otherwise a lightweight one.
 * Git failures (e.g. a duplicate name) come back as a non-2xx response, so `request()` rejects with
 * git's stderr in `Error#message` — surface that directly in the UI.
 */
export function createGitTag(sessionId: string, name: string, message?: string) {
  return request<{
    session_id: string;
    cwd: string;
    result: 'ok' | 'error';
    stdout?: string;
    stderr?: string;
    name: string;
    annotated: boolean;
  }>(`/api/v1/sessions/${sessionId}/git/tags`, {
    method: 'POST',
    body: JSON.stringify({ name, message }),
  });
}

/**
 * Push tags to the resolved remote. Omitting `names` pushes every tag that is missing from (or
 * different from) the remote. Failures reject with git's stderr in `Error#message`.
 */
export function pushGitTags(sessionId: string, names?: string[]) {
  return request<{
    session_id: string;
    cwd: string;
    result: 'ok' | 'error';
    stdout?: string;
    stderr?: string;
    pushed: string[];
    remote: string;
  }>(`/api/v1/sessions/${sessionId}/git/tags/push`, {
    method: 'POST',
    body: JSON.stringify(names ? { names } : {}),
  });
}

/**
 * Read the remote's tag list so the UI can flag tags that have not been pushed.
 * The endpoint degrades gracefully: when no remote exists or the network fails it still
 * resolves with 200 and `remote_ok: false`, so callers must check `remote_ok`.
 */
export function getRemoteTags(sessionId: string) {
  return request<{
    session_id: string;
    cwd: string;
    remote_ok: boolean;
    remote: string | null;
    error: string | null;
    tags: Array<{ name: string; sha: string }>;
  }>(`/api/v1/sessions/${sessionId}/git/remote-tags`);
}

export function gitCheckout(sessionId: string, ref: string, type: GitRefType = 'branch') {
  return request<GitActionResult & { branch: string }>(
    `/api/v1/sessions/${sessionId}/git/checkout`,
    { method: 'POST', body: JSON.stringify({ ref, type }) },
  );
}

export function getGitCommits(sessionId: string, limit: number = 50) {
  const params = new URLSearchParams({ limit: String(limit) });
  return request<{
    session_id: string;
    cwd: string;
    commits: Array<{ hash: string; message: string; author: string; date: string; refs: string }>;
  }>(`/api/v1/sessions/${sessionId}/git/commits?${params.toString()}`);
}

export function getGitShow(sessionId: string, hash: string) {
  const params = new URLSearchParams({ hash });
  return request<{
    session_id: string;
    cwd: string;
    hash: string;
    message: string;
    author: string;
    date: string;
    diff: string;
  }>(`/api/v1/sessions/${sessionId}/git/show?${params.toString()}`);
}
