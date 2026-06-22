import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getTree,
  getSessionInfo,
  getSessionMessages,
  checkAuth,
  login,
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
  gitPull,
  gitPush,
  gitCommit,
  type ModelInfo,
} from './api';

// Auth
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

// Models
export function useModels() {
  return useQuery({
    queryKey: ['models'],
    queryFn: async () => (await getModels()).models,
    staleTime: 60_000,
  });
}

export function useSetSessionModelMutation() {
  return useMutation({
    mutationFn: ({ sessionId, provider, id }: { sessionId: string; provider: string; id: string }) =>
      setSessionModel(sessionId, { provider, id }),
  });
}

// Tree
export function useTree() {
  return useQuery({
    queryKey: ['tree'],
    queryFn: getTree,
  });
}

// Session info
export function useSessionInfo(sessionId: string | null) {
  return useQuery({
    queryKey: ['session', 'info', sessionId],
    queryFn: () => getSessionInfo(sessionId!),
    enabled: Boolean(sessionId),
    staleTime: 10_000,
  });
}

// Messages
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

// Git diff
export function useSessionGitDiff(sessionId: string | null) {
  return useQuery({
    queryKey: ['session', 'git-diff', sessionId],
    queryFn: () => getSessionGitDiff(sessionId!),
    enabled: Boolean(sessionId),
    staleTime: 10_000,
  });
}

// Mutations
export function useCreateProjectMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { name: string; mode?: string; path?: string; repoUrl?: string }) =>
      createProject(params.name, params.mode, params.path, params.repoUrl),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['tree'] });
    },
  });
}

export function useCreateSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { projectId: string; inheritModel?: ModelInfo | null }) =>
      createProjectSession(input.projectId, input.inheritModel),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['tree'] });
    },
  });
}

export function useSendMessageMutation(sessionId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (content: string) => sendSessionMessage(sessionId!, content),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['session', 'messages', sessionId] });
    },
  });
}

export function useStopSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => stopSession(sessionId),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['tree'] });
      queryClient.invalidateQueries({ queryKey: ['session'] });
    },
  });
}

export function useArchiveSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => archiveSession(sessionId),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['tree'] });
      queryClient.invalidateQueries({ queryKey: ['session'] });
    },
  });
}

export function useUpdateSessionTitleMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, title }: { sessionId: string; title: string }) =>
      updateSessionTitle(sessionId, title),
    onSettled: (_data, _error, vars) => {
      queryClient.invalidateQueries({ queryKey: ['session', 'info', vars.sessionId] });
      queryClient.invalidateQueries({ queryKey: ['tree'] });
    },
  });
}

export function useArchiveProjectMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => archiveProject(projectId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['tree'] }),
  });
}

export function useDeleteProjectMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => deleteProject(projectId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['tree'] }),
  });
}

// Git mutations
export function useGitPullMutation(sessionId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => gitPull(sessionId!),
    onSettled: () => {
      if (sessionId) {
        queryClient.invalidateQueries({ queryKey: ['session', 'git-diff', sessionId] });
      }
    },
  });
}

export function useGitPushMutation(sessionId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => gitPush(sessionId!),
    onSettled: () => {
      if (sessionId) {
        queryClient.invalidateQueries({ queryKey: ['session', 'git-diff', sessionId] });
      }
    },
  });
}

export function useGitCommitMutation(sessionId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (message: string) => gitCommit(sessionId!, message),
    onSettled: () => {
      if (sessionId) {
        queryClient.invalidateQueries({ queryKey: ['session', 'git-diff', sessionId] });
      }
    },
  });
}
