import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getSessionGitDiff,
  getSessionFileTree,
  getSessionFileContent,
  saveSessionFileContent,
  deleteSessionFile,
  gitPull,
  gitPush,
  gitCommit,
  addGitignore,
  getGitBranches,
  getGitTags,
  getRemoteTags,
  createGitTag,
  pushGitTags,
  gitCheckout,
  getGitCommits,
  getGitShow,
  type GitRefType,
} from '../api';

export function useSessionGitDiff(sessionId: string | null) {
  return useQuery({
    queryKey: ['session', 'git-diff', sessionId],
    queryFn: () => getSessionGitDiff(sessionId!),
    enabled: Boolean(sessionId),
    staleTime: 10_000,
  });
}

export function useSessionFileTree(sessionId: string | null) {
  return useQuery({
    queryKey: ['session', 'files', 'tree', sessionId],
    queryFn: () => getSessionFileTree(sessionId!),
    enabled: Boolean(sessionId),
    staleTime: 10_000,
  });
}

export function useSessionFileContent(sessionId: string | null, path: string | null) {
  return useQuery({
    queryKey: ['session', 'files', 'content', sessionId, path],
    queryFn: () => getSessionFileContent(sessionId!, path!),
    enabled: Boolean(sessionId && path),
    staleTime: 10_000,
  });
}

export function useSaveSessionFileContentMutation(sessionId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ path, content }: { path: string; content: string }) =>
      saveSessionFileContent(sessionId!, path, content),
    onSuccess: (_data, variables) => {
      // Invalidate the specific file content query
      queryClient.invalidateQueries({ queryKey: ['session', 'files', 'content', sessionId, variables.path] });
      // Also invalidate the file tree (size may have changed)
      queryClient.invalidateQueries({ queryKey: ['session', 'files', 'tree', sessionId] });
    },
  });
}

export function useDeleteSessionFileMutation(sessionId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ path }: { path: string }) =>
      deleteSessionFile(sessionId!, path),
    onSuccess: (_data, variables) => {
      // Invalidate the specific file content query so the preview clears
      queryClient.invalidateQueries({ queryKey: ['session', 'files', 'content', sessionId, variables.path] });
      // Invalidate the file tree so the deleted file disappears
      queryClient.invalidateQueries({ queryKey: ['session', 'files', 'tree', sessionId] });
    },
  });
}

export function useGitPullMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => gitPull(sessionId),
    onSuccess: (_data, sessionId) => {
      queryClient.invalidateQueries({ queryKey: ['session', 'git-diff', sessionId] });
      queryClient.invalidateQueries({ queryKey: ['session', 'git-commits', sessionId] });
    },
  });
}

export function useGitPushMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => gitPush(sessionId),
    onSuccess: (_data, sessionId) => {
      queryClient.invalidateQueries({ queryKey: ['session', 'git-diff', sessionId] });
    },
  });
}

export function useGitCommitMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, message }: { sessionId: string; message: string }) => gitCommit(sessionId, message),
    onSuccess: (_data, { sessionId }) => {
      queryClient.invalidateQueries({ queryKey: ['session', 'git-diff', sessionId] });
      queryClient.invalidateQueries({ queryKey: ['session', 'git-commits', sessionId] });
    },
  });
}

export function useAddGitignoreMutation() {
  return useMutation({
    mutationFn: ({ sessionId, path }: { sessionId: string; path: string }) => addGitignore(sessionId, path),
  });
}

export function useGitBranches(sessionId: string | null) {
  return useQuery({
    queryKey: ['session', 'git-branches', sessionId],
    queryFn: () => getGitBranches(sessionId!),
    enabled: Boolean(sessionId),
    staleTime: 10_000,
  });
}

export function useGitTags(sessionId: string | null) {
  return useQuery({
    queryKey: ['session', 'git-tags', sessionId],
    queryFn: () => getGitTags(sessionId!),
    enabled: Boolean(sessionId),
    staleTime: 10_000,
  });
}

/** Remote tag state (`git ls-remote --tags`). Resolves with `remote_ok: false` instead of throwing
 * when there is no remote or the network fails, so a broken remote never breaks the Git page. */
export function useRemoteTags(sessionId: string | null) {
  return useQuery({
    queryKey: ['session', 'git-remote-tags', sessionId],
    queryFn: () => getRemoteTags(sessionId!),
    enabled: Boolean(sessionId),
    staleTime: 30_000,
  });
}

export function useCreateGitTagMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, name, message }: { sessionId: string; name: string; message?: string }) =>
      createGitTag(sessionId, name, message),
    onSuccess: (_data, { sessionId }) => {
      queryClient.invalidateQueries({ queryKey: ['session', 'git-tags', sessionId] });
    },
  });
}

export function usePushGitTagsMutation() {
  const queryClient = useQueryClient();
  // A batch push can partially succeed (some refs pushed, then a conflict fails the command),
  // so refresh both the local and the remote tag state on error as well as on success.
  const invalidateTagState = (sessionId: string) => {
    queryClient.invalidateQueries({ queryKey: ['session', 'git-tags', sessionId] });
    queryClient.invalidateQueries({ queryKey: ['session', 'git-remote-tags', sessionId] });
  };
  return useMutation({
    mutationFn: ({ sessionId, names }: { sessionId: string; names?: string[] }) => pushGitTags(sessionId, names),
    onSuccess: (_data, { sessionId }) => invalidateTagState(sessionId),
    onError: (_error, { sessionId }) => invalidateTagState(sessionId),
  });
}

export function useGitCheckoutMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, ref, type }: { sessionId: string; ref: string; type?: GitRefType }) =>
      gitCheckout(sessionId, ref, type ?? 'branch'),
    onSuccess: (_data, { sessionId }) => {
      // Invalidate both branches list and git diff since checkout may change working tree
      queryClient.invalidateQueries({ queryKey: ['session', 'git-branches', sessionId] });
      queryClient.invalidateQueries({ queryKey: ['session', 'git-tags', sessionId] });
      queryClient.invalidateQueries({ queryKey: ['session', 'git-diff', sessionId] });
      queryClient.invalidateQueries({ queryKey: ['session', 'git-commits', sessionId] });
    },
  });
}

export function useGitCommits(sessionId: string | null, limit: number = 50) {
  return useQuery({
    queryKey: ['session', 'git-commits', sessionId, limit],
    queryFn: () => getGitCommits(sessionId!, limit),
    enabled: Boolean(sessionId),
    staleTime: 30_000,
  });
}

export function useGitShow(sessionId: string | null, hash: string | null) {
  return useQuery({
    queryKey: ['session', 'git-show', sessionId, hash],
    queryFn: () => getGitShow(sessionId!, hash!),
    enabled: Boolean(sessionId && hash),
    staleTime: 60_000,
  });
}
