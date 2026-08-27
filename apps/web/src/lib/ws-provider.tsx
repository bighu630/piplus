import React, { createContext, useContext, useEffect, useRef, useState, useCallback, useMemo } from 'react';
import type { ServerMessage, ProjectDTO, SessionTreeNodeDTO, AskQuestionPendingPayload } from '@piplus/shared';
import { isAskQuestionPending } from '@piplus/shared';
import { createWorkspaceSocket } from './ws-client';
import { getAskPending } from './api';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthSession, useAuthStatus } from './hooks';
import { sendSystemNotification } from './notification';
import { findSessionNode, updateNodeRuntimeStatus } from './tree-utils';
import {
  INITIAL_CHAT_STREAM_SNAPSHOT,
  createThrottledFlusher,
  reduceChatStreamSnapshot,
  type ChatStreamEvent,
  type ChatStreamSnapshot,
} from './chat-stream-state';

type RuntimeStatus = 'running' | 'idle' | 'stopping';

interface WebSocketContextValue {
  connected: boolean;
  localRuntimeStatusBySession: Record<string, RuntimeStatus>;
  subscribeToStream: (cb: (stream: { sessionId: string; snapshot: ChatStreamSnapshot }) => void) => () => void;
  chatStream: { useChatStream: (sessionId: string | null) => ChatStreamSnapshot };
  setSessionContext: (sessionId: string | null, projectId: string | null, activeTab: string) => void;
  clearStreamRuntimeErrors: (sessionId: string | null) => void;
  subscribeToMessages: (cb: (msg: any) => void) => () => void;
  /** 订阅 ask_question_pending：工具发起提问等待回答时回调（含单题与问卷）。 */
  subscribeToAskQuestionPending: (cb: (payload: AskQuestionPendingPayload) => void) => () => void;
  /** 全局待回答的 ask_question（按 questionId），跨会话持久，切换回来不丢失 */
  askingPendingMap: Record<string, AskQuestionPendingPayload>;
  /** 清理指定 questionId 的待回答（提交后或工具结果到达时） */
  clearAskPending?: (questionId: string) => void;
  sendRaw: (msg: Record<string, unknown>) => void;
}

const WebSocketContext = createContext<WebSocketContextValue | null>(null);



const NOTIFIABLE_ROLE_KEYS = new Set(['planner', 'feature_lead', 'bugfix_lead']);

// 停止状态兜底超时：后端保证 ~15s 内复位 idle，前端 30s 双保险，超时未收敛则清除本地 stopping 并刷新真实状态
const STOPPING_FALLBACK_TIMEOUT_MS = 30_000;

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
  const askQuestionPendingListenersRef = useRef<Set<(payload: AskQuestionPendingPayload) => void>>(new Set());
  const [askingPendingMap, setAskingPendingMap] = useState<Record<string, AskQuestionPendingPayload>>({});
  const askingPendingMapRef = useRef<Record<string, AskQuestionPendingPayload>>({});
  const socketRef = useRef<ReturnType<typeof createWorkspaceSocket> | null>(null);
  const stoppingFallbackTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // 登录态：与 App.tsx 同源（auth status/session 查询）。WS 建连 effect 依赖它：
  // 4401 登出后 isLoggedIn 变 false → 关闭死连接；重新登录后变 true → 用新 token 重建连接。
  // 依赖是稳定的布尔值，auth 查询解析期间（undefined→false）不会翻转，避免重连风暴。
  const authStatusQuery = useAuthStatus();
  const authSessionQuery = useAuthSession();
  const isLoggedIn = authStatusQuery.data?.requiresPassword === false || Boolean(authSessionQuery.data?.ok);

  // Refs for latest values used in closures
  const selectedSessionIdRef = useRef<string | null>(null);
  const selectedProjectIdRef = useRef<string | null>(null);
  const activeTabRef = useRef<string>('chat');
  const prevSubscribedSessionRef = useRef<string | null>(null);
  const notifiedRef = useRef<Set<string>>(new Set());

  // Expose setters for App to call when session/tab changes
  const setSessionContext = useCallback((sessionId: string | null, projectId: string | null, activeTab: string) => {
    selectedSessionIdRef.current = sessionId;
    selectedProjectIdRef.current = projectId;
    activeTabRef.current = activeTab;
    // 服务端定向投递：切会话时退订旧会话、订阅新会话，并补拉消息
    // 弥补定向期间错过的流式中间内容
    const prev = prevSubscribedSessionRef.current;
    if (prev && prev !== sessionId) {
      socketRef.current?.unsubscribeSession(prev);
    }
    if (sessionId && sessionId !== prev) {
      socketRef.current?.subscribeSession(sessionId);
      queryClient.invalidateQueries({ queryKey: ['session', 'messages', sessionId] });
      // 刷新后重建：WS 事件在刷新前已发送，内存已清，需从后端拉取待回答以重建表单/琥珀灯
      getAskPending(sessionId)
        .then((res) => {
          if (res.pending?.length) {
            const next = { ...askingPendingMapRef.current };
            let changed = false;
            for (const p of res.pending) {
              if (p.questionId && !next[p.questionId]) {
                next[p.questionId] = p as AskQuestionPendingPayload;
                changed = true;
              }
            }
            if (changed) {
              askingPendingMapRef.current = next;
              setAskingPendingMap(next);
            }
          }
        })
        .catch(() => {});
    }
    prevSubscribedSessionRef.current = sessionId;
    socketRef.current?.setContext({
      project_id: projectId ?? undefined,
      session_id: sessionId ?? undefined,
      current_tab: activeTab === 'info' ? 'session_info' : activeTab === 'diff' ? 'git_diff' : activeTab === 'files' || activeTab === 'doce' ? 'files' : activeTab === 'terminal' ? 'terminal' : 'chat',
    });
  }, [queryClient]);

  // 清除指定 session 的 stopping 兜底定时器（running/idle/stopping 事件到达时调用）
  const clearStoppingFallback = useCallback((sessionId: string) => {
    const t = stoppingFallbackTimersRef.current.get(sessionId);
    if (t) {
      clearTimeout(t);
      stoppingFallbackTimersRef.current.delete(sessionId);
    }
  }, []);

  // Main WS connection effect — 随登录态重建（登出关闭旧连接，重新登录以新 token 新建）
  useEffect(() => {
    if (!isLoggedIn) {
      // 未登录 / 已登出：确保旧 socket（含 4401 停摆后的死连接）被关闭，不发起建连。
      socketRef.current?.close();
      socketRef.current = null;
      prevSubscribedSessionRef.current = null;
      setConnected(false);
      return;
    }
    const socket = createWorkspaceSocket({
      onMessage(event) {
        try {
          const message = JSON.parse(event.data as string) as ServerMessage;
          const currentSessionId = selectedSessionIdRef.current;

          // Notify all message subscribers (terminal events, etc.)
          messageListenersRef.current.forEach(cb => cb(message));

          // ═══ ask_question pending ═══
          // 工具发起提问：全局持久化（含非活跃会话），切换回来不丢失；
          // 同时通知订阅者，Sidebar 据此将对应会话的绿灯覆为琥珀色。
          if (isAskQuestionPending(message)) {
            const payload = message.payload;
            if (payload?.questionId) {
              askingPendingMapRef.current = { ...askingPendingMapRef.current, [payload.questionId]: payload };
              setAskingPendingMap({ ...askingPendingMapRef.current });
            }
            askQuestionPendingListenersRef.current.forEach(cb => cb(payload));
          }

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
              if (eventSessionId) {
                clearStoppingFallback(eventSessionId);
              }
              if (eventSessionId === currentSessionId) {
                queryClient.invalidateQueries({ queryKey: ['session', 'messages', currentSessionId] });
              }
              if (eventSessionId) {
                notifiedRef.current.delete(`done:${eventSessionId}`);
              }
            }

            if (status === 'stopping') {
              // 乐观更新侧栏为 stopping，并 arm 30s 兜底：后端保证 ~15s 内复位 idle，
              // 这里双保险，超时未收敛则清除本地 stopping 并刷新真实状态。
              if (eventSessionId) {
                clearStoppingFallback(eventSessionId);
                queryClient.setQueryData(['tree'], (old: { projects: ProjectDTO[] } | undefined) => {
                  if (!old) return old;
                  return {
                    ...old,
                    projects: old.projects.map(project => ({
                      ...project,
                      sessions: updateNodeRuntimeStatus(project.sessions, eventSessionId, 'stopping'),
                    })),
                  };
                });
                const timer = setTimeout(() => {
                  stoppingFallbackTimersRef.current.delete(eventSessionId);
                  setLocalRuntimeStatusBySession(prev => {
                    if (prev[eventSessionId] !== 'stopping') return prev;
                    const { [eventSessionId]: _, ...rest } = prev;
                    return rest;
                  });
                  queryClient.invalidateQueries({ queryKey: ['tree'] });
                  queryClient.invalidateQueries({ queryKey: ['session', 'info', eventSessionId] });
                  queryClient.invalidateQueries({ queryKey: ['session', 'messages', eventSessionId] });
                }, STOPPING_FALLBACK_TIMEOUT_MS);
                stoppingFallbackTimersRef.current.set(eventSessionId, timer);
              }
            }

            if (status === 'idle') {
              if (eventSessionId) {
                clearStoppingFallback(eventSessionId);
              }
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
        if (selectedSessionIdRef.current) {
          socket.subscribeSession(selectedSessionIdRef.current);
          prevSubscribedSessionRef.current = selectedSessionIdRef.current;
        }
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
      // 组件卸载：遍历清除所有 stopping 兜底定时器（不调用 clearStoppingFallback，
      // 避免 cleanup 早于其定义执行时的 TDZ 问题）
      stoppingFallbackTimersRef.current.forEach(t => clearTimeout(t));
      stoppingFallbackTimersRef.current.clear();
    };
  }, [isLoggedIn]); // 登录态变化时重建连接

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

  const subscribeToAskQuestionPending = useCallback(
    (cb: (payload: AskQuestionPendingPayload) => void): (() => void) => {
      askQuestionPendingListenersRef.current.add(cb);
      return () => { askQuestionPendingListenersRef.current.delete(cb); };
    },
    [],
  );

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

  // ask_question 回答后（工具结果经 messages 轮询落库，runtime 变 idle），前端可按需清理
  // 此处提供清理器：TabChat 提交成功或检测到 tool result 时调用，可让琥珀灯熄灭
  const clearAskPending = useCallback((questionId: string) => {
    if (!questionId) return;
    if (!askingPendingMapRef.current[questionId]) return;
    const { [questionId]: _, ...rest } = askingPendingMapRef.current;
    askingPendingMapRef.current = rest;
    setAskingPendingMap({ ...rest });
  }, []);

  // 暴露给 context：TabChat 提交后可调用，Sidebar 仅消费 askingPendingMap
  const contextValue = useMemo(() => ({
    connected,
    localRuntimeStatusBySession,
    subscribeToStream,
    setSessionContext,
    clearStreamRuntimeErrors,
    subscribeToMessages,
    subscribeToAskQuestionPending,
    askingPendingMap,
    clearAskPending,
    sendRaw,
    chatStream: chatStreamValue,
  }), [connected, localRuntimeStatusBySession, subscribeToStream, setSessionContext, clearStreamRuntimeErrors, subscribeToMessages, subscribeToAskQuestionPending, askingPendingMap, chatStreamValue]);

  return (
    <WebSocketContext.Provider value={contextValue as unknown as WebSocketContextValue}>
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
