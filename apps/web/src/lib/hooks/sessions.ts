import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getSessionInfo,
  getSessionMessages,
  sendSessionMessage,
  getPlannerRolePrompt,
  stopSession,
  archiveSession,
  setSessionPinned,
  updateSessionTitle,
  getSessionContextUsage,
  compactSession,
  getSessionCommands,
  createProjectSession,
  type SendSessionMessagePayload,
} from '../api';

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

export function useSessionCommands(sessionId: string | null) {
  return useQuery({
    queryKey: ['session', 'commands', sessionId],
    queryFn: async () => {
      const res = await getSessionCommands(sessionId!);
      return res.commands;
    },
    enabled: Boolean(sessionId),
    staleTime: 0,
  });
}

// ── Role Templates Hooks ────────────────────────────────────────────

export function useCreateSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId }: { projectId: string }) => createProjectSession(projectId),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['tree'] });
    },
  });
}
