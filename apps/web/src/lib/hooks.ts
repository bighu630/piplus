import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getTree,
  getSessionInfo,
  getSessionContextUsage,
  compactSession,
  getSessionMessages,
  checkAuth,
  login,
  getModelsStatus,
  getModels,
  setSessionModel,
  archiveProject,
  deleteProject,
  createProject,
  createProjectSession,
  sendSessionMessage,
  stopSession,
  archiveSession,
  updateSessionTitle,
  getSessionGitDiff,
  getSessionFileTree,
  getSessionFileContent,
  gitPull,
  gitPush,
  gitCommit,
  addGitignore,
  testModelProvider,
  createModelProvider,
  type ModelInfo,
  type ProviderFormPayload,
} from './api';

export function useAuthSession() {
  return useQuery({
    queryKey: ['auth', 'session'],
    queryFn: async () => {
      const token = localStorage.getItem('piplus_token');
      if (!token) return null;
      return checkAuth(token);
    },
    retry: false,
    staleTime: 5 * 60_000,
  });
}

export function useLoginMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (password: string) => login(password),
    onSuccess: (data) => {
      localStorage.setItem('piplus_token', data.token);
      queryClient.setQueryData(['auth', 'session'], data);
    },
  });
}

export function useLogoutMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      localStorage.removeItem('piplus_token');
    },
    onSettled: () => {
      queryClient.clear();
    },
  });
}

export function useModelsStatus() {
  return useQuery({
    queryKey: ['models', 'status'],
    queryFn: getModelsStatus,
    retry: false,
    staleTime: 30_000,
  });
}

export function useModels() {
  return useQuery({
    queryKey: ['models'],
    queryFn: async () => (await getModels()).models,
    staleTime: 60_000,
  });
}

export function useTestModelProviderMutation() {
  return useMutation({
    mutationFn: testModelProvider,
  });
}

export function useCreateModelProviderMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ProviderFormPayload) => createModelProvider(payload),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['models'] }),
        queryClient.invalidateQueries({ queryKey: ['models', 'status'] }),
      ]);
    },
  });
}

export function useSetSessionModelMutation() {
  return useMutation({
    mutationFn: ({ sessionId, provider, id }: { sessionId: string; provider: string; id: string }) =>
      setSessionModel(sessionId, { provider, id }),
  });
}

export function useTree() {
  return useQuery({
    queryKey: ['tree'],
    queryFn: getTree,
  });
}

export function useSessionInfo(sessionId: string | null) {
  return useQuery({
    queryKey: ['session', 'info', sessionId],
    queryFn: () => getSessionInfo(sessionId!),
    enabled: Boolean(sessionId),
    staleTime: 10_000,
  });
}

export function useSessionMessages(sessionId: string | null, limit = 20) {
  return useInfiniteQuery({
    queryKey: ['session', 'messages', sessionId],
    queryFn: ({ pageParam }) => getSessionMessages(sessionId!, { cursor: pageParam, limit }),
    initialPageParam: '0',
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    enabled: Boolean(sessionId),
    staleTime: 0,
  });
}

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

export function useCreateProjectMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { name: string; mode?: string; path?: string; repoUrl?: string; model?: ModelInfo | null }) =>
      createProject(params.name, params.mode, params.path, params.repoUrl, params.model ?? null),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['tree'] });
    },
  });
}

export function useCreateSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId }: { projectId: string }) => createProjectSession(projectId),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['tree'] });
    },
  });
}

export function useSendMessageMutation(sessionId: string | null) {
  return useMutation({
    mutationFn: (content: string) => sendSessionMessage(sessionId!, content),
  });
}

export function useStopSessionMutation() {
  return useMutation({
    mutationFn: (sessionId: string) => stopSession(sessionId),
  });
}

export function useArchiveSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => archiveSession(sessionId),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['tree'] });
    },
  });
}

export function useArchiveProjectMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => archiveProject(projectId),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['tree'] });
    },
  });
}

export function useDeleteProjectMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => deleteProject(projectId),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['tree'] });
    },
  });
}

export function useUpdateSessionTitleMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, title }: { sessionId: string; title: string }) => updateSessionTitle(sessionId, title),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['session', 'info', variables.sessionId] });
      queryClient.invalidateQueries({ queryKey: ['tree'] });
    },
  });
}

export function useGitPullMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => gitPull(sessionId),
    onSuccess: (_data, sessionId) => {
      queryClient.invalidateQueries({ queryKey: ['session', 'git-diff', sessionId] });
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
    },
  });
}

export function useAddGitignoreMutation() {
  return useMutation({
    mutationFn: ({ sessionId, path }: { sessionId: string; path: string }) => addGitignore(sessionId, path),
  });
}

export function useSessionContextUsage(sessionId: string | null) {
  return useQuery({
    queryKey: ['session', 'context-usage', sessionId],
    queryFn: () => getSessionContextUsage(sessionId!),
    enabled: Boolean(sessionId),
    staleTime: 30_000,
    retry: false,
  });
}

export function useCompactSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => compactSession(sessionId),
    // Speculative refresh after 202 accepted; real invalidation
    // comes from WS session.compacted / session.compaction_end events
    onSuccess: (data) => {
      if (data.accepted) {
        queryClient.invalidateQueries({ queryKey: ['session', 'context-usage', data.session_id] });
      }
    },
  });
}
