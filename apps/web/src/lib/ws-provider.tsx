import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import type { ServerMessage, ProjectDTO, SessionTreeNodeDTO } from '@piplus/shared';
import { createWorkspaceSocket } from './ws-client';
import { useQueryClient } from '@tanstack/react-query';
import { sendSystemNotification } from './notification';
import { findSessionNode, updateNodeRuntimeStatus } from './tree-utils';

type RuntimeStatus = 'running' | 'idle';

interface WebSocketContextValue {
  connected: boolean;
  localRuntimeStatusBySession: Record<string, RuntimeStatus>;
  subscribeToStream: (cb: (msg: any) => void) => () => void;
  setSessionContext: (sessionId: string | null, projectId: string | null, activeTab: string) => void;
  subscribeToRuntimeErrors: (cb: (error: {sessionId: string; error: string}) => void) => () => void;
  subscribeToMessages: (cb: (msg: any) => void) => () => void;
  sendRaw: (msg: Record<string, unknown>) => void;
}

const WebSocketContext = createContext<WebSocketContextValue | null>(null);



const NOTIFIABLE_ROLE_KEYS = new Set(['planner', 'feature_lead', 'bugfix_lead']);
const NOTIFICATION_ROLE_LABELS: Record<string, string> = {
  planner: 'Planner',
  feature_lead: 'Feature Lead',
  bugfix_lead: 'Bugfix Lead',
};

function systemNotificationsEnabled(): boolean {
  try { return localStorage.getItem('pi-system-notifications') === 'true'; } catch { return false; }
}

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [localRuntimeStatusBySession, setLocalRuntimeStatusBySession] = useState<Record<string, RuntimeStatus>>({});
  const queryClient = useQueryClient();
  const streamListenersRef = useRef<Set<(msg: any) => void>>(new Set());
  const runtimeErrorListenersRef = useRef<Set<(error: {sessionId: string; error: string}) => void>>(new Set());
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
          if (message.kind === 'chat_stream' && message.scope?.session_id === currentSessionId) {
            // Notify streaming subscribers (TabChat)
            streamListenersRef.current.forEach(cb => cb(message));

            if (message.phase === 'complete') {
              Promise.all([
                queryClient.refetchQueries({ queryKey: ['session', 'messages', currentSessionId] }),
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
                        const label = NOTIFICATION_ROLE_LABELS[node.role_template_key] ?? node.role_template_key;
                        sendSystemNotification(`PiPlus：${label} 出错`, {
                          body: `会话「${node.title}」发生错误：${errorText}`,
                        });
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

            queryClient.refetchQueries({ queryKey: ['tree'] });

            if (status === 'running') {
              if (eventSessionId === currentSessionId) {
                queryClient.invalidateQueries({ queryKey: ['session', 'messages', currentSessionId] });
              }
              if (eventSessionId) {
                notifiedRef.current.delete(`done:${eventSessionId}`);
              }
            }

            if (status === 'idle') {
              const idleError = (message.payload as any)?.error;
              if (idleError && typeof idleError === 'string' && idleError && eventSessionId === currentSessionId) {
                runtimeErrorListenersRef.current.forEach(cb => cb({ sessionId: eventSessionId!, error: idleError }));
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
                        const label = NOTIFICATION_ROLE_LABELS[node.role_template_key] ?? node.role_template_key;
                        sendSystemNotification(`PiPlus：${label} 出错`, {
                          body: `会话「${node.title}」发生错误：${idleError}`,
                        });
                      }
                    } else {
                      const doneKey = `done:${eventSessionId}`;
                      if (!notifiedRef.current.has(doneKey)) {
                        notifiedRef.current.add(doneKey);
                        const label = NOTIFICATION_ROLE_LABELS[node.role_template_key] ?? node.role_template_key;
                        sendSystemNotification(`PiPlus：${label} 已完成`, {
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

  const subscribeToStream = useCallback((cb: (msg: any) => void): (() => void) => {
    streamListenersRef.current.add(cb);
    return () => { streamListenersRef.current.delete(cb); };
  }, []);

  const subscribeToRuntimeErrors = useCallback((cb: (error: {sessionId: string; error: string}) => void): (() => void) => {
    runtimeErrorListenersRef.current.add(cb);
    return () => { runtimeErrorListenersRef.current.delete(cb); };
  }, []);

  const subscribeToMessages = useCallback((cb: (msg: any) => void): (() => void) => {
    messageListenersRef.current.add(cb);
    return () => { messageListenersRef.current.delete(cb); };
  }, []);

  const sendRaw = useCallback((msg: Record<string, unknown>) => {
    console.log('[WSProvider] sendRaw called:', msg);
    if (!socketRef.current) {
      console.warn('[WSProvider] socketRef.current is null, cannot send');
      return;
    }
    socketRef.current.sendRaw?.(msg);
  }, []);

  return (
    <WebSocketContext.Provider value={{ connected, localRuntimeStatusBySession, subscribeToStream, setSessionContext, subscribeToRuntimeErrors, subscribeToMessages, sendRaw }}>
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
