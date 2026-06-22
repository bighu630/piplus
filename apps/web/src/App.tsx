import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ProjectDTO, SessionTreeNodeDTO, ChatMessageDTO, ServerMessage } from '@piplus/shared';
import hljsLight from 'highlight.js/styles/github.css?url';
import hljsDark from 'highlight.js/styles/github-dark.css?url';
import Sidebar from './components/Sidebar';
import TabChat from './components/TabChat';
import TabSessionInfo from './components/TabSessionInfo';
import TabGitDiff from './components/TabGitDiff';
import TabFiles from './components/TabFiles';
import Modal from './components/Modal';
import { LoginScreen } from './components/LoginScreen';
import { createWorkspaceSocket } from './lib/ws-client';
import {
  useAuthSession,
  useTree,
  useSessionInfo,
  useSessionMessages,
  useSessionGitDiff,
  useSessionFileTree,
  useSessionFileContent,
  useCreateProjectMutation,
  useCreateSessionMutation,
  useSendMessageMutation,
  useStopSessionMutation,
  useArchiveSessionMutation,
  useLoginMutation,
  useLogoutMutation,
  useModels,
  useSetSessionModelMutation,
  useArchiveProjectMutation,
  useDeleteProjectMutation,
  useGitPullMutation,
  useGitPushMutation,
  useGitCommitMutation,
  useAddGitignoreMutation,
} from './lib/hooks';
import {
  Sparkles,
  Terminal,
  Settings,
  LogOut,
  Archive,
  ChevronDown,
  FolderOpen,
  X,
  PlusCircle,
  Wrench,
} from 'lucide-react';

type Tab = 'chat' | 'info' | 'diff' | 'files';
type SendShortcutMode = 'enter' | 'mod_enter';

const WORKSPACE_ROOT_PATH = '/workspace';

function getSessionPath(sessionId: string | null): string {
  return sessionId ? `${WORKSPACE_ROOT_PATH}/session/${sessionId}` : WORKSPACE_ROOT_PATH;
}

function getSessionIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/workspace\/session\/([^/]+)$/);
  return match?.[1] ?? null;
}

function findFirstSession(projects: ProjectDTO[]): { projectId: string; sessionId: string } | null {
  for (const project of projects) {
    const stack = [...project.sessions];
    while (stack.length > 0) {
      const node = stack.shift()!;
      if (!node.archived_at) return { projectId: project.id, sessionId: node.id };
      stack.push(...node.children);
    }
  }
  return null;
}

function findProjectId(projects: ProjectDTO[], sessionId: string): string | null {
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

function findSessionNode(projects: ProjectDTO[], sessionId: string): SessionTreeNodeDTO | null {
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

export default function App() {
  // Auth
  const authQuery = useAuthSession();
  const isLoggedIn = Boolean(authQuery.data?.ok);

  const loginMutation = useLoginMutation();
  const logoutMutation = useLogoutMutation();

  // UI state
  const [activeTab, setActiveTab] = useState<Tab>('chat');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showCreateProject, setShowCreateProject] = useState(false);

  // Create project form state
  const [createName, setCreateName] = useState('');
  const [createMode, setCreateMode] = useState<'existing' | 'git_clone'>('existing');
  const [createPath, setCreatePath] = useState('');
  const [createRepoUrl, setCreateRepoUrl] = useState('');
  const [createProjectModelKey, setCreateProjectModelKey] = useState('');

  // Stream state
  const [streamNote, setStreamNote] = useState('');
  const [streamingContent, setStreamingContent] = useState('');
  const [pendingUserMessages, setPendingUserMessages] = useState<ChatMessageDTO[]>([]);

  // WS connection status
  const [wsConnected, setWsConnected] = useState(false);

  // Theme
  const initialUrlSessionId = useMemo(() => getSessionIdFromPath(window.location.pathname), []);

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      const saved = localStorage.getItem('pi-workspace-theme');
      return saved === 'dark' ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  });
  const [sendShortcutMode, setSendShortcutMode] = useState<SendShortcutMode>(() => {
    try {
      const saved = localStorage.getItem('pi-send-shortcut-mode');
      return saved === 'mod_enter' ? 'mod_enter' : 'enter';
    } catch {
      return 'enter';
    }
  });

  useEffect(() => {
    try { localStorage.setItem('pi-workspace-theme', theme); } catch { /* noop */ }

    // Dynamically load matching highlight.js theme so code preview matches the app theme.
    const hljsLinkId = 'hljs-theme';
    const existing = document.getElementById(hljsLinkId);
    if (existing) existing.remove();

    const link = document.createElement('link');
    link.id = hljsLinkId;
    link.rel = 'stylesheet';
    link.href = theme === 'dark' ? hljsDark : hljsLight;
    document.head.appendChild(link);
  }, [theme]);

  useEffect(() => {
    try { localStorage.setItem('pi-send-shortcut-mode', sendShortcutMode); } catch { /* noop */ }
  }, [sendShortcutMode]);

  const queryClient = useQueryClient();

  // Data queries
  const treeQuery = useTree();
  const tree = treeQuery.data?.projects ?? [];

  const sessionInfoQuery = useSessionInfo(selectedSessionId);
  const sessionInfo = sessionInfoQuery.data;

  const gitDiffQuery = useSessionGitDiff(activeTab === 'diff' ? selectedSessionId : null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const fileTreeQuery = useSessionFileTree(activeTab === 'files' ? selectedSessionId : null);
  const fileContentQuery = useSessionFileContent(
    activeTab === 'files' ? selectedSessionId : null,
    activeTab === 'files' ? selectedFilePath : null,
  );

  const messagesQuery = useSessionMessages(activeTab === 'chat' ? selectedSessionId : null);
  const messages = messagesQuery.data?.pages.flatMap((p) => p.messages).sort((a, b) => {
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  }) ?? [];
  const hasMoreMessages = Boolean(messagesQuery.hasNextPage);
  const loadingMoreMessages = messagesQuery.isFetchingNextPage;

  const modelsQuery = useModels();
  const setModelMut = useSetSessionModelMutation();

  // Mutations
  const createProjectMut = useCreateProjectMutation();
  const createSessionMut = useCreateSessionMutation();
  const sendMessageMut = useSendMessageMutation(selectedSessionId);
  const stopSessionMut = useStopSessionMutation();
  const archiveSessionMut = useArchiveSessionMutation();
  const archiveProjectMut = useArchiveProjectMutation();
  const deleteProjectMut = useDeleteProjectMutation();

  const currentSessionNode = selectedSessionId ? findSessionNode(tree, selectedSessionId) : null;
  const runtimeStatus = sessionInfo?.session.runtime_status ?? currentSessionNode?.runtime_status ?? 'idle';

  // Clear streaming when session changes
  useEffect(() => {
    setPendingUserMessages([]);
    setStreamingContent('');
    setStreamNote('');
    setSelectedFilePath(null);
  }, [selectedSessionId]);

  // Restore session from URL first, then fallback to first available session.
  useEffect(() => {
    if (!tree.length) return;

    const requestedSessionId = getSessionIdFromPath(window.location.pathname) ?? initialUrlSessionId;
    const resolvedSessionId = selectedSessionId ?? requestedSessionId;

    if (resolvedSessionId) {
      const pid = findProjectId(tree, resolvedSessionId);
      if (pid) {
        if (selectedSessionId !== resolvedSessionId) setSelectedSessionId(resolvedSessionId);
        if (selectedProjectId !== pid) setSelectedProjectId(pid);
        return;
      }
    }

    const fallback = findFirstSession(tree);
    if (!fallback) return;

    if (selectedSessionId !== fallback.sessionId) setSelectedSessionId(fallback.sessionId);
    if (selectedProjectId !== fallback.projectId) setSelectedProjectId(fallback.projectId);
  }, [tree, selectedSessionId, selectedProjectId, initialUrlSessionId]);

  // Keep URL in sync with current session selection.
  useEffect(() => {
    const targetPath = getSessionPath(selectedSessionId);
    if (window.location.pathname !== targetPath) {
      window.history.replaceState(null, '', targetPath);
    }
  }, [selectedSessionId]);

  // Resolve projectId from tree
  useEffect(() => {
    if (!selectedSessionId || !tree.length) return;
    const pid = findProjectId(tree, selectedSessionId);
    if (pid) setSelectedProjectId(pid);
  }, [selectedSessionId, tree]);

  // WS
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
          const message = JSON.parse(event.data as string) as ServerMessage;

          // chat_stream
          if (message.kind === 'chat_stream' && message.scope?.session_id === selectedSessionId) {
            if (activeTabRef.current === 'chat') {
              const delta = message.payload?.delta ?? '';
              setStreamNote(`${message.phase}${delta ? ' · streaming' : ''}`);
              if (message.phase === 'start') {
                setStreamingContent('');
              } else if (message.phase === 'delta') {
                setStreamingContent((prev) => prev + delta);
              }
            }

            if (message.phase === 'complete') {
              setStreamNote('');
              Promise.all([
                queryClient.invalidateQueries({ queryKey: ['session', 'messages', selectedSessionId] }),
                queryClient.invalidateQueries({ queryKey: ['tree'] }),
              ]).then(() => {
                setStreamingContent('');
                setStreamNote('');
                setPendingUserMessages([]);
              });
            }

            if (message.phase === 'error') {
              setStreamNote('error');
            }
          }

          // runtime_status_changed
          if (message.kind === 'event' && message.type === 'session.runtime_status_changed') {
            treeQuery.refetch();
            const status = message.payload?.runtime_status;
            if (status === 'idle') {
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

          // tree change events
          if (
            message.kind === 'event' &&
            (message.type === 'tree.changed' ||
              message.type === 'project.created' ||
              message.type === 'session.created' ||
              message.type === 'session.archived')
          ) {
            treeQuery.refetch();
          }
        } catch {
          /* ignore parse errors */
        }
      },
      onOpen() {
        setWsConnected(true);
        socket.hello();
        socket.setContext({
          project_id: selectedProjectIdRef.current ?? undefined,
          session_id: selectedSessionId,
          current_tab: activeTabRef.current === 'info'
            ? 'session_info'
            : activeTabRef.current === 'diff'
              ? 'git_diff'
              : activeTabRef.current === 'files'
                ? 'files'
                : 'chat',
        });
        socket.ping();
      },
      onClose() {
        setWsConnected(false);
      },
    });

    socketRef.current = socket;
    return () => {
      socketRef.current = null;
      socket.close();
    };
  }, [selectedSessionId]);

  // Update WS context when tab/project changes
  useEffect(() => {
    if (!socketRef.current || !selectedSessionId) return;
    socketRef.current.setContext({
      project_id: selectedProjectId ?? undefined,
      session_id: selectedSessionId,
      current_tab: activeTab === 'info'
        ? 'session_info'
        : activeTab === 'diff'
          ? 'git_diff'
          : activeTab === 'files'
            ? 'files'
            : 'chat',
    });
  }, [activeTab, selectedProjectId, selectedSessionId]);

  // Handlers
  const handleLogin = useCallback(
    async (password: string) => {
      try {
        await loginMutation.mutateAsync(password);
        authQuery.refetch();
      } catch { /* handled by mutation state */ }
    },
    [loginMutation, authQuery],
  );

  const handleLogout = useCallback(() => {
    logoutMutation.mutate();
  }, [logoutMutation]);

  const handleSelectSession = useCallback(
    (projectId: string, sessionId: string) => {
      setSelectedProjectId(projectId);
      setSelectedSessionId(sessionId);
      const targetPath = getSessionPath(sessionId);
      if (window.location.pathname !== targetPath) {
        window.history.pushState(null, '', targetPath);
      }
    },
    [],
  );

  const handleCreateProject = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!createName.trim()) return;
      try {
        const result = await createProjectMut.mutateAsync({
          name: createName.trim(),
          mode: createMode,
          path: createMode === 'existing' ? createPath : undefined,
          repoUrl: createMode === 'git_clone' ? createRepoUrl : undefined,
          model: createProjectModelKey
            ? (() => {
                const [provider, id] = createProjectModelKey.split('/');
                return provider && id ? { provider, id, label: createProjectModelKey } : null;
              })()
            : null,
        });
        setShowCreateProject(false);
        setCreateName('');
        setCreatePath('');
        setCreateRepoUrl('');
        setCreateProjectModelKey('');
        if (result.sessionId) {
          setSelectedProjectId(result.projectId);
          setSelectedSessionId(result.sessionId);
        }
        await treeQuery.refetch();
      } catch { /* ignore */ }
    },
    [createName, createMode, createPath, createRepoUrl, createProjectModelKey, createProjectMut, treeQuery],
  );

  const handleCreateSession = useCallback(async () => {
    if (!selectedProjectId) return;
    try {
      const result = await createSessionMut.mutateAsync({
        projectId: selectedProjectId,
      });
      setSelectedSessionId(result.session_id);
      await treeQuery.refetch();
    } catch { /* ignore */ }
  }, [selectedProjectId, createSessionMut, treeQuery]);

  const handleSend = useCallback(
    async (content: string) => {
      if (!selectedSessionId) return;
      const optimisticMessage: ChatMessageDTO = {
        id: `optimistic_${Date.now()}`,
        role: 'user',
        message_kind: 'normal',
        source_session_id: null,
        content_text: content,
        created_at: new Date().toISOString(),
      };
      setPendingUserMessages((prev) => [...prev, optimisticMessage]);
      await sendMessageMut.mutateAsync(content);
      queryClient.invalidateQueries({ queryKey: ['session', 'messages', selectedSessionId] });
    },
    [selectedSessionId, sendMessageMut, queryClient],
  );

  const handleStop = useCallback(async () => {
    if (!selectedSessionId) return;
    await stopSessionMut.mutateAsync(selectedSessionId);
    setStreamNote('stopping');
  }, [selectedSessionId, stopSessionMut]);

  const handleArchiveSession = useCallback(async () => {
    if (!selectedSessionId) return;
    await archiveSessionMut.mutateAsync(selectedSessionId);
    await treeQuery.refetch();
  }, [selectedSessionId, archiveSessionMut, treeQuery]);

  const handleModelSelect = useCallback(
    async (provider: string, id: string) => {
      if (!selectedSessionId) return;
      await setModelMut.mutateAsync({ sessionId: selectedSessionId, provider, id });
      queryClient.invalidateQueries({ queryKey: ['session', 'info', selectedSessionId] });
    },
    [selectedSessionId, setModelMut, queryClient],
  );

  const handleRefreshDiff = useCallback(() => {
    if (!selectedSessionId) return;
    queryClient.invalidateQueries({ queryKey: ['session', 'git-diff', selectedSessionId] });
  }, [selectedSessionId, queryClient]);

  // Git mutations
  const gitPullMut = useGitPullMutation(selectedSessionId);
  const gitPushMut = useGitPushMutation(selectedSessionId);
  const gitCommitMut = useGitCommitMutation(selectedSessionId);
  const addGitignoreMut = useAddGitignoreMutation(selectedSessionId);

  const handleGitPull = useCallback(async () => {
    return gitPullMut.mutateAsync();
  }, [gitPullMut]);

  const handleGitPush = useCallback(async () => {
    return gitPushMut.mutateAsync();
  }, [gitPushMut]);

  const handleGitCommit = useCallback(
    async (message: string) => {
      return gitCommitMut.mutateAsync(message);
    },
    [gitCommitMut],
  );

  const handleLoadMore = useCallback(() => {
    if (messagesQuery.hasNextPage && !messagesQuery.isFetchingNextPage) {
      messagesQuery.fetchNextPage();
    }
  }, [messagesQuery]);

  const handleArchiveProject = useCallback(
    (projectId: string) => {
      archiveProjectMut.mutate(projectId);
    },
    [archiveProjectMut],
  );

  const handleDeleteProject = useCallback(
    (projectId: string) => {
      deleteProjectMut.mutate(projectId);
    },
    [deleteProjectMut],
  );

  // Login screen
  if (!isLoggedIn) {
    return (
      <LoginScreen
        busy={loginMutation.isPending}
        error={loginMutation.isError ? '密码错误' : null}
        onSubmit={handleLogin}
      />
    );
  }

  const modelLabel = sessionInfo?.session.current_model?.label ?? modelsQuery.data?.[0]?.label;
  const modelDisabled = runtimeStatus !== 'idle';

  return (
    <div className={`flex h-screen w-screen overflow-hidden bg-slate-100 dark:bg-slate-950 text-slate-800 dark:text-slate-100 font-sans antialiased ${theme}`}>
      <Sidebar
        projects={tree}
        activeSessionId={selectedSessionId}
        isSidebarCollapsed={sidebarCollapsed}
        onSelectSession={handleSelectSession}
        onSelectProject={setSelectedProjectId}
        onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
        onCreateProject={() => setShowCreateProject(true)}
        onCreateSession={handleCreateSession}
        onArchiveProject={handleArchiveProject}
        onDeleteProject={handleDeleteProject}
        onLogout={handleLogout}
        onOpenSettings={() => setShowSettings(true)}
        showArchived={showArchived}
        onToggleShowArchived={() => setShowArchived(!showArchived)}
        treeLoading={treeQuery.isLoading}
        creatingSession={createSessionMut.isPending}
      />

      {/* Main content */}
      <div className="flex-1 flex flex-col h-full bg-white dark:bg-slate-900 relative">
        {/* Top header bar */}
        <header className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-6 py-2 shrink-0 flex flex-wrap items-center justify-between select-none">
          {sessionInfo && (
            <div className="flex items-center space-x-3 py-1">
              <h1 className="text-slate-800 dark:text-slate-100 font-bold text-sm mr-2 font-sans leading-none">
                {sessionInfo.session.title}
              </h1>

              <button
                onClick={handleArchiveSession}
                className="flex items-center space-x-1 px-3 py-1.5 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-300 transition cursor-pointer disabled:opacity-50"
                disabled={archiveSessionMut.isPending}
              >
                <Archive className="w-3.5 h-3.5" />
                <span>{archiveSessionMut.isPending ? '...' : 'Archive'}</span>
              </button>

              {modelsQuery.data && modelsQuery.data.length > 0 && (
                <div className="relative">
                  <select
                    value={
                      sessionInfo.session.current_model
                        ? `${sessionInfo.session.current_model.provider}/${sessionInfo.session.current_model.id}`
                        : ''
                    }
                    onChange={(e) => {
                      const [provider, id] = e.target.value.split('/');
                      if (provider && id) handleModelSelect(provider, id);
                    }}
                    disabled={modelDisabled}
                    className="appearance-none bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-xl px-3 py-1.5 pr-8 text-xs font-semibold text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer disabled:opacity-50"
                  >
                    {modelsQuery.data.map((m) => (
                      <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                        {m.provider} / {m.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="w-3.5 h-3.5 absolute right-2.5 top-2.5 pointer-events-none text-slate-500" />
                </div>
              )}

              {streamNote && (
                <span className="text-xs text-blue-600 dark:text-blue-400 font-medium">
                  {streamNote}
                </span>
              )}
            </div>
          )}

          <div className="flex space-x-1">
            <button
              onClick={() => setActiveTab('chat')}
              className={`px-4 py-2 text-sm font-semibold transition border-b-2 rounded-t-lg cursor-pointer ${
                activeTab === 'chat'
                  ? 'border-blue-600 text-slate-900 dark:text-slate-100 bg-slate-50 dark:bg-slate-800'
                  : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              Chat
            </button>
            <button
              onClick={() => setActiveTab('info')}
              className={`px-4 py-2 text-sm font-semibold transition border-b-2 rounded-t-lg cursor-pointer ${
                activeTab === 'info'
                  ? 'border-blue-600 text-slate-900 dark:text-slate-100 bg-slate-50 dark:bg-slate-800'
                  : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              Session Info
            </button>
            <button
              onClick={() => setActiveTab('diff')}
              className={`px-4 py-2 text-sm font-semibold transition border-b-2 rounded-t-lg cursor-pointer ${
                activeTab === 'diff'
                  ? 'border-blue-600 text-slate-900 dark:text-slate-100 bg-slate-50 dark:bg-slate-800'
                  : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              Git
            </button>
            <button
              onClick={() => setActiveTab('files')}
              className={`px-4 py-2 text-sm font-semibold transition border-b-2 rounded-t-lg cursor-pointer ${
                activeTab === 'files'
                  ? 'border-blue-600 text-slate-900 dark:text-slate-100 bg-slate-50 dark:bg-slate-800'
                  : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              Files
            </button>
          </div>
        </header>

        {/* Tab content */}
        <div className="flex-1 overflow-hidden relative">
          {selectedSessionId ? (
            <>
              {activeTab === 'chat' && (
                <TabChat
                  messages={messages}
                  pendingUserMessages={pendingUserMessages}
                  hasMore={hasMoreMessages}
                  loadingMore={loadingMoreMessages}
                  onLoadMore={handleLoadMore}
                  onSend={handleSend}
                  onStop={handleStop}
                  sending={sendMessageMut.isPending}
                  runtimeStatus={runtimeStatus}
                  streamNote={streamNote}
                  streamingContent={streamingContent}
                  sessionTitle={sessionInfo?.session.title}
                  wsConnected={wsConnected}
                  selectedSessionId={selectedSessionId}
                  sendShortcutMode={sendShortcutMode}
                />
              )}

              {activeTab === 'info' && (
                <TabSessionInfo
                  sessionInfo={sessionInfo ?? null}
                  isLoading={sessionInfoQuery.isLoading}
                />
              )}

              {activeTab === 'diff' && (
                <TabGitDiff
                  diff={gitDiffQuery.data?.diff ?? null}
                  isLoading={gitDiffQuery.isLoading}
                  onRefresh={handleRefreshDiff}
                  onPull={handleGitPull}
                  onPush={handleGitPush}
                  onCommit={handleGitCommit}
                  isPulling={gitPullMut.isPending}
                  isPushing={gitPushMut.isPending}
                  isCommitting={gitCommitMut.isPending}
                  onAddGitignore={(filePath) => addGitignoreMut.mutateAsync(filePath)}
                  isAddingGitignore={addGitignoreMut.isPending}
                />
              )}

              {activeTab === 'files' && (
                <TabFiles
                  treeResponse={fileTreeQuery.data ?? null}
                  treeLoading={fileTreeQuery.isLoading}
                  treeError={fileTreeQuery.error instanceof Error ? fileTreeQuery.error.message : null}
                  contentResponse={fileContentQuery.data ?? null}
                  contentLoading={fileContentQuery.isLoading}
                  contentError={fileContentQuery.error instanceof Error ? fileContentQuery.error.message : null}
                  selectedPath={selectedFilePath}
                  onSelectPath={setSelectedFilePath}
                  onRefresh={() => {
                    void fileTreeQuery.refetch();
                  }}
                />
              )}
            </>
          ) : (
            <div className="h-full flex flex-col items-center justify-center p-8 bg-slate-50 dark:bg-slate-900/40">
              <div className="text-center space-y-2">
                <h2 className="text-base font-bold text-slate-700 dark:text-slate-300">未选择会话</h2>
                <p className="text-xs text-slate-400 dark:text-slate-500">
                  在侧边栏选择或新建一个会话以开始工作。
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Create Project Modal */}
      <Modal
        isOpen={showCreateProject}
        onClose={() => setShowCreateProject(false)}
        title="新建项目"
        icon={<PlusCircle className="w-4 h-4 text-blue-600 dark:text-blue-400" />}
      >
        <form onSubmit={handleCreateProject} className="space-y-4">
          <div>
            <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">
              项目名称 <span className="text-red-500">*</span>
            </label>
            <input
              required
              autoFocus
              type="text"
              placeholder="请输入项目名称..."
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 transition placeholder:text-slate-400"
            />
          </div>

          <div>
            <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">
              模式
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setCreateMode('existing')}
                className={`flex-1 px-3 py-2 text-xs font-semibold rounded-lg border transition cursor-pointer ${
                  createMode === 'existing'
                    ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-400'
                    : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                }`}
              >
                绑定目录
              </button>
              <button
                type="button"
                onClick={() => setCreateMode('git_clone')}
                className={`flex-1 px-3 py-2 text-xs font-semibold rounded-lg border transition cursor-pointer ${
                  createMode === 'git_clone'
                    ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-400'
                    : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                }`}
              >
                Git Clone
              </button>
            </div>
          </div>

          {createMode === 'existing' ? (
            <div>
              <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">
                项目路径 <span className="text-red-500">*</span>
              </label>
              <input
                required
                type="text"
                placeholder="/path/to/project"
                value={createPath}
                onChange={(e) => setCreatePath(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 transition placeholder:text-slate-400"
              />
            </div>
          ) : (
            <div>
              <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">
                Git 仓库地址 <span className="text-red-500">*</span>
              </label>
              <input
                required
                type="url"
                placeholder="https://github.com/user/repo"
                value={createRepoUrl}
                onChange={(e) => setCreateRepoUrl(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 transition placeholder:text-slate-400"
              />
            </div>
          )}

          <div>
            <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">
              负责人模型
            </label>
            <div className="relative">
              <select
                value={createProjectModelKey}
                onChange={(e) => setCreateProjectModelKey(e.target.value)}
                className="w-full appearance-none px-3 py-2 pr-8 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 transition"
              >
                <option value="">使用默认模型</option>
                {(modelsQuery.data ?? []).map((m) => (
                  <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                    {m.provider} / {m.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="w-3.5 h-3.5 absolute right-2.5 top-2.5 pointer-events-none text-slate-500" />
            </div>
          </div>

          <div className="flex space-x-2 pt-3 justify-end border-t border-slate-150 dark:border-slate-800">
            <button
              type="button"
              onClick={() => setShowCreateProject(false)}
              className="px-3 py-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition cursor-pointer"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={createProjectMut.isPending}
              className="px-4 py-1.5 text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 rounded-lg shadow-2xs hover:shadow-xs transition cursor-pointer disabled:opacity-50"
            >
              {createProjectMut.isPending ? '创建中…' : '确认创建'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Settings Modal */}
      <Modal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        title="设置"
        icon={<Settings className="w-4 h-4 text-slate-500 dark:text-slate-400" />}
      >
        <div className="space-y-4">
          <div>
            <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
              发送快捷键
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => setSendShortcutMode('enter')}
                className={`flex-1 px-3 py-2 text-xs font-semibold rounded-lg border transition cursor-pointer ${
                  sendShortcutMode === 'enter'
                    ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-400'
                    : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                }`}
              >
                Enter 发送
              </button>
              <button
                onClick={() => setSendShortcutMode('mod_enter')}
                className={`flex-1 px-3 py-2 text-xs font-semibold rounded-lg border transition cursor-pointer ${
                  sendShortcutMode === 'mod_enter'
                    ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-400'
                    : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                }`}
              >
                Ctrl/Cmd+Enter 发送
              </button>
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
              主题
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => setTheme('light')}
                className={`flex-1 px-3 py-2 text-xs font-semibold rounded-lg border transition cursor-pointer ${
                  theme === 'light'
                    ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-400'
                    : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                }`}
              >
                浅色
              </button>
              <button
                onClick={() => setTheme('dark')}
                className={`flex-1 px-3 py-2 text-xs font-semibold rounded-lg border transition cursor-pointer ${
                  theme === 'dark'
                    ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-400'
                    : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                }`}
              >
                深色
              </button>
            </div>
          </div>

          <div className="flex justify-end pt-3 border-t border-slate-150 dark:border-slate-800">
            <button
              onClick={() => setShowSettings(false)}
              className="px-4 py-1.5 text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 rounded-lg shadow-2xs transition cursor-pointer"
            >
              关闭
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
