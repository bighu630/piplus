import React, { createContext, useContext, useEffect, useRef, useState, useCallback, useMemo } from 'react';
import type { ServerMessage, ProjectDTO, SessionTreeNodeDTO } from '@piplus/shared';
import { createWorkspaceSocket } from './ws-client';
import { useQueryClient } from '@tanstack/react-query';
import { sendSystemNotification } from './notification';
import { findSessionNode, updateNodeRuntimeStatus } from './tree-utils';
import {
  INITIAL_CHAT_STREAM_SNAPSHOT,
  createThrottledFlusher,
  reduceChatStreamSnapshot,
  type ChatStreamEvent,
  type ChatStreamSnapshot,
} from './chat-stream-state';

type RuntimeStatus = 'running' | 'idle';

interface WebSocketContextValue {
  connected: boolean;
  localRuntimeStatusBySession: Record<string, RuntimeStatus>;
  subscribeToStream: (cb: (stream: { sessionId: string; snapshot: ChatStreamSnapshot }) => void) => () => void;
  chatStream: { useChatStream: (sessionId: string | null) => ChatStreamSnapshot };
  setSessionContext: (sessionId: string | null, projectId: string | null, activeTab: string) => void;
  clearStreamRuntimeErrors: (sessionId: string | null) => void;
  subscribeToMessages: (cb: (msg: any) => void) => () => void;
  sendRaw: (msg: Record<string, unknown>) => void;
}

const WebSocketContext = createContext<WebSocketContextValue | null>(null);



const NOTIFIABLE_ROLE_KEYS = new Set(['planner', 'feature_lead', 'bugfix_lead']);

function systemNotificationsEnabled(): boolean {
  try { return localStorage.getItem('pi-system-notifications') === 'true'; } catch { return false; }
}

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [localRuntimeStatusBySession, setLocalRuntimeStatusBySession] = useState<Record<string, RuntimeStatus>>({});
  const queryClient = useQueryClient();
  const streamListenersRef = useRef<Set<(stream: { sessionId: string; snapshot: ChatStreamSnapshot }) => void>>(new Set());
  // 流式快照：按 sessionId 全局累积，TabChat 卸载/切会话不丢流式内容
  const streamSnapshotsRef = useRef<Record<string, ChatStreamSnapshot>>({});
  const messageListenersRef = useRef<Set<(msg: any) => void>>(new Set());
  const socketRef = useRef<ReturnType<typeof createWorkspaceSocket> | null>(null);

  // Refs for latest values used in closures
  const selectedSessionIdRef = useRef<string | null>(null);
  const selectedProjectIdRef = useRef<string | null>(null);
  const activeTabRef = useRef<string>('chat');
  const notifiedRef = useRef<Set<string>>(new Set());

  // Expose setters for App to call when session/tab changes
  const setSessionContext = useCallback((sessionId: string | null, projectId: string | null, activeTab: string) => {
    selectedSessionIdRef.current = sessionId;
    selectedProjectIdRef.current = projectId;
    activeTabRef.current = activeTab;
    socketRef.current?.setContext({
      project_id: projectId ?? undefined,
      session_id: sessionId ?? undefined,
      current_tab: activeTab === 'info' ? 'session_info' : activeTab === 'diff' ? 'git_diff' : activeTab === 'files' || activeTab === 'doce' ? 'files' : activeTab === 'terminal' ? 'terminal' : 'chat',
    });
  }, []);

  // Main WS connection effect — only on mount/unmount
  useEffect(() => {
    const socket = createWorkspaceSocket({
      onMessage(event) {
        try {
          const message = JSON.parse(event.data as string) as ServerMessage;
          const currentSessionId = selectedSessionIdRef.current;

          // Notify all message subscribers (terminal events, etc.)
          messageListenersRef.current.forEach(cb => cb(message));

          // ═══ Chat stream events ═══
          if (message.kind === 'chat_stream' && message.scope?.session_id) {
            // 流式快照：所有 session 都累积，不做 currentSessionId 过滤
            const streamSessionId = message.scope.session_id;
            const streamEvent: ChatStreamEvent = message.phase === 'start'
              ? { type: 'start', delta: message.payload?.delta ?? '' }
              : message.phase === 'delta'
                ? { type: 'delta', delta: message.payload?.delta ?? '' }
                : message.phase === 'complete'
                  ? { type: 'complete' }
                  : { type: 'error', error: message.payload?.error ?? 'Unknown agent loop error', runId: message.payload?.stream_id ?? 'unknown' };
            streamSnapshotsRef.current[streamSessionId] = reduceChatStreamSnapshot(
              streamSnapshotsRef.current[streamSessionId] ?? INITIAL_CHAT_STREAM_SNAPSHOT,
              streamEvent,
            );

            // 现有 currentSessionId 过滤转发逻辑保持不变
            if (streamSessionId === currentSessionId) {
              // Notify streaming subscribers (TabChat / useChatStream)
              streamListenersRef.current.forEach(cb => cb({ sessionId: streamSessionId, snapshot: streamSnapshotsRef.current[streamSessionId] }));

              if (message.phase === 'complete') {
              Promise.all([
                queryClient.invalidateQueries({ queryKey: ['session', 'messages', currentSessionId] }),
                queryClient.invalidateQueries({ queryKey: ['session', 'commands', currentSessionId] }),
                queryClient.invalidateQueries({ queryKey: ['session', 'info', currentSessionId] }),
                queryClient.invalidateQueries({ queryKey: ['session', 'context-usage', currentSessionId] }),
              ]);
            }
            if (message.phase === 'error') {
              // System notification for chat_stream error
              if (systemNotificationsEnabled()) {
                const msg = message as any;
                if (msg.scope?.session_id) {
                  const errorText = msg.payload?.error ?? 'Unknown agent loop error';
                  const treeData = queryClient.getQueryData<{ projects: ProjectDTO[] }>(['tree']);
                  if (treeData) {
                    const node = findSessionNode(treeData.projects, msg.scope.session_id);
                    if (node && NOTIFIABLE_ROLE_KEYS.has(node.role_template_key)) {
                      const errorKey = `error:${msg.scope.session_id}:${errorText}`;
                      if (!notifiedRef.current.has(errorKey)) {
                        notifiedRef.current.add(errorKey);
                        sendSystemNotification(`PiPlus：${node.title} 出错`, {
                          body: `会话「${node.title}」发生错误：${errorText}`,
                        });
                      }
                    }
                  }
                }
              }
              }
            }
          }

          // ═══ Runtime status changed ═══
          if (message.kind === 'event' && message.type === 'session.runtime_status_changed') {
            const eventSessionId = message.scope?.session_id as string | undefined;
            const status = message.payload?.runtime_status as RuntimeStatus | undefined;

            if (eventSessionId && status) {
              setLocalRuntimeStatusBySession(prev => ({ ...prev, [eventSessionId]: status }));
            }

            queryClient.invalidateQueries({ queryKey: ['tree'] });

            if (status === 'running') {
              if (eventSessionId === currentSessionId) {
                queryClient.invalidateQueries({ queryKey: ['session', 'messages', currentSessionId] });
              }
              if (eventSessionId) {
                notifiedRef.current.delete(`done:${eventSessionId}`);
              }
            }

            if (status === 'idle') {
              // 流式快照：idle 带错误则记入快照，否则全清（现有逻辑保持不动）
              if (eventSessionId) {
                const idleError = (message.payload as any)?.error;
                const snapshotEvent: ChatStreamEvent = (typeof idleError === 'string' && idleError)
                  ? { type: 'error', error: idleError, runId: 'runtime-status' }
                  : { type: 'runtime_idle' };
                streamSnapshotsRef.current[eventSessionId] = reduceChatStreamSnapshot(
                  streamSnapshotsRef.current[eventSessionId] ?? INITIAL_CHAT_STREAM_SNAPSHOT,
                  snapshotEvent,
                );
                // 非当前会话的 runtime_idle 快照已无人读取：删除条目防止快照 map 无限增长
                if (snapshotEvent.type === 'runtime_idle' && eventSessionId !== currentSessionId) {
                  delete streamSnapshotsRef.current[eventSessionId];
                }
                // 通知流式订阅者（useChatStream 需要实时拿到 idle/error 快照）
                if (eventSessionId === currentSessionId) {
                  streamListenersRef.current.forEach(cb => cb({ sessionId: eventSessionId, snapshot: streamSnapshotsRef.current[eventSessionId] }));
                }
              }

              if (eventSessionId === currentSessionId) {
                Promise.all([
                  queryClient.invalidateQueries({ queryKey: ['session', 'info', currentSessionId] }),
                  queryClient.invalidateQueries({ queryKey: ['session', 'messages', currentSessionId] }),
                ]);
                setLocalRuntimeStatusBySession(prev => {
                  if (!currentSessionId) return prev;
                  const { [currentSessionId]: _, ...rest } = prev;
                  return rest;
                });
              } else {
                if (eventSessionId) {
                  queryClient.invalidateQueries({ queryKey: ['session', 'info', eventSessionId] });
                  queryClient.invalidateQueries({ queryKey: ['session', 'messages', eventSessionId] });
                }
                setLocalRuntimeStatusBySession(prev => {
                  if (!eventSessionId) return prev;
                  const { [eventSessionId]: _, ...rest } = prev;
                  return rest;
                });
              }

              // Local tree update for sidebar
              if (eventSessionId) {
                queryClient.setQueryData(['tree'], (old: { projects: ProjectDTO[] } | undefined) => {
                  if (!old) return old;
                  return {
                    ...old,
                    projects: old.projects.map(project => ({
                      ...project,
                      sessions: updateNodeRuntimeStatus(project.sessions, eventSessionId!, 'idle'),
                    })),
                  };
                });
              }

              // System notifications for idle
              if (systemNotificationsEnabled() && eventSessionId) {
                const treeData = queryClient.getQueryData<{ projects: ProjectDTO[] }>(['tree']);
                if (treeData) {
                  const node = findSessionNode(treeData.projects, eventSessionId);
                  if (node && NOTIFIABLE_ROLE_KEYS.has(node.role_template_key)) {
                    const idleError = (message.payload as any)?.error;
                    if (idleError && typeof idleError === 'string' && idleError) {
                      const errorKey = `error:${eventSessionId}:${idleError}`;
                      if (!notifiedRef.current.has(errorKey)) {
                        notifiedRef.current.add(errorKey);
                        sendSystemNotification(`PiPlus：${node.title} 出错`, {
                          body: `会话「${node.title}」发生错误：${idleError}`,
                        });
                      }
                    } else {
                      const doneKey = `done:${eventSessionId}`;
                      if (!notifiedRef.current.has(doneKey)) {
                        notifiedRef.current.add(doneKey);
                        sendSystemNotification(`PiPlus：${node.title} 已完成`, {
                          body: `会话「${node.title}」已完成。`,
                        });
                      }
                    }
                  }
                }
              }
            }
          }

          // ═══ Tree/session events ═══
          if (message.kind === 'event' && (
            message.type === 'tree.changed' ||
            message.type === 'project.created' ||
            message.type === 'session.created' ||
            message.type === 'session.archived'
          )) {
            queryClient.refetchQueries({ queryKey: ['tree'] });
          }

          if (message.kind === 'event' && message.type === 'runtime.restored') {
            if (currentSessionId) {
              queryClient.invalidateQueries({ queryKey: ['session', 'commands', currentSessionId] });
              queryClient.invalidateQueries({ queryKey: ['session', 'info', currentSessionId] });
            }
          }

          if (message.kind === 'event' && (
            message.type === 'session.compaction_end' ||
            message.type === 'session.compacted'
          )) {
            const eventSessionId = (message.payload as Record<string, unknown>)?.session_id ?? currentSessionId;
            if (typeof eventSessionId === 'string' && eventSessionId) {
              queryClient.invalidateQueries({ queryKey: ['session', 'context-usage', eventSessionId] });
            }
          }
        } catch {
          // ignore JSON parse errors
        }
      },
      onOpen() {
        setConnected(true);
        setLocalRuntimeStatusBySession({});
        socket.hello();
        socket.setContext({
          project_id: selectedProjectIdRef.current ?? undefined,
          session_id: selectedSessionIdRef.current ?? undefined,
          current_tab: activeTabRef.current === 'info' ? 'session_info' : activeTabRef.current === 'diff' ? 'git_diff' : activeTabRef.current === 'files' || activeTabRef.current === 'doce' ? 'files' : activeTabRef.current === 'terminal' ? 'terminal' : 'chat',
        });
        socket.ping();
        queryClient.refetchQueries({ queryKey: ['tree'] });
        if (selectedSessionIdRef.current) {
          queryClient.invalidateQueries({ queryKey: ['session', 'info', selectedSessionIdRef.current] });
          queryClient.invalidateQueries({ queryKey: ['session', 'messages', selectedSessionIdRef.current] });
        }
      },
      onClose() {
        setConnected(false);
      },
    });
    socketRef.current = socket;

    return () => {
      socketRef.current = null;
      socket.close();
    };
  }, []); // Only on mount

  const subscribeToStream = useCallback((cb: (stream: { sessionId: string; snapshot: ChatStreamSnapshot }) => void): (() => void) => {
    streamListenersRef.current.add(cb);
    return () => { streamListenersRef.current.delete(cb); };
  }, []);

  // 清除指定 session 的运行时错误（发送新消息时调用，避免旧错误残留显示）
  const clearStreamRuntimeErrors = useCallback((sessionId: string | null) => {
    const key = sessionId ?? '';
    const snap = streamSnapshotsRef.current[key];
    if (snap && snap.runtimeErrors.length > 0) {
      const next = { ...snap, runtimeErrors: [] };
      streamSnapshotsRef.current[key] = next;
      // 通知订阅者同步 useChatStream 的本地 state
      streamListenersRef.current.forEach(cb => cb({ sessionId: key, snapshot: next }));
    }
  }, []);

  const subscribeToMessages = useCallback((cb: (msg: any) => void): (() => void) => {
    messageListenersRef.current.add(cb);
    return () => { messageListenersRef.current.delete(cb); };
  }, []);

  const sendRaw = useCallback((msg: Record<string, unknown>) => {
    socketRef.current?.sendRaw?.(msg);
  }, []);

  // ⚠️ hook-in-context 模式：本 hook 经 context 属性（chatStream.useChatStream）暴露给子组件调用。
  // 它虽在 provider 渲染期间定义，但内部 hook（useState/useRef/useEffect）的 state 归因于调用方 fiber，
  // 因此只能作为组件顶层 hook 无条件调用，绝不能放进事件回调 / 条件分支 / 循环中。
  const useChatStreamImpl = useCallback((sessionId: string | null): ChatStreamSnapshot => {
    const key = sessionId ?? '';
    const [snapshot, setSnapshot] = useState<ChatStreamSnapshot>(
      () => streamSnapshotsRef.current[key] ?? INITIAL_CHAT_STREAM_SNAPSHOT,
    );

    useEffect(() => {
      // sessionId 变化：立即同步最新快照并重置节流器（跳过节流窗口）
      setSnapshot(streamSnapshotsRef.current[key] ?? INITIAL_CHAT_STREAM_SNAPSHOT);

      // 节流 flush 器：连续 delta 合并为一次 setState；complete/error 立即 flush（不等待窗口，
      // 否则 complete 与 runtime_idle 在 80ms 内相继到达时被合并，完整内容占位会被跳过）
      const flusher = createThrottledFlusher<ChatStreamSnapshot>(
        (value) => setSnapshot(value),
        80,
      );

      const listener = (stream: { sessionId: string; snapshot: ChatStreamSnapshot }) => {
        if (stream.sessionId !== key) return;
        flusher.push(
          stream.snapshot,
          stream.snapshot.phase === 'complete' || stream.snapshot.phase === 'error',
        );
      };
      streamListenersRef.current.add(listener);
      return () => {
        streamListenersRef.current.delete(listener);
        // 卸载 / 切会话清理节流定时器，防止旧会话快照延迟冲刷到新会话视图
        flusher.dispose();
      };
    }, [key]);

    return snapshot;
  }, []);

  // 稳定 chatStream context 引用（impl 经 useCallback 固定，memo 不会随 provider 渲染重建）
  const chatStreamValue = useMemo(() => ({ useChatStream: useChatStreamImpl }), [useChatStreamImpl]);

  return (
    <WebSocketContext.Provider value={{ connected, localRuntimeStatusBySession, subscribeToStream, setSessionContext, clearStreamRuntimeErrors, subscribeToMessages, sendRaw, chatStream: chatStreamValue }}>
      {children}
    </WebSocketContext.Provider>
  );
}

export function useWebSocket() {
  const ctx = useContext(WebSocketContext);
  if (!ctx) throw new Error('useWebSocket must be used within <WebSocketProvider>');
  return ctx;
}

export function useWebSocketConnected() {
  return useWebSocket().connected;
}

// 按 sessionId 读取全局流式快照（内部经 context 分发到 provider 内的实现）
export function useChatStream(sessionId: string | null): ChatStreamSnapshot {
  return useWebSocket().chatStream.useChatStream(sessionId);
}
