'use client';

import { Archive, ArrowLeft, ChevronLeft, FolderTree, PanelLeftClose, PanelLeftOpen, Plus, SquarePen, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useMediaQuery } from '../lib/use-media-query';
import type { SessionInfoDTO, TreeResponse } from '@piplus/shared';
import { createWorkspaceSocket } from '../lib/ws-client';
import { ChatPanel } from './chat-panel';
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
} from '../lib/hooks';

type Tab = 'chat' | 'session_info';

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
    ? { userId: authQuery.data.user.id, name: authQuery.data.user.name ?? authQuery.data.user.email }
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
  const [stopArmed, setStopArmed] = useState(false);
  const [streamNote, setStreamNote] = useState('');

  // --- data queries ---
  const treeQuery = useTree();
  const tree = treeQuery.data?.projects ?? [];

  const sessionInfoQuery = useSessionInfo(activeTab === 'session_info' ? selectedSessionId : null);
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

  const currentSessionNode = selectedSessionId ? findSessionNode(tree, selectedSessionId) : null;

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
  useEffect(() => {
    if (!selectedSessionId) return;

    const socket = createWorkspaceSocket((event) => {
      try {
        const message = JSON.parse(event.data as string) as {
          kind?: string;
          phase?: string;
          type?: string;
          scope?: { session_id?: string };
          payload?: { delta?: string | null; runtime_status?: SessionInfoDTO['session']['runtime_status'] };
        };
        if (message.kind === 'chat_stream' && message.scope?.session_id === selectedSessionId && activeTab === 'chat') {
          const delta = message.payload?.delta ?? '';
          setStreamNote(`${message.phase ?? 'stream'}${delta ? ` · ${delta}` : ''}`);
        }
        if (message.kind === 'event' && message.type === 'session.runtime_status_changed') {
          // handled by query invalidation
        }
        if (message.kind === 'event' && (message.type === 'tree.changed' || message.type === 'project.created' || message.type === 'session.created' || message.type === 'session.archived')) {
          treeQuery.refetch();
        }
      } catch { /* ignore */ }
    });

    socket.socket.addEventListener('open', () => {
      socket.hello();
      socket.setContext({
        project_id: selectedProjectId ?? undefined,
        session_id: selectedSessionId,
        current_tab: activeTab,
      });
      socket.ping();
    });

    return () => socket.close();
  }, [activeTab, selectedProjectId, selectedSessionId, treeQuery]);

  // --- handlers ---
  async function handleLogin(email: string, password: string) {
    try {
      await loginMutation.mutateAsync({ email, password });
      authQuery.refetch();
    } catch { /* handled by mutation state */ }
  }

  async function handleLogout() {
    logoutMutation.mutate();
  }

  async function handleCreateProject() {
    const name = createProjectName.trim();
    if (!name) return;
    try {
      const result = await createProjectMut.mutateAsync(name);
      setCreateProjectName('');
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

  async function handleCreateSession() {
    if (!selectedProjectId) return;
    try {
      const result = await createSessionMut.mutateAsync(selectedProjectId);
      setMobileView('content');
      setActiveTab('chat');
      setSelectedSessionId(result.session_id);
      await treeQuery.refetch();
    } catch { /* ignore */ }
  }

  async function handleSend(content: string) {
    if (!selectedSessionId) return;
    await sendMessageMut.mutateAsync(content);
    messagesQuery.refetch();
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
        error={loginMutation.isError ? '登录失败，请检查本地账户凭据。' : null}
        onSubmit={handleLogin}
      />
    );
  }

  return (
    <main className="workspace-shell min-h-screen">
      <div className="mx-auto flex min-h-screen max-w-[1280px] px-4 py-4 md:px-6 md:py-6">{/* mobile nav page */}
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
            onCreateProject={handleCreateProject}
            createProjectName={createProjectName}
            setCreateProjectName={setCreateProjectName}
            creatingProject={createProjectMut.isPending}
            onCreateSession={handleCreateSession}
            creatingSession={createSessionMut.isPending}
            onLogout={handleLogout}
            treeLoading={treeQuery.isLoading}
            activeTab={activeTab}
          />
        ) : null}

        {/* desktop sidebar */}
        {isDesktop ? (
          <aside className={`${
            sidebarCollapsed ? 'w-12' : 'w-[280px]'
          } flex-shrink-0 flex-col border-r border-white/6 transition-all duration-200`}>

            {sidebarCollapsed ? (
              <div className="flex flex-1 flex-col items-center gap-2 py-3">
                <button className="ghost-button ghost-button-sm p-1.5" onClick={() => setSidebarCollapsed(false)} type="button">
                  <PanelLeftOpen size={18} />
                </button>
              </div>
            ) : (
              <>
                <SidebarHeader
                  onCollapse={() => setSidebarCollapsed(true)}
                  authenticatedUser={authenticatedUser!}
                  onLogout={handleLogout}
                />
                <SidebarContent
                  tree={tree}
                  selectedSessionId={selectedSessionId}
                  showArchived={showArchived}
                  setShowArchived={setShowArchived}
                  onSelectProject={setSelectedProjectId}
                  onSelectSession={setSelectedSessionId}
                  authenticatedUser={authenticatedUser!}
                  onCreateProject={handleCreateProject}
                  createProjectName={createProjectName}
                  setCreateProjectName={setCreateProjectName}
                  creatingProject={createProjectMut.isPending}
                  onCreateSession={handleCreateSession}
                  creatingSession={createSessionMut.isPending}
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
            <div className="flex items-center gap-3 border-b border-white/6 px-3 py-2">
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
            <div className="flex items-center justify-between gap-3 border-b border-white/6 px-4 py-2">
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
            <div className="flex-1 overflow-hidden">
              {activeTab === 'chat' ? (
                <ChatPanel
                  messages={messages}
                  disabled={messagesQuery.isLoading}
                  loadingMore={loadingMoreMessages}
                  canLoadMore={hasMoreMessages}
                  onLoadMore={async () => { await messagesQuery.fetchNextPage(); }}
                  onSend={handleSend}
                  sending={sendMessageMut.isPending}
                  sessionTitle={currentSessionNode?.title ?? 'Session'}
                  stopArmed={stopArmed} onStop={handleStopSession}
                  stopDisabled={currentSessionNode?.runtime_status !== 'running'}
                  streamNote={streamNote}
                />
              ) : (
                <SessionInfoPanel info={sessionInfo} onTitleChanged={handleTitleChanged} />
              )}
            </div>
          </div>
        </section>
        )}
        <section className="flex flex-1 flex-col overflow-hidden">
          {/* mobile toolbar */}
          <div className="flex items-center gap-2 border-b border-white/6 px-3 py-2 md:hidden">
            <button className="ghost-button ghost-button-sm" onClick={() => setMobileView('nav')} type="button">
              <PanelLeftOpen size={18} />
            </button>
            <span className="text-sm font-medium text-[var(--text)]">piplus</span>
          </div>

          <div className="flex flex-1 flex-col overflow-hidden">
            {/* tab bar */}
            <div className="flex items-center justify-between gap-3 border-b border-white/6 px-4 py-2">
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
            <div className="flex-1 overflow-hidden">
              {activeTab === 'chat' ? (
                <ChatPanel
                  messages={messages}
                  disabled={messagesQuery.isLoading}
                  loadingMore={loadingMoreMessages}
                  canLoadMore={hasMoreMessages}
                  onLoadMore={async () => { await messagesQuery.fetchNextPage(); }}
                  onSend={handleSend}
                  sending={sendMessageMut.isPending}
                  sessionTitle={currentSessionNode?.title ?? 'Session'}
                  stopArmed={stopArmed} onStop={handleStopSession}
                  stopDisabled={currentSessionNode?.runtime_status !== 'running'}
                  streamNote={streamNote}
                />
              ) : (
                <SessionInfoPanel info={sessionInfo} onTitleChanged={handleTitleChanged} />
              )}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

// --- sub-components extracted for reuse ---
function SidebarHeader({ onCollapse, authenticatedUser, onLogout }: {
  onCollapse: () => void;
  authenticatedUser: { userId: string; name: string };
  onLogout: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-white/6 px-3 py-3">
      <div className="flex items-center gap-2">
        <FolderTree size={16} className="text-[var(--accent)]" />
        <span className="text-sm font-semibold tracking-[-0.02em] text-[var(--text)]">piplus</span>
      </div>
      <div className="flex items-center gap-1">
        <span className="text-[11px] text-[var(--text-dim)]">{authenticatedUser.name}</span>
        <button className="ghost-button ghost-button-sm p-1" onClick={onLogout} type="button" title="登出">
          <PanelLeftClose size={14} />
        </button>
        <button className="ghost-button ghost-button-sm p-1" onClick={onCollapse} type="button" title="收起侧栏">
          <ChevronLeft size={14} />
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
  onCreateSession,
  creatingSession,
  onLogout: _onLogout,
  treeLoading,
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
  onCreateSession: () => void;
  creatingSession: boolean;
  onLogout: () => void;
  treeLoading: boolean;
}) {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* project tree */}
      <ScrollArea className="flex-1" viewportClassName="px-3 py-3">
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
            />
          </>
        )}
      </ScrollArea>

      {/* actions */}
      <div className="border-t border-white/6 px-3 py-3 space-y-2">
        <div className="flex gap-1.5">
          <input
            className="flex-1 rounded-[12px] border border-white/8 bg-black/10 px-3 py-1.5 text-xs text-[var(--text)] outline-none placeholder:text-[var(--text-dim)]"
            placeholder="新项目名称"
            value={createProjectName}
            onChange={(e) => setCreateProjectName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onCreateProject(); }}
          />
          <button className="ghost-button ghost-button-sm" disabled={creatingProject || !createProjectName.trim()} onClick={onCreateProject} type="button">
            <Plus size={14} />
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
  onCreateSession,
  creatingSession,
  onLogout,
  treeLoading,
  activeTab: _activeTab,
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
  onCreateSession: () => void;
  creatingSession: boolean;
  onLogout: () => void;
  treeLoading: boolean;
  activeTab: string;
}) {
  return (
    <div className="flex min-h-screen w-full flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-white/6 px-4 py-3">
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
            />
          </div>
        )}
      </div>

      <footer className="border-t border-white/6 px-4 py-4 space-y-3">
        <div className="flex gap-2">
          <input
            className="flex-1 rounded-[14px] border border-white/8 bg-black/10 px-4 py-2.5 text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-dim)]"
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
