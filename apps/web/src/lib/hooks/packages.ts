import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getPackages,
  installPackage,
  removePackage,
  updatePackages,
  togglePackage,
  getPackageUpdates,
  getProjectTodos,
  createProjectTodo,
  updateProjectTodo,
  deleteProjectTodo,
} from '../api';

export function usePackages(projectId?: string | null) {
  return useQuery({
    queryKey: ['packages', projectId ?? 'global'],
    queryFn: async () => {
      const res = await getPackages(projectId ?? undefined);
      return res.packages;
    },
    enabled: projectId !== null,
    staleTime: 10_000,
  });
}

export function useInstallPackageMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ source, local, projectId }: { source: string; local?: boolean; projectId?: string }) =>
      installPackage(source, local, projectId),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['packages'] });
      queryClient.invalidateQueries({ queryKey: ['packages', 'updates'] });
      if (vars.projectId) {
        queryClient.invalidateQueries({ queryKey: ['packages', vars.projectId] });
        queryClient.invalidateQueries({ queryKey: ['packages', 'updates', vars.projectId] });
      }
    },
  });
}

export function useRemovePackageMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ source, local, projectId }: { source: string; local?: boolean; projectId?: string }) =>
      removePackage(source, local, projectId),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['packages'] });
      queryClient.invalidateQueries({ queryKey: ['packages', 'updates'] });
      if (vars.projectId) {
        queryClient.invalidateQueries({ queryKey: ['packages', vars.projectId] });
        queryClient.invalidateQueries({ queryKey: ['packages', 'updates', vars.projectId] });
      }
    },
  });
}

export function useUpdatePackagesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars?: string | { source?: string; projectId?: string }) => {
      if (typeof vars === 'string') return updatePackages(vars);
      if (vars === undefined) return updatePackages(undefined);
      return updatePackages(vars.source, vars.projectId);
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['packages'] });
      queryClient.invalidateQueries({ queryKey: ['packages', 'updates'] });
      const projectId = typeof vars === 'object' ? vars?.projectId : undefined;
      if (projectId) {
        queryClient.invalidateQueries({ queryKey: ['packages', projectId] });
        queryClient.invalidateQueries({ queryKey: ['packages', 'updates', projectId] });
      }
    },
  });
}

export function useTogglePackageMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ source, filtered, local, projectId }: { source: string; filtered: boolean; local?: boolean; projectId?: string }) =>
      togglePackage(source, filtered, local, projectId),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['packages'] });
      queryClient.invalidateQueries({ queryKey: ['packages', 'updates'] });
      if (vars.projectId) {
        queryClient.invalidateQueries({ queryKey: ['packages', vars.projectId] });
        queryClient.invalidateQueries({ queryKey: ['packages', 'updates', vars.projectId] });
      }
    },
  });
}

export function usePackageUpdates(projectId?: string | null) {
  return useQuery({
    queryKey: ['packages', 'updates', projectId ?? 'global'],
    queryFn: async () => {
      const res = await getPackageUpdates(projectId ?? undefined);
      return res.updates;
    },
    enabled: projectId !== null,
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

// ── Slash Commands ───────────────────────────────────────────────────
