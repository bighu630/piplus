import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getModelsStatus,
  getModels,
  testModelProvider,
  createModelProvider,
  getModelProviders,
  updateModelProvider,
  deleteModelProvider,
  setSessionModel,
  getSessionThinkingLevel,
  setSessionThinkingLevel,
  getProjectRoleModels,
  setProjectRoleModels,
  getNativeModelProviders,
  setNativeProviderApiKey,
  type ProviderFormPayload,
  type ProviderUpdatePayload,
} from '../api';

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
        queryClient.invalidateQueries({ queryKey: ['models', 'providers'] }),
      ]);
    },
  });
}

export function useModelProvidersQuery() {
  return useQuery({
    queryKey: ['models', 'providers'],
    queryFn: getModelProviders,
    staleTime: 30_000,
    retry: false,
  });
}

export function useUpdateModelProviderMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ providerKey, payload }: { providerKey: string; payload: ProviderUpdatePayload }) =>
      updateModelProvider(providerKey, payload),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['models', 'providers'] }),
        queryClient.invalidateQueries({ queryKey: ['models'] }),
        queryClient.invalidateQueries({ queryKey: ['models', 'status'] }),
      ]);
    },
  });
}

export function useDeleteModelProviderMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (providerKey: string) => deleteModelProvider(providerKey),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['models', 'providers'] }),
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

export function useSessionThinkingLevel(sessionId: string | null) {
  return useQuery({
    queryKey: ['session', 'thinking-level', sessionId],
    queryFn: () => getSessionThinkingLevel(sessionId!),
    enabled: Boolean(sessionId),
    staleTime: 10_000,
  });
}

export function useSetSessionThinkingLevelMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, level }: { sessionId: string; level: string }) =>
      setSessionThinkingLevel(sessionId, level),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['session', 'thinking-level', variables.sessionId] });
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
    mutationFn: ({ projectId, models }: { projectId: string; models: Record<string, import('../api').RoleModelEntry | null> }) =>
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
