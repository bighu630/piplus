import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getTree,
  getSessionInfo,
  getSessionContextUsage,
  compactSession,
  getSessionMessages,
  getPlannerRolePrompt,
  checkAuth,
  login,
  getModelsStatus,
  getModels,
  setSessionModel,
  archiveProject,
  deleteProject,
  setProjectPinned,
  createProject,
  createProjectSession,
  sendSessionMessage,
  stopSession,
  archiveSession,
  updateSessionTitle,
  setSessionPinned,
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
  gitCheckout,
  testModelProvider,
  createModelProvider,
  getProjectRoleModels,
  setProjectRoleModels,
  getNativeModelProviders,
  setNativeProviderApiKey,
  type ModelInfo,
  type ProviderFormPayload,
  type SendSessionMessagePayload,
  getPackages,
  installPackage,
  removePackage,
  updatePackages,
  getPackageUpdates,
  getProjectTodos,
  createProjectTodo,
  updateProjectTodo,
  deleteProjectTodo,
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

export function useSessionMessages(sessionId: string | null, limit = 20, refetchInterval?: number | false) {
  return useInfiniteQuery({
    queryKey: ['session', 'messages', sessionId],
    queryFn: ({ pageParam }) => getSessionMessages(sessionId!, { cursor: pageParam, limit }),
    initialPageParam: '0',
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    enabled: Boolean(sessionId),
    staleTime: 0,
    refetchInterval,
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
    mutationFn: (payload: SendSessionMessagePayload) => sendSessionMessage(sessionId!, payload),
  });
}

export function usePlannerRolePromptMutation() {
  return useMutation({
    mutationFn: (sessionId: string) => getPlannerRolePrompt(sessionId),
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

export function useSetSessionPinnedMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, pinned }: { sessionId: string; pinned: boolean }) => setSessionPinned(sessionId, pinned),
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

export function useSetProjectPinnedMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, pinned }: { projectId: string; pinned: boolean }) => setProjectPinned(projectId, pinned),
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

export function useGitBranches(sessionId: string | null) {
  return useQuery({
    queryKey: ['session', 'git-branches', sessionId],
    queryFn: () => getGitBranches(sessionId!),
    enabled: Boolean(sessionId),
    staleTime: 10_000,
  });
}

export function useGitCheckoutMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, branch }: { sessionId: string; branch: string }) => gitCheckout(sessionId, branch),
    onSuccess: (_data, { sessionId }) => {
      // Invalidate both branches list and git diff since checkout may change working tree
      queryClient.invalidateQueries({ queryKey: ['session', 'git-branches', sessionId] });
      queryClient.invalidateQueries({ queryKey: ['session', 'git-diff', sessionId] });
    },
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

export function useProjectRoleModels(projectId: string | null) {
  return useQuery({
    queryKey: ['project', 'role-models', projectId],
    queryFn: () => getProjectRoleModels(projectId!),
    enabled: Boolean(projectId),
    staleTime: 10_000,
  });
}

export function useSetProjectRoleModelsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, models }: { projectId: string; models: Record<string, { provider: string; id: string } | null> }) =>
      setProjectRoleModels(projectId, models),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['project', 'role-models', variables.projectId] });
      queryClient.invalidateQueries({ queryKey: ['tree'] });
    },
  });
}

export function useNativeModelProviders() {
  return useQuery({
    queryKey: ['models', 'native-providers'],
    queryFn: getNativeModelProviders,
    staleTime: 30_000,
  });
}

export function useSetNativeProviderApiKeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ provider, apiKey }: { provider: string; apiKey: string }) =>
      setNativeProviderApiKey(provider, apiKey),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['models'] }),
        queryClient.invalidateQueries({ queryKey: ['models', 'status'] }),
        queryClient.invalidateQueries({ queryKey: ['models', 'native-providers'] }),
      ]);
    },
  });
}

// ── Package Management Hooks ─────────────────────────────────────────

export function usePackages() {
  return useQuery({
    queryKey: ['packages'],
    queryFn: async () => {
      const res = await getPackages();
      return res.packages;
    },
    staleTime: 10_000,
  });
}

export function useInstallPackageMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ source, local, projectId }: { source: string; local?: boolean; projectId?: string }) =>
      installPackage(source, local, projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['packages'] });
      queryClient.invalidateQueries({ queryKey: ['packages', 'updates'] });
    },
  });
}

export function useRemovePackageMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ source, local, projectId }: { source: string; local?: boolean; projectId?: string }) =>
      removePackage(source, local, projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['packages'] });
      queryClient.invalidateQueries({ queryKey: ['packages', 'updates'] });
    },
  });
}

export function useUpdatePackagesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (source?: string) => updatePackages(source),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['packages'] });
      queryClient.invalidateQueries({ queryKey: ['packages', 'updates'] });
    },
  });
}

export function usePackageUpdates() {
  return useQuery({
    queryKey: ['packages', 'updates'],
    queryFn: async () => {
      const res = await getPackageUpdates();
      return res.updates;
    },
    staleTime: 60_000,
  });
}

export function useProjectTodos(projectId: string | null) {
  return useQuery({
    queryKey: ['project', 'todos', projectId],
    queryFn: () => getProjectTodos(projectId!),
    enabled: Boolean(projectId),
    staleTime: 5_000,
  });
}

export function useCreateProjectTodoMutation(projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => createProjectTodo(projectId!, text),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', 'todos', projectId] });
    },
  });
}

export function useUpdateProjectTodoMutation(projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ todoId, patch }: { todoId: string; patch: { text?: string; done?: boolean; sort_order?: number } }) =>
      updateProjectTodo(projectId!, todoId, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', 'todos', projectId] });
    },
  });
}

export function useDeleteProjectTodoMutation(projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (todoId: string) => deleteProjectTodo(projectId!, todoId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', 'todos', projectId] });
    },
  });
}
