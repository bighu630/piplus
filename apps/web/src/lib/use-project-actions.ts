import { useCallback, startTransition } from 'react';
import {
  useArchiveProjectMutation,
  useDeleteProjectMutation,
  useSetProjectPinnedMutation,
  useTree,
} from './hooks';

interface UseProjectActionsArgs {
  treeQuery: ReturnType<typeof useTree>;
  setSelectedProjectId: (projectId: string) => void;
  setShowProjectSettings: (open: boolean) => void;
}

/** 项目级操作：归档 / 删除 / 置顶 / 打开项目设置。 */
export function useProjectActions({
  treeQuery,
  setSelectedProjectId,
  setShowProjectSettings,
}: UseProjectActionsArgs) {
  const archiveProjectMut = useArchiveProjectMutation();
  const deleteProjectMut = useDeleteProjectMutation();
  const setProjectPinnedMut = useSetProjectPinnedMutation();

  const handleArchiveProject = useCallback((projectId: string) => {
    archiveProjectMut.mutate(projectId);
  }, [archiveProjectMut]);

  const handleDeleteProject = useCallback((projectId: string) => {
    deleteProjectMut.mutate(projectId);
  }, [deleteProjectMut]);

  const handleToggleProjectPinned = useCallback(async (projectId: string, pinned: boolean) => {
    try {
      await setProjectPinnedMut.mutateAsync({ projectId, pinned });
      await treeQuery.refetch();
    } catch {}
  }, [setProjectPinnedMut, treeQuery]);

  const handleOpenProjectSettings = useCallback((projectId: string) => {
    startTransition(() => {
      setSelectedProjectId(projectId);
      setShowProjectSettings(true);
    });
  }, [setSelectedProjectId, setShowProjectSettings]);

  return {
    handleArchiveProject,
    handleDeleteProject,
    handleToggleProjectPinned,
    handleOpenProjectSettings,
  };
}
