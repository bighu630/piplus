import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getRoleTemplates,
  getRoleTemplate,
  createRoleTemplate,
  updateRoleTemplate,
  deleteRoleTemplate,
  getProjectRoleConfig,
  setProjectRoleConfig,
  getSettings,
  putSettings,
  type RoleConfigEntry,
} from '../api';

export function useRoleTemplates() {
  return useQuery({
    queryKey: ['role-templates'],
    queryFn: getRoleTemplates,
    staleTime: 10_000,
  });
}

export function useRoleTemplate(id: string | null) {
  return useQuery({
    queryKey: ['role-templates', id],
    queryFn: () => getRoleTemplate(id!),
    enabled: Boolean(id),
    staleTime: 10_000,
  });
}

export function useCreateRoleTemplateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { key: string; version: string; basePrompt?: string; name?: string; description?: string; icon?: string }) =>
      createRoleTemplate(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['role-templates'] });
    },
  });
}

export function useUpdateRoleTemplateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...payload }: { id: string; basePrompt?: string; name?: string; description?: string; icon?: string }) =>
      updateRoleTemplate(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['role-templates'] });
    },
  });
}

export function useDeleteRoleTemplateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteRoleTemplate(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['role-templates'] });
    },
  });
}

// ── Project Role Config Hooks ───────────────────────────────────────

export function useProjectRoleConfig(projectId: string | null) {
  return useQuery({
    queryKey: ['project', 'role-config', projectId],
    queryFn: () => getProjectRoleConfig(projectId!),
    enabled: Boolean(projectId),
    staleTime: 10_000,
  });
}

export function useSetProjectRoleConfigMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, config }: { projectId: string; config: Record<string, RoleConfigEntry | null> }) =>
      setProjectRoleConfig(projectId, config),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['project', 'role-config', variables.projectId] });
      queryClient.invalidateQueries({ queryKey: ['tree'] });
    },
  });
}

// ── Settings Hooks ────────────────────────────────────────────────

export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
    staleTime: 10_000,
  });
}

export function useUpdateSettingsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, number | string>) => putSettings(patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });
}
