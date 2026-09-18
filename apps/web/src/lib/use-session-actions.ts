import { useCallback, startTransition } from 'react';
import type { ProjectDTO } from '@piplus/shared';
import { useQueryClient } from '@tanstack/react-query';
import { findProjectId, findSessionNode } from './tree-utils';
import {
  useArchiveSessionMutation,
  useCompactSessionMutation,
  useCreateSessionMutation,
  usePlannerRolePromptMutation,
  useSendMessageMutation,
  useSessionMessages,
  useSetSessionModelMutation,
  useSetSessionPinnedMutation,
  useSetSessionThinkingLevelMutation,
  useStopSessionMutation,
  useTree,
} from './hooks';
import type { SessionMessageImageAttachment } from './api';

interface UseSessionActionsArgs {
  selectedSessionId: string | null;
  selectedProjectId: string | null;
  setSelectedSessionId: (sessionId: string) => void;
  tree: ProjectDTO[];
  treeQuery: ReturnType<typeof useTree>;
  messagesQuery: ReturnType<typeof useSessionMessages>;
  /** 归档后跳回根会话 */
  onSelectSession: (projectId: string, sessionId: string) => void;
}

/** 会话级操作：新建 / 发送 / 停止 / 压缩 / 归档 / 置顶 / 模型与思考级别 / 加载更多。 */
export function useSessionActions({
  selectedSessionId,
  selectedProjectId,
  setSelectedSessionId,
  tree,
  treeQuery,
  messagesQuery,
  onSelectSession,
}: UseSessionActionsArgs) {
  const queryClient = useQueryClient();
  const createSessionMut = useCreateSessionMutation();
  const sendMessageMut = useSendMessageMutation(selectedSessionId);
  const stopSessionMut = useStopSessionMutation();
  const archiveSessionMut = useArchiveSessionMutation();
  const setSessionPinnedMut = useSetSessionPinnedMutation();
  const compactSessionMut = useCompactSessionMutation();
  const plannerRolePromptMut = usePlannerRolePromptMutation();
  const setModelMut = useSetSessionModelMutation();
  const setThinkingLevelMut = useSetSessionThinkingLevelMutation();

  const handleCreateSession = useCallback(async () => {
    if (!selectedProjectId) return;
    try {
      const result = await createSessionMut.mutateAsync({ projectId: selectedProjectId });
      startTransition(() => {
        setSelectedSessionId(result.session_id);
      });
      await treeQuery.refetch();
    } catch {}
  }, [selectedProjectId, setSelectedSessionId, createSessionMut, treeQuery]);

  const handleSend = useCallback(async (content: string, attachments: SessionMessageImageAttachment[] = []) => {
    if (!selectedSessionId) return;
    try {
      await sendMessageMut.mutateAsync({ content, attachments });
    } finally {
      // 失败路径也要刷新：vision relay 插入的 error 历史消息需要出现在会话视图
      queryClient.invalidateQueries({ queryKey: ['session', 'messages', selectedSessionId] });
    }
  }, [selectedSessionId, sendMessageMut, queryClient]);

  const handleStop = useCallback(async () => {
    if (!selectedSessionId) return;
    await stopSessionMut.mutateAsync(selectedSessionId);
  }, [selectedSessionId, stopSessionMut]);

  const handleCompactSession = useCallback(async () => {
    if (!selectedSessionId) return;
    try {
      await compactSessionMut.mutateAsync(selectedSessionId);
    } catch { /* compaction errors are non-critical */ }
  }, [selectedSessionId, compactSessionMut]);

  const handleArchiveSession = useCallback(async (sessionId?: string) => {
    // TabChat 的 onClick 直绑会把 React MouseEvent 作为首个实参传入（truthy），
    // 导致 targetId 变成 '[object Object]' 而 404 —— 此处强制类型守卫。
    if (typeof sessionId !== 'string') sessionId = undefined;
    const targetId = sessionId ?? selectedSessionId;
    if (!targetId) return;
    const targetNode = findSessionNode(tree, targetId);
    const rootId = targetNode?.root_session_id;
    await archiveSessionMut.mutateAsync(targetId);
    await treeQuery.refetch();
    const pid = rootId ? findProjectId(tree, rootId) : null;
    if (rootId && rootId !== targetId && pid) {
      onSelectSession(pid, rootId);
    }
  }, [selectedSessionId, tree, archiveSessionMut, treeQuery, onSelectSession]);

  const handleToggleSessionPinned = useCallback(async (sessionId: string, pinned: boolean) => {
    try {
      await setSessionPinnedMut.mutateAsync({ sessionId, pinned });
      await treeQuery.refetch();
    } catch {}
  }, [setSessionPinnedMut, treeQuery]);

  const handleSendPlannerRolePrompt = useCallback(async () => {
    if (!selectedSessionId) return;
    const confirmed = confirm('仅在你觉得 planner 变得不会分配工作时使用，确定重新发送提示词吗？\n\n频繁发送可能会浪费一点点 context。');
    if (!confirmed) return;
    const result = await plannerRolePromptMut.mutateAsync(selectedSessionId);
    if (!result.prompt) return;
    await handleSend(result.prompt, []);
  }, [selectedSessionId, plannerRolePromptMut, handleSend]);

  const handleModelSelect = useCallback(async (provider: string, id: string) => {
    if (!selectedSessionId) return;
    await setModelMut.mutateAsync({ sessionId: selectedSessionId, provider, id });
    queryClient.invalidateQueries({ queryKey: ['session', 'info', selectedSessionId] });
    queryClient.invalidateQueries({ queryKey: ['session', 'thinking-level', selectedSessionId] });
  }, [selectedSessionId, setModelMut, queryClient]);

  const handleThinkingLevelSelect = useCallback((level: string) => {
    if (selectedSessionId) {
      setThinkingLevelMut.mutate({ sessionId: selectedSessionId, level });
    }
  }, [selectedSessionId, setThinkingLevelMut]);

  const handleLoadMore = useCallback(() => {
    if (messagesQuery.hasNextPage && !messagesQuery.isFetchingNextPage) {
      messagesQuery.fetchNextPage();
    }
  }, [messagesQuery]);

  return {
    handleCreateSession,
    creatingSession: createSessionMut.isPending,
    handleSend,
    sending: sendMessageMut.isPending,
    handleStop,
    handleCompactSession,
    compactPending: compactSessionMut.isPending,
    handleArchiveSession,
    archivePending: archiveSessionMut.isPending,
    handleToggleSessionPinned,
    handleSendPlannerRolePrompt,
    plannerRolePromptPending: plannerRolePromptMut.isPending,
    handleModelSelect,
    handleThinkingLevelSelect,
    handleLoadMore,
  };
}
