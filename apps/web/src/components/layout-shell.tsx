'use client';

import { Archive, ArrowLeft, ChevronLeft, FolderTree, LogOut, PanelLeftClose, PanelLeftOpen, Plus, SquarePen, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useMediaQuery } from '../lib/use-media-query';
import type { ChatMessageDTO, SessionInfoDTO, TreeResponse } from '@piplus/shared';
import { createWorkspaceSocket } from '../lib/ws-client';
import { ChatPanel } from './chat-panel';
import { CreateProjectModal } from './create-project-modal';
import { LoginScreen } from './login-screen';
import { ProjectTree } from './project-tree';
import { SessionInfoPanel } from './session-info-panel';
import { ScrollArea } from './ui/scroll-area';
import { TabsBar } from './ui/tabs-bar';
import {
  useAuthSession,
  useTree,
  useSessionInfo,
  useSessionMessages,
  useCreateProjectMutation,
  useCreateSessionMutation,
  useSendMessageMutation,
  useStopSessionMutation,
  useArchiveSessionMutation,
  useUpdateSessionTitleMutation,
  useLoginMutation,
  useLogoutMutation,
  useModels,
  useSetSessionModelMutation,
  useArchiveProjectMutation,
  useDeleteProjectMutation,
} from '../lib/hooks';

type Tab = 'chat' | 'session_info';

function tempId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function findFirstSession(projects: TreeResponse['projects']) {
  for (const project of projects) {
    const stack = [...project.sessions];
    while (stack.length > 0) {
      const node = stack.shift()!;
      if (node.status !== 'archived') return { projectId: project.id, sessionId: node.id };
      stack.push(...node.children);
    }
  }
  return null;
}

function findProjectId(projects: TreeResponse['projects'], sessionId: string) {
  for (const project of projects) {
    const stack = [...project.sessions];
    while (stack.length > 0) {
      const node = stack.shift()!;
      if (node.id === sessionId) return project.id;
      stack.push(...node.children);
    }
  }
  return null;
}

function findSessionNode(projects: TreeResponse['projects'], sessionId: string) {
  for (const project of projects) {
    const stack = [...project.sessions];
    while (stack.length > 0) {
      const node = stack.shift()!;
      if (node.id === sessionId) return node;
      stack.push(...node.children);
    }
  }
  return null;
}

export function LayoutShell() {
  // --- auth ---
  const authQuery = useAuthSession();
  const authenticatedUser = authQuery.data?.user
    ? { userId: authQuery.data.user.id, name: authQuery.data.user.name }
    : null;

  const loginMutation = useLoginMutation();
  const logoutMutation = useLogoutMutation();

  // --- UI state (not query-backed) ---
  const [activeTab, setActiveTab] = useState<Tab>('chat');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const [mobileView, setMobileView] = useState<'nav' | 'content'>('nav');
  const [createProjectName, setCreateProjectName] = useState('');
  const [createMode, setCreateMode] = useState<'existing' | 'git_clone'>('existing');
  const [createPath, setCreatePath] = useState('');
  const [createRepoUrl, setCreateRepoUrl] = useState('');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [stopArmed, setStopArmed] = useState(false);
  const [streamNote, setStreamNote] = useState('');
  const [streamingContent, setStreamingContent] = useState('');
  const [pendingUserMessages, setPendingUserMessages] = useState<ChatMessageDTO[]>([]);
  const queryClient = useQueryClient();

  // --- data queries ---
  const treeQuery = useTree();
  const tree = treeQuery.data?.projects ?? [];

  const sessionInfoQuery = useSessionInfo(selectedSessionId);
  const sessionInfo = sessionInfoQuery.data;

  const messagesQuery = useSessionMessages(
    activeTab === 'chat' ? selectedSessionId : null,
  );
  const messages = messagesQuery.data?.pages.flatMap((p) => p.messages) ?? [];
  const hasMoreMessages = Boolean(messagesQuery.hasNextPage);
  const loadingMoreMessages = messagesQuery.isFetchingNextPage;

  // --- mutations ---
  const createProjectMut = useCreateProjectMutation();
  const createSessionMut = useCreateSessionMutation();
  const sendMessageMut = useSendMessageMutation(selectedSessionId);
  const stopSessionMut = useStopSessionMutation();
  const archiveSessionMut = useArchiveSessionMutation();
  const updateTitleMut = useUpdateSessionTitleMutation();
  const archiveProjectMut = useArchiveProjectMutation();
  const deleteProjectMut = useDeleteProjectMutation();

  function handleArchiveProject(projectId: string) {
    archiveProjectMut.mutate(projectId);
  }
  function handleDeleteProject(projectId: string) {
    deleteProjectMut.mutate(projectId);
  }

  const currentSessionNode = selectedSessionId ? findSessionNode(tree, selectedSessionId) : null;

  useEffect(() => {
    setPendingUserMessages([]);
    setStreamingContent('');
    setStreamNote('');
  }, [selectedSessionId]);

  // --- model ---
  const modelsQuery = useModels();
  const setModelMut = useSetSessionModelMutation();
  const modelDisabled = currentSessionNode?.runtime_status !== 'idle';
  const modelLabel = sessionInfo?.session.current_model?.label ?? modelsQuery.data?.[0]?.label ?? '选择模型';

  // --- derived UI state ---
  const tabs = useMemo(
    () => [
      { key: 'chat' as const, label: 'Chat', badge: activeTab === 'chat' && streamNote ? <Sparkles size={12} strokeWidth={2} /> : null },
      { key: 'session_info' as const, label: 'Session Info' },
    ],
    [activeTab, streamNote],
  );

  // --- auto-select first session on tree load ---
  useEffect(() => {
    if (!tree.length || selectedSessionId) return;
    const fallback = findFirstSession(tree);
    if (fallback) {
      setSelectedProjectId(fallback.projectId);
      setSelectedSessionId(fallback.sessionId);
    }
  }, [tree, selectedSessionId]);

  // --- resolve projectId from tree ---
  useEffect(() => {
    if (!selectedSessionId || !tree.length) return;
    const pid = findProjectId(tree, selectedSessionId);
    if (pid) setSelectedProjectId(pid);
  }, [selectedSessionId, tree]);

  // --- double-Esc stop ---
  useEffect(() => {
    if (!currentSessionNode || currentSessionNode.runtime_status !== 'running') return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (stopArmed && selectedSessionId) {
          stopSessionMut.mutate(selectedSessionId);
          setStopArmed(false);
          setStreamNote('stopping');
        } else {
          setStopArmed(true);
          setStreamNote('armed');
        }
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [currentSessionNode?.runtime_status, stopArmed, selectedSessionId, stopSessionMut]);

  // --- WebSocket ---
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const selectedProjectIdRef = useRef(selectedProjectId);
  selectedProjectIdRef.current = selectedProjectId;
  const socketRef = useRef<ReturnType<typeof createWorkspaceSocket> | null>(null);

  useEffect(() => {
    if (!selectedSessionId) return;

    const socket = createWorkspaceSocket({
      onMessage(event) {
        try {
          const message = JSON.parse(event.data as string) as {
            kind?: string;
            phase?: string;
            type?: string;
            scope?: { session_id?: string };
            payload?: { delta?: string | null; runtime_status?: SessionInfoDTO['session']['runtime_status'] };
          };
          console.log('[web/ws] received', message);

          // ── chat_stream 到达但 session 不匹配时打印日志 ──
          if (message.kind === 'chat_stream' && message.scope?.session_id !== selectedSessionId) {
            console.log('[web/ws] chat_stream session mismatch', {
              scopeSessionId: message.scope?.session_id,
              selectedSessionId,
            });
          }

          // ── chat_stream：delta 只在 chat tab 显示 ──
          if (message.kind === 'chat_stream' && message.scope?.session_id === selectedSessionId) {
            // start/delta 仅在 chat tab 中实时渲染
            if (activeTabRef.current === 'chat') {
              const delta = message.payload?.delta ?? '';
              setStreamNote(`${message.phase ?? 'stream'}${delta ? ` · ${delta}` : ''}`);
              if (message.phase === 'start') {
                setStreamingContent('');
              } else if (message.phase === 'delta') {
                setStreamingContent((prev) => prev + delta);
              }
            }

            // complete 不受 tab 影响：清理状态 + 异步等 refetch 完成再清 streaming
            if (message.phase === 'complete') {
              setStreamNote('完成');
              // 先保留 streamingContent（假消息保持可见），等数据到位再清
              Promise.all([
                queryClient.invalidateQueries({ queryKey: ['session', 'messages', selectedSessionId] }),
                queryClient.invalidateQueries({ queryKey: ['tree'] }),
              ]).then(() => {
                setStreamingContent('');
                setStreamNote('');
              });
            }

            if (message.phase === 'error') {
              setStreamNote('错误');
            }
          }

          // ── runtime_status_changed 事件 ──
          if (message.kind === 'event' && message.type === 'session.runtime_status_changed') {
            const status = message.payload?.runtime_status;
            console.log('[web/ws] runtime status changed', status);
            treeQuery.refetch();
            if (status === 'idle') {
              console.log('[web/ws] idle detected, refreshing history');
              messagesQuery.refetch();
              Promise.all([
                queryClient.invalidateQueries({ queryKey: ['session', 'messages', selectedSessionId] }),
                queryClient.invalidateQueries({ queryKey: ['tree'] }),
              ]).then(() => {
                setStreamingContent('');
                setStreamNote('');
                setPendingUserMessages([]);
              });
            }
          }

          // ── tree 变更事件 ──
          if (message.kind === 'event' && (
            message.type === 'tree.changed'
            || message.type === 'project.created'
            || message.type === 'session.created'
            || message.type === 'session.archived'
          )) {
            treeQuery.refetch();
          }
        } catch { /* ignore */ }
      },
      onOpen() {
        console.log('[web/ws] open');
        socket.hello();
        socket.setContext({
          project_id: selectedProjectIdRef.current ?? undefined,
          session_id: selectedSessionId,
          current_tab: activeTabRef.current,
        });
        socket.ping();
      },
    });

    socketRef.current = socket;

    return () => {
      socketRef.current = null;
      socket.close();
    };
  }, [selectedSessionId]);

  useEffect(() => {
    if (!socketRef.current || !selectedSessionId) return;
    socketRef.current.setContext({
      project_id: selectedProjectId ?? undefined,
      session_id: selectedSessionId,
      current_tab: activeTab,
    });
  }, [activeTab, selectedProjectId, selectedSessionId]);

  // --- handlers ---
  async function handleLogin(password: string) {
    try {
      await loginMutation.mutateAsync(password);
      authQuery.refetch();
    } catch { /* handled by mutation state */ }
  }

  async function handleLogout() {
    logoutMutation.mutate();
  }

  async function handleCreateProject(params: { name: string; path: string; repoUrl: string }) {
    try {
      const mode = params.repoUrl ? 'git_clone' : 'existing';
      const result = await createProjectMut.mutateAsync({
        name: params.name,
        mode,
        path: mode === 'existing' ? params.path : undefined,
        repoUrl: mode === 'git_clone' ? params.repoUrl : undefined,
      });
      setShowCreateDialog(false);
      setMobileView('content');
      setActiveTab('chat');
      if (result.projectId) {
        if (result.sessionId) {
          setSelectedProjectId(result.projectId);
          setSelectedSessionId(result.sessionId);
        }
        await treeQuery.refetch();
      }
    } catch { /* ignore */ }
  }

  function handleOpenCreateDialog() {
    setShowCreateDialog(true);
  }

  async function handleCreateSession() {
    if (!selectedProjectId) return;
    try {
      const result = await createSessionMut.mutateAsync({
      projectId: selectedProjectId,
      inheritModel: sessionInfo?.session.current_model
        ? {
            provider: sessionInfo.session.current_model.provider,
            id: sessionInfo.session.current_model.id,
          }
        : null,
    });
      setMobileView('content');
      setActiveTab('chat');
      setSelectedSessionId(result.session_id);
      await treeQuery.refetch();
    } catch { /* ignore */ }
  }

  async function handleSend(content: string) {
    if (!selectedSessionId) return;
    const optimisticMessage: ChatMessageDTO = {
      id: tempId('optimistic'),
      role: 'user',
      message_kind: 'normal',
      source_session_id: null,
      content_text: content,
      created_at: new Date().toISOString(),
    };
    setPendingUserMessages((prev) => [...prev, optimisticMessage]);
    await sendMessageMut.mutateAsync(content);
    queryClient.invalidateQueries({ queryKey: ['session', 'messages', selectedSessionId] });
  }

  async function handleStopSession() {
    if (!selectedSessionId) return;
    await stopSessionMut.mutateAsync(selectedSessionId);
    setStopArmed(false);
    setStreamNote('stopping');
  }

  async function handleArchiveSession() {
    if (!selectedSessionId) return;
    await archiveSessionMut.mutateAsync(selectedSessionId);
    await treeQuery.refetch();
  }

  async function handleTitleChanged(sessionId: string, newTitle: string) {
    await updateTitleMut.mutateAsync({ sessionId, title: newTitle });
  }

  // --- render ---
  if (!authenticatedUser) {
    return (
      <LoginScreen
        busy={loginMutation.isPending}
        error={loginMutation.isError ? '密码错误' : null}
        onSubmit={handleLogin}
      />
    );
  }

  return (
    <>
    <main className="workspace-shell h-dvh overflow-hidden">
      <div className="mx-auto flex h-full max-w-[1280px] box-border px-4 md:px-6">{/* mobile nav page */}
        {!isDesktop && mobileView === 'nav' ? (
          <MobileNavPage
            authenticatedUser={authenticatedUser!}
            tree={tree}
            selectedSessionId={selectedSessionId}
            showArchived={showArchived}
            setShowArchived={setShowArchived}
            onSelectSession={(projectId, sessionId) => {
              setSelectedProjectId(projectId);
              setSelectedSessionId(sessionId);
              setMobileView('content');
            }}
            onCreateProject={handleOpenCreateDialog}
            createProjectName={createProjectName}
            setCreateProjectName={setCreateProjectName}
            creatingProject={createProjectMut.isPending}
            createMode={createMode}
            setCreateMode={setCreateMode}
            createPath={createPath}
            setCreatePath={setCreatePath}
            createRepoUrl={createRepoUrl}
            setCreateRepoUrl={setCreateRepoUrl}
            onCreateSession={handleCreateSession}
            creatingSession={createSessionMut.isPending}
            onLogout={handleLogout}
            treeLoading={treeQuery.isLoading}
            activeTab={activeTab}
            onArchiveProject={handleArchiveProject}
            onDeleteProject={handleDeleteProject}
          />
        ) : null}

        {/* desktop sidebar */}
        {isDesktop ? (
          <aside className={`${
            sidebarCollapsed ? 'w-12' : 'w-[280px]'
          } mr-3 flex-shrink-0 flex flex-col min-h-0 transition-all duration-200`}>

            {sidebarCollapsed ? (
              <div className="flex flex-1 flex-col items-center gap-2 py-3">
                <button className="ghost-button ghost-button-sm p-1.5" onClick={() => setSidebarCollapsed(false)} type="button">
                  <PanelLeftOpen size={18} />
                </button>
                <div className="mt-auto">
                  <button className="ghost-button ghost-button-sm p-1.5" onClick={handleLogout} type="button" title="登出">
                    <LogOut size={14} />
                  </button>
                </div>
              </div>
            ) : (
              <>
                <SidebarHeader
                  onCollapse={() => setSidebarCollapsed(true)}
                  authenticatedUser={authenticatedUser!}
                />
                <SidebarContent
                  tree={tree}
                  selectedSessionId={selectedSessionId}
                  showArchived={showArchived}
                  setShowArchived={setShowArchived}
                  onSelectProject={setSelectedProjectId}
                  onSelectSession={setSelectedSessionId}
                  authenticatedUser={authenticatedUser!}
                  onCreateProject={handleOpenCreateDialog}
                  createProjectName={createProjectName}
                  setCreateProjectName={setCreateProjectName}
                  creatingProject={createProjectMut.isPending}
                  createMode={createMode}
                  setCreateMode={setCreateMode}
                  createPath={createPath}
                  setCreatePath={setCreatePath}
                  createRepoUrl={createRepoUrl}
                  setCreateRepoUrl={setCreateRepoUrl}
                  onCreateSession={handleCreateSession}
                  creatingSession={createSessionMut.isPending}
                  onArchiveProject={handleArchiveProject}
                  onDeleteProject={handleDeleteProject}
                  onLogout={handleLogout}
                  treeLoading={treeQuery.isLoading}
                />
              </>
            )}
          </aside>
        ) : null}

        {/* main content - on mobile, only show when on content view */}
        {(!isDesktop && mobileView !== 'content') ? null : (
        <section className="flex flex-1 flex-col overflow-hidden">
          {/* mobile back button bar */}
          {!isDesktop ? (
            <div className="flex items-center gap-3 bg-[rgba(255,255,255,0.02)] px-3 py-2">
              <button
                className="ghost-button ghost-button-sm ghost-button-icon"
                onClick={() => setMobileView('nav')}
                type="button"
              >
                <ArrowLeft size={16} />
                <span className="text-sm">返回</span>
              </button>
              <span className="text-sm font-medium text-[var(--text)] truncate">{
                currentSessionNode?.title ?? 'piplus'
              }</span>
            </div>
          ) : null}

          <div className="flex flex-1 flex-col overflow-hidden">
            {/* tab bar */}
            <div className="flex items-center justify-between gap-3 bg-[linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0.01))] px-4 py-2.5">
              <TabsBar items={tabs} value={activeTab} onChange={(t) => setActiveTab(t as Tab)} />
              <div className="flex items-center gap-2">
                <button
                  className="ghost-button ghost-button-sm"
                  disabled={!selectedSessionId || archiveSessionMut.isPending}
                  onClick={handleArchiveSession}
                  type="button"
                >
                  <Archive size={14} />
                  <span className="ml-1.5">{archiveSessionMut.isPending ? '...' : '归档'}</span>
                </button>
              </div>
            </div>

            {/* panel area */}
            <div className="flex-1 min-h-0 overflow-hidden">
              {activeTab === 'chat' ? (
                <ChatPanel
                  messages={[
                    ...messages,
                    ...pendingUserMessages,
                    ...(streamingContent
                      ? [{ id: 'streaming', role: 'assistant', message_kind: 'normal', source_session_id: null, content_text: streamingContent, created_at: new Date().toISOString() } as ChatMessageDTO]
                      : []),
                  ]}
                  disabled={!selectedSessionId}
                  loadingMore={loadingMoreMessages}
                  canLoadMore={hasMoreMessages}
                  onLoadMore={async () => { await messagesQuery.fetchNextPage(); }}
                  onSend={handleSend}
                  sending={sendMessageMut.isPending}
                  sessionTitle={currentSessionNode?.title ?? 'Session'}
                  stopArmed={stopArmed} onStop={handleStopSession}
                  stopDisabled={currentSessionNode?.runtime_status !== 'running'}
                  streamNote={streamNote}
                  models={modelsQuery.data ?? []}
                  modelLabel={modelLabel}
                  modelDisabled={modelDisabled}
                  onModelSelect={async (provider, id) => {
                    if (!selectedSessionId) return;
                    const result = await setModelMut.mutateAsync({ sessionId: selectedSessionId, provider, id });
                    queryClient.setQueryData(['session', 'info', selectedSessionId], (old: any) =>
                      old ? { ...old, session: { ...old.session, current_model: result.model } } : null);
                    await queryClient.invalidateQueries({ queryKey: ['session', 'info', selectedSessionId] });
                  }}
                />
              ) : (
                <SessionInfoPanel info={sessionInfo} onTitleChanged={handleTitleChanged} />
              )}
            </div>
          </div>
        </section>
        )}
      </div>
    </main>
    <CreateProjectModal
      open={showCreateDialog}
      busy={createProjectMut.isPending}
      onClose={() => setShowCreateDialog(false)}
      onSubmit={handleCreateProject}
    />
    </>
  );
}

// --- sub-components extracted for reuse ---
function SidebarHeader({ onCollapse, authenticatedUser }: {
  onCollapse: () => void;
  authenticatedUser: { userId: string; name: string };
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-3">
      <div className="flex items-center gap-2">
        <FolderTree size={16} className="text-[var(--accent)]" />
        <span className="text-sm font-semibold tracking-[-0.02em] text-[var(--text)]">piplus</span>
      </div>
      <div className="flex items-center gap-1">
        <span className="text-[11px] text-[var(--text-dim)]">{authenticatedUser.name}</span>
        <button className="ghost-button ghost-button-sm p-1" onClick={onCollapse} type="button" title="收起侧栏">
          <PanelLeftClose size={14} />
        </button>
      </div>
    </div>
  );
}

function SidebarContent({
  tree,
  selectedSessionId,
  showArchived,
  setShowArchived,
  onSelectProject,
  onSelectSession,
  authenticatedUser: _auth,
  onCreateProject,
  createProjectName,
  setCreateProjectName,
  creatingProject,
  createMode,
  setCreateMode,
  createPath,
  setCreatePath,
  createRepoUrl,
  setCreateRepoUrl,
  onCreateSession,
  creatingSession,
  onLogout,
  treeLoading,
  onArchiveProject,
  onDeleteProject,
}: {
  tree: TreeResponse['projects'];
  selectedSessionId: string | null;
  showArchived: boolean;
  setShowArchived: (v: boolean) => void;
  onSelectProject: (id: string) => void;
  onSelectSession: (id: string) => void;
  authenticatedUser: { userId: string; name: string };
  onCreateProject: () => void;
  createProjectName: string;
  setCreateProjectName: (v: string) => void;
  creatingProject: boolean;
  createMode: 'existing' | 'git_clone';
  setCreateMode: (mode: 'existing' | 'git_clone') => void;
  createPath: string;
  setCreatePath: (v: string) => void;
  createRepoUrl: string;
  setCreateRepoUrl: (v: string) => void;
  onCreateSession: () => void;
  creatingSession: boolean;
  onLogout: () => void;
  treeLoading: boolean;
  onArchiveProject?: (projectId: string) => void;
  onDeleteProject?: (projectId: string) => void;
}) {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* new project button — top */}
      <div className="px-3 py-3">
        <button
          className="ghost-button ghost-button-sm w-full justify-center"
          onMouseDown={(e) => {
            e.preventDefault();
            onCreateProject();
          }}
          type="button"
        >
          <Plus size={14} />
          <span className="ml-1.5">新建项目</span>
        </button>
      </div>

      {/* project tree */}
      <ScrollArea className="flex-1 min-h-0" viewportClassName="px-2 py-3">
        {treeLoading ? (
          <p className="py-6 text-center text-xs text-[var(--text-dim)]">加载中...</p>
        ) : tree.length === 0 ? (
          <div className="py-4 text-center">
            <p className="text-xs text-[var(--text-dim)]">暂无项目</p>
          </div>
        ) : (
          <>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-dim)]">项目</span>
              <label className="flex items-center gap-1.5 text-[10px] text-[var(--text-dim)]">
                <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
                显示已归档
              </label>
            </div>
            <ProjectTree
              tree={tree}
              activeSessionId={selectedSessionId}
              showArchived={showArchived}
              onSelectSession={(projectId, sessionId) => {
                onSelectProject(projectId);
                onSelectSession(sessionId);
              }}
              onSelectProject={onSelectProject}
              onCreateSession={onCreateSession}
              creatingSession={creatingSession}
              onArchiveProject={onArchiveProject}
              onDeleteProject={onDeleteProject}
            />
          </>
        )}
      </ScrollArea>

      {/* logout — bottom */}
      <div className="mt-auto px-3 py-3">
        <button
          className="ghost-button ghost-button-sm w-full justify-center text-[var(--text-dim)]"
          onClick={onLogout}
          type="button"
        >
          <LogOut size={14} />
          <span className="ml-1.5">登出</span>
        </button>
      </div>
    </div>
  );
}

function MobileNavPage({
  authenticatedUser,
  tree,
  selectedSessionId,
  showArchived,
  setShowArchived,
  onSelectSession,
  onCreateProject,
  createProjectName,
  setCreateProjectName,
  creatingProject,
  createMode,
  setCreateMode,
  createPath,
  setCreatePath,
  createRepoUrl,
  setCreateRepoUrl,
  onCreateSession,
  creatingSession,
  onLogout,
  treeLoading,
  activeTab: _activeTab,
  onArchiveProject,
  onDeleteProject,
}: {
  authenticatedUser: { userId: string; name: string };
  tree: TreeResponse['projects'];
  selectedSessionId: string | null;
  showArchived: boolean;
  setShowArchived: (v: boolean) => void;
  onSelectSession: (projectId: string, sessionId: string) => void;
  onCreateProject: () => void;
  createProjectName: string;
  setCreateProjectName: (v: string) => void;
  creatingProject: boolean;
  createMode: 'existing' | 'git_clone';
  setCreateMode: (mode: 'existing' | 'git_clone') => void;
  createPath: string;
  setCreatePath: (v: string) => void;
  createRepoUrl: string;
  setCreateRepoUrl: (v: string) => void;
  onCreateSession: () => void;
  creatingSession: boolean;
  onLogout: () => void;
  treeLoading: boolean;
  activeTab: string;
  onArchiveProject?: (projectId: string) => void;
  onDeleteProject?: (projectId: string) => void;
}) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <header className="flex items-center justify-between gap-2 px-4 py-3">
        <div className="flex items-center gap-2">
          <FolderTree size={16} className="text-[var(--accent)]" />
          <span className="text-sm font-semibold tracking-[-0.02em] text-[var(--text)]">piplus</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-[var(--text-dim)]">{authenticatedUser.name}</span>
          <button className="ghost-button ghost-button-sm p-1" onClick={onLogout} type="button" title="登出">
            <PanelLeftClose size={14} />
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-auto px-4 py-4">
        {treeLoading ? (
          <p className="py-8 text-center text-xs text-[var(--text-dim)]">加载中...</p>
        ) : tree.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm text-[var(--text-dim)]">暂无项目</p>
            <p className="mt-1 text-xs text-[var(--text-dim)]">在下方创建第一个项目</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-dim)]">项目</span>
              <label className="flex items-center gap-1.5 text-[10px] text-[var(--text-dim)]">
                <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
                显示已归档
              </label>
            </div>
            <ProjectTree
              tree={tree}
              activeSessionId={selectedSessionId}
              showArchived={showArchived}
              onSelectSession={onSelectSession}
              onSelectProject={() => {}}
              onCreateSession={onCreateSession}
              creatingSession={creatingSession}
              onArchiveProject={onArchiveProject}
              onDeleteProject={onDeleteProject}
            />
          </div>
        )}
      </div>

      <footer className="space-y-3 bg-[rgba(255,255,255,0.015)] px-4 py-4">
        <div className="flex gap-2">
          <input
            className="shell-input flex-1"
            placeholder="新项目名称"
            value={createProjectName}
            onChange={(e) => setCreateProjectName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onCreateProject(); }}
          />
          <button
            className="primary-button primary-button-sm primary-button-icon"
            disabled={creatingProject || !createProjectName.trim()}
            onClick={onCreateProject}
            type="button"
          >
            <Plus size={16} />
            <span>创建</span>
          </button>
        </div>
        <button
          className="ghost-button ghost-button-sm w-full justify-center"
          disabled={creatingSession}
          onClick={onCreateSession}
          type="button"
        >
          <SquarePen size={14} />
          <span className="ml-1.5">{creatingSession ? '...' : '新建空白 Session'}</span>
        </button>
      </footer>
    </div>
  );
}
