import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getTree,
  getProjectGitConfig,
  updateProjectGitConfig,
  deleteProjectGitConfig,
  createProject,
  archiveProject,
  setProjectPinned,
  deleteProject,
  type ModelInfo,
  type RoleConfigEntry,
} from '../api';

export function useTree() {
  return useQuery({
    queryKey: ['tree'],
    queryFn: getTree,
  });
}

export function useProjectGitConfig(projectId: string | null) {
  return useQuery({
    queryKey: ['project', 'git-config', projectId],
    queryFn: () => getProjectGitConfig(projectId!),
    enabled: Boolean(projectId),
    staleTime: 10_000,
  });
}

export function useUpdateProjectGitConfigMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, config }: { projectId: string; config: { userName?: string; userEmail?: string; token?: string } }) =>
      updateProjectGitConfig(projectId, config),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['project', 'git-config', variables.projectId] });
    },
  });
}

export function useDeleteProjectGitConfigMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => deleteProjectGitConfig(projectId),
    onSuccess: (_data, projectId) => {
      queryClient.invalidateQueries({ queryKey: ['project', 'git-config', projectId] });
    },
  });
}

export function useCreateProjectMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { name: string; mode?: string; path?: string; repoUrl?: string; model?: ModelInfo | null; gitConfig?: { userName?: string; userEmail?: string; token?: string } | null; roleConfig?: Record<string, RoleConfigEntry | null> }) =>
      createProject(params.name, params.mode, params.path, params.repoUrl, params.model ?? null, params.gitConfig, params.roleConfig),
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
