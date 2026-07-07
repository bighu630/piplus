import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ProjectDTO, SessionTreeNodeDTO } from '@piplus/shared';
import { findSessionNode } from './lib/tree-utils';
import type { SessionMessageImageAttachment } from './lib/api';
import hljsLight from 'highlight.js/styles/github.css?url';
import hljsDark from 'highlight.js/styles/github-dark.css?url';
import {
  getNotificationPermission,
  requestNotificationPermission,
} from './lib/notification';
import Sidebar from './components/Sidebar';
import TabChat from './components/TabChat';
import TabSessionInfo from './components/TabSessionInfo';
import TabGitDiff from './components/TabGitDiff';
import TabFiles from './components/TabFiles';
import Modal from './components/Modal';
import Select from './components/Select';
import CreateProjectModal from './components/CreateProjectModal';
import ProviderModal from './components/ProviderModal';
import ProjectSettingsModal from './components/ProjectSettingsModal';
import { LoginScreen } from './components/LoginScreen';
import { WebSocketProvider, useWebSocket } from './lib/ws-provider';
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
  useSetSessionPinnedMutation,
  useCompactSessionMutation,
  usePlannerRolePromptMutation,
  useLoginMutation,
  useLogoutMutation,
  useModelsStatus,
  useModels,
  useSetSessionModelMutation,
  useArchiveProjectMutation,
  useSetProjectPinnedMutation,
  useDeleteProjectMutation,
  useTestModelProviderMutation,
  useCreateModelProviderMutation,
  useNativeModelProviders,
  useSetNativeProviderApiKeyMutation,
  useUpdateSessionTitleMutation,
  useProjectRoleModels,
  useSetProjectRoleModelsMutation,
  usePackages,
  useInstallPackageMutation,
  useRemovePackageMutation,
  useUpdatePackagesMutation,
  useTogglePackageMutation,
  usePackageUpdates,
  useSessionThinkingLevel,
  useSetSessionThinkingLevelMutation,
} from './lib/hooks';
import {
  Settings,
  PlusCircle,
  Database,
  Trash2,
  Pencil,
  PanelLeft,
  AlertTriangle,
  Package,
  RefreshCw,
} from 'lucide-react';

type Tab = 'chat' | 'info' | 'diff' | 'files' | 'doce';
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


function useIsMobile(breakpoint = 768): boolean {
  const getIsMobile = useCallback(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(`(max-width: ${breakpoint - 1}px)`).matches;
  }, [breakpoint]);

  const [isMobile, setIsMobile] = useState(getIsMobile);

  useEffect(() => {
    const mediaQuery = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const update = () => setIsMobile(mediaQuery.matches);

    update();
    mediaQuery.addEventListener('change', update);
    window.addEventListener('resize', update);

    return () => {
      mediaQuery.removeEventListener('change', update);
      window.removeEventListener('resize', update);
    };
  }, [breakpoint]);

  return isMobile;
}

export default function App() {
  const authQuery = useAuthSession();
  const isLoggedIn = Boolean(authQuery.data?.ok);
  const modelsStatusQuery = useModelsStatus();
  const loginMutation = useLoginMutation();
  const logoutMutation = useLogoutMutation();

  const [activeTab, setActiveTab] = useState<Tab>('chat');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = localStorage.getItem('pi-sidebar-width');
      const parsed = saved ? Number(saved) : 256;
      return Number.isFinite(parsed) ? Math.max(240, Math.min(520, parsed)) : 256;
    } catch { return 256; }
  });
  const [showArchived, setShowArchived] = useState(() => {
    try { return localStorage.getItem('pi-show-archived') === 'true'; } catch { return false; }
  });
  const [editingTitle, setEditingTitle] = useState(false);
  const [editTitleValue, setEditTitleValue] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [showWorker, setShowWorker] = useState(() => {
    try { return localStorage.getItem('pi-show-worker') !== 'false'; } catch { return true; }
  });
  const [showSettings, setShowSettings] = useState(false);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [showProviderModal, setShowProviderModal] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'general' | 'notifications' | 'models' | 'packages'>('general');

  const [showProjectSettings, setShowProjectSettings] = useState(false);

  const [packageSource, setPackageSource] = useState('');
  const [packageError, setPackageError] = useState<string | null>(null);
  const [packageSuccess, setPackageSuccess] = useState<string | null>(null);

  const [currentModelSupportsImages, setCurrentModelSupportsImages] = useState<boolean | null>(null);

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
  const [systemNotificationsEnabled, setSystemNotificationsEnabled] = useState(() => {
    try { return localStorage.getItem('pi-system-notifications') === 'true'; } catch { return false; }
  });
  const [notificationPermissionStatus, setNotificationPermissionStatus] = useState<string | null>(null);
  const isMobile = useIsMobile();
  const [showMobileSidebar, setShowMobileSidebar] = useState(() => !(typeof window !== 'undefined' && getSessionIdFromPath(window.location.pathname)));
  const isSidebarVisible = !isMobile || showMobileSidebar;
  const isContentVisible = !isMobile || !showMobileSidebar;

  useEffect(() => {
    try { localStorage.setItem('pi-workspace-theme', theme); } catch {}
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
    try { localStorage.setItem('pi-send-shortcut-mode', sendShortcutMode); } catch {}
  }, [sendShortcutMode]);

  useEffect(() => {
    try { localStorage.setItem('pi-system-notifications', String(systemNotificationsEnabled)); } catch {}
  }, [systemNotificationsEnabled]);

  // Reconcile persisted toggle state with actual browser permission on mount.
  // If notifications were previously enabled but permission is no longer granted,
  // turn the toggle off and show an inline status message.
  useEffect(() => {
    const permission = getNotificationPermission();
    if (systemNotificationsEnabled && permission !== 'granted') {
      setSystemNotificationsEnabled(false);
      if (permission === 'unsupported') {
        setNotificationPermissionStatus('unsupported');
      } else {
        // 'denied' or 'default' — either way, notifications won't fire
        setNotificationPermissionStatus(permission);
      }
    }
    // Intentionally run only on mount: systemNotificationsEnabled is the initial value
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (Number.isFinite(sidebarWidth)) {
      try { localStorage.setItem('pi-sidebar-width', String(sidebarWidth)); } catch {}
    }
  }, [sidebarWidth]);

  // Restore session runtime when entering a session
  useEffect(() => {
    if (!selectedSessionId) return;
    import('./lib/api').then(({ restoreSessionRuntime }) => {
      restoreSessionRuntime(selectedSessionId).catch(() => {});
    });
  }, [selectedSessionId]);

  const queryClient = useQueryClient();
  const treeQuery = useTree();
  const tree = treeQuery.data?.projects ?? [];
  const sessionInfoQuery = useSessionInfo(selectedSessionId);
  const sessionInfo = sessionInfoQuery.data;
  const modelsQuery = useModels();
  const setModelMut = useSetSessionModelMutation();
  const thinkingLevelQuery = useSessionThinkingLevel(selectedSessionId);
  const setThinkingLevelMut = useSetSessionThinkingLevelMutation();
  const testProviderMut = useTestModelProviderMutation();
  const createProviderMut = useCreateModelProviderMutation();
  const nativeProvidersQuery = useNativeModelProviders();
  const setNativeApiKeyMut = useSetNativeProviderApiKeyMutation();
  const setProjectRoleModelsMut = useSetProjectRoleModelsMutation();
  const projectRoleModelsQuery = useProjectRoleModels(showProjectSettings ? selectedProjectId : null);
  const packagesQuery = usePackages();
  const projectPackagesQuery = usePackages(showProjectSettings ? selectedProjectId : null);
  const projectPackagesUpdatesQuery = usePackageUpdates(showProjectSettings ? selectedProjectId : null);
  const installPkgMut = useInstallPackageMutation();
  const removePkgMut = useRemovePackageMutation();
  const updatePkgMut = useUpdatePackagesMutation();
  const togglePkgMut = useTogglePackageMutation();
  const packagesUpdatesQuery = usePackageUpdates();

  const createProjectMut = useCreateProjectMutation();
  const createSessionMut = useCreateSessionMutation();
  const sendMessageMut = useSendMessageMutation(selectedSessionId);
  const stopSessionMut = useStopSessionMutation();
  const archiveSessionMut = useArchiveSessionMutation();
  const setSessionPinnedMut = useSetSessionPinnedMutation();
  const compactSessionMut = useCompactSessionMutation();
  const plannerRolePromptMut = usePlannerRolePromptMutation();
  const archiveProjectMut = useArchiveProjectMutation();
  const setProjectPinnedMut = useSetProjectPinnedMutation();
  const deleteProjectMut = useDeleteProjectMutation();
  const { connected: wsConnected, localRuntimeStatusBySession, setSessionContext } = useWebSocket();
  const currentSessionNode = selectedSessionId ? findSessionNode(tree, selectedSessionId) : null;
  // localRuntimeStatusBySession is updated immediately from WS runtime_status_changed events,
  // before async query refetches complete. This prevents stale query data from
  // keeping the UI stuck in 'running' after the session has actually ended.
  const runtimeStatus = selectedSessionId
  ? (localRuntimeStatusBySession[selectedSessionId] ?? currentSessionNode?.runtime_status ?? sessionInfo?.session.runtime_status ?? 'idle')
  : 'idle';
  const messagesQuery = useSessionMessages(activeTab === 'chat' ? selectedSessionId : null, 20, runtimeStatus === 'running' ? 1500 : false);
  const messages = useMemo(
    () => messagesQuery.data?.pages.flatMap((p) => p.messages).sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) ?? [],
    [messagesQuery.data]
  );
  const hasMoreMessages = Boolean(messagesQuery.hasNextPage);
  const loadingMoreMessages = messagesQuery.isFetchingNextPage;

  useEffect(() => {
    // localRuntimeStatusBySession is intentionally NOT cleared here —
    // per-session state survives session switches and is keyed by sessionId.
    setEditingTitle(false);
    setEditTitleValue('');
  }, [selectedSessionId]);

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

  useEffect(() => {
    const targetPath = getSessionPath(selectedSessionId);
    if (window.location.pathname !== targetPath) {
      window.history.replaceState(null, '', targetPath);
    }
  }, [selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId || !tree.length) return;
    const pid = findProjectId(tree, selectedSessionId);
    if (pid) setSelectedProjectId(pid);
  }, [selectedSessionId, tree]);

  useEffect(() => {
    if (!isMobile) {
      setShowMobileSidebar(false);
      return;
    }
    setShowMobileSidebar(!selectedSessionId);
  }, [isMobile, selectedSessionId]);

  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  useEffect(() => {
    setSessionContext(selectedSessionId, selectedProjectId, activeTab);
  }, [selectedSessionId, selectedProjectId, activeTab, setSessionContext]);

  const handleLogin = useCallback(async (password: string) => {
    try {
      await loginMutation.mutateAsync(password);
      authQuery.refetch();
    } catch {}
  }, [loginMutation, authQuery]);

  const handleLogout = useCallback(() => {
    logoutMutation.mutate();
  }, [logoutMutation]);

  const handleSelectSession = useCallback((projectId: string, sessionId: string) => {
    setSelectedProjectId(projectId);
    setSelectedSessionId(sessionId);
    setActiveTab('chat');
    setEditingTitle(false);
    setEditTitleValue('');
    if (isMobile) setShowMobileSidebar(false);
    const targetPath = getSessionPath(sessionId);
    if (window.location.pathname !== targetPath) {
      window.history.pushState(null, '', targetPath);
    }
  }, [isMobile]);



  const handleCreateSession = useCallback(async () => {
    if (!selectedProjectId) return;
    try {
      const result = await createSessionMut.mutateAsync({ projectId: selectedProjectId });
      setSelectedSessionId(result.session_id);
      await treeQuery.refetch();
    } catch {}
  }, [selectedProjectId, createSessionMut, treeQuery]);

  const handleSend = useCallback(async (content: string, attachments: SessionMessageImageAttachment[] = []) => {
    if (!selectedSessionId) return;
    await sendMessageMut.mutateAsync({ content, attachments });
    queryClient.invalidateQueries({ queryKey: ['session', 'messages', selectedSessionId] });
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
    const targetId = sessionId ?? selectedSessionId;
    if (!targetId) return;
    const targetNode = findSessionNode(tree, targetId);
    const rootId = targetNode?.root_session_id;
    await archiveSessionMut.mutateAsync(targetId);
    await treeQuery.refetch();
    const pid = rootId ? findProjectId(tree, rootId) : null;
    if (rootId && rootId !== targetId && pid) {
      handleSelectSession(pid, rootId);
    }
  }, [selectedSessionId, tree, archiveSessionMut, treeQuery, handleSelectSession]);

  const handleToggleSessionPinned = useCallback(async (sessionId: string, pinned: boolean) => {
    try {
      await setSessionPinnedMut.mutateAsync({ sessionId, pinned });
      await treeQuery.refetch();
    } catch {}
  }, [setSessionPinnedMut, treeQuery]);

  const handleToggleProjectPinned = useCallback(async (projectId: string, pinned: boolean) => {
    try {
      await setProjectPinnedMut.mutateAsync({ projectId, pinned });
      await treeQuery.refetch();
    } catch {}
  }, [setProjectPinnedMut, treeQuery]);

  const handleSendPlannerRolePrompt = useCallback(async () => {
    if (!selectedSessionId) return;
    const confirmed = confirm('仅在你觉得 planner 变得不会分配工作时使用，确定重新发送提示词吗？\n\n频繁发送可能会浪费一点点 context。');
    if (!confirmed) return;
    const result = await plannerRolePromptMut.mutateAsync(selectedSessionId);
    if (!result.prompt) return;
    await handleSend(result.prompt, []);
  }, [selectedSessionId, plannerRolePromptMut, handleSend]);

  useEffect(() => {
    if (!sessionInfo?.session.current_model || !modelsQuery.data) {
      setCurrentModelSupportsImages(null);
      return;
    }
    const matchedModel = modelsQuery.data.find((model) => (
      model.provider === sessionInfo.session.current_model?.provider
      && model.id === sessionInfo.session.current_model?.id
    ));
    if (!matchedModel) {
      setCurrentModelSupportsImages(null);
      return;
    }
    setCurrentModelSupportsImages(matchedModel.input?.includes('image') ?? null);
  }, [modelsQuery.data, sessionInfo?.session.current_model]);

  const handleModelSelect = useCallback(async (provider: string, id: string) => {
    if (!selectedSessionId) return;
    await setModelMut.mutateAsync({ sessionId: selectedSessionId, provider, id });
    queryClient.invalidateQueries({ queryKey: ['session', 'info', selectedSessionId] });
    queryClient.invalidateQueries({ queryKey: ['session', 'thinking-level', selectedSessionId] });
  }, [selectedSessionId, setModelMut, queryClient]);

  const updateTitleMut = useUpdateSessionTitleMutation();

  const handleOpenProviderModal = useCallback(() => {
    setShowSettings(false);
    setShowProviderModal(true);
  }, []);

  const handleLoadMore = useCallback(() => {
    if (messagesQuery.hasNextPage && !messagesQuery.isFetchingNextPage) {
      messagesQuery.fetchNextPage();
    }
  }, [messagesQuery]);

  const handleStartEditTitle = useCallback(() => {
    if (sessionInfo?.role_template.key === 'planner' && sessionInfo.lineage.depth === 0) return;
    titleSavedRef.current = false;
    setEditTitleValue(sessionInfo?.session.title ?? '');
    setEditingTitle(true);
    requestAnimationFrame(() => titleInputRef.current?.select());
  }, [sessionInfo]);

  const [titleSavedRef] = useState(() => ({ current: false }));

  const handleSaveTitle = useCallback(() => {
    if (titleSavedRef.current) return;
    if (!selectedSessionId) return;
    if (!editTitleValue.trim()) {
      setEditingTitle(false);
      return;
    }
    titleSavedRef.current = true;
    updateTitleMut.mutate({ sessionId: selectedSessionId, title: editTitleValue.trim() });
    setEditingTitle(false);
  }, [selectedSessionId, editTitleValue, updateTitleMut]);

  const handleCancelEditTitle = useCallback(() => {
    titleSavedRef.current = true;
    setEditingTitle(false);
    setEditTitleValue('');
  }, []);

  const handleTitleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') handleSaveTitle();
    else if (e.key === 'Escape') handleCancelEditTitle();
  }, [handleSaveTitle, handleCancelEditTitle]);

  const handleArchiveProject = useCallback((projectId: string) => {
    archiveProjectMut.mutate(projectId);
  }, [archiveProjectMut]);

  const handleDeleteProject = useCallback((projectId: string) => {
    deleteProjectMut.mutate(projectId);
  }, [deleteProjectMut]);

  const handleOpenProjectSettings = useCallback((projectId: string) => {
    setSelectedProjectId(projectId);
    setShowProjectSettings(true);
  }, []);





  const handleToggleSystemNotifications = useCallback(async (enabled: boolean) => {
    if (enabled) {
      const permission = await requestNotificationPermission();
      if (permission === 'granted') {
        setSystemNotificationsEnabled(true);
        setNotificationPermissionStatus(null);
      } else if (permission === 'denied') {
        setNotificationPermissionStatus('denied');
        setSystemNotificationsEnabled(false);
      } else if (permission === 'default') {
        setNotificationPermissionStatus('default');
        setSystemNotificationsEnabled(false);
      } else {
        setNotificationPermissionStatus('unsupported');
        setSystemNotificationsEnabled(false);
      }
    } else {
      setSystemNotificationsEnabled(false);
      setNotificationPermissionStatus(null);
    }
  }, []);

  const handleToggleShowArchived = useCallback(() => {
    setShowArchived((v) => {
      const next = !v;
      try { localStorage.setItem('pi-show-archived', String(next)); } catch {}
      return next;
    });
  }, []);

  const handleToggleShowWorker = useCallback(() => {
    setShowWorker((v) => {
      const next = !v;
      try { localStorage.setItem('pi-show-worker', String(next)); } catch {}
      return next;
    });
  }, []);

  if (!isLoggedIn) {
    return (
      <LoginScreen
        busy={loginMutation.isPending}
        error={loginMutation.isError ? (loginMutation.error as Error)?.message || '登录失败' : null}
        modelStatus={modelsStatusQuery.data ? { ok: modelsStatusQuery.data.ok, count: modelsStatusQuery.data.count } : null}
        onSubmit={handleLogin}
      />
    );
  }

  const isPlannerRoot = sessionInfo?.role_template.key === 'planner' && sessionInfo.lineage.depth === 0;

  return (
    <WebSocketProvider>
    <div className={`flex flex-col md:flex-row h-[100dvh] min-h-0 w-full overflow-hidden overscroll-none bg-slate-100 dark:bg-slate-950 text-slate-800 dark:text-slate-100 font-sans antialiased ${theme}`}>
      <div className={`${isSidebarVisible ? 'flex' : 'hidden'} w-full min-w-0 flex-1 md:w-auto md:flex-none`}>
        <Sidebar
          projects={tree}
          activeSessionId={selectedSessionId}
          isSidebarCollapsed={sidebarCollapsed}
          sidebarWidth={sidebarWidth}
          onWidthChange={setSidebarWidth}
          onSelectSession={handleSelectSession}
          onSelectProject={setSelectedProjectId}
          onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
          onCreateProject={() => setShowCreateProject(true)}
          onCreateSession={handleCreateSession}
          onArchiveProject={handleArchiveProject}
          onToggleProjectPinned={handleToggleProjectPinned}
          onToggleSessionPinned={handleToggleSessionPinned}
          onArchiveSession={handleArchiveSession}
          onDeleteProject={handleDeleteProject}
          onLogout={handleLogout}
          onOpenSettings={() => setShowSettings(true)}
          onOpenProjectSettings={handleOpenProjectSettings}
          showArchived={showArchived}
          onToggleShowArchived={handleToggleShowArchived}
          showWorker={showWorker}
          onToggleShowWorker={handleToggleShowWorker}
          treeLoading={treeQuery.isLoading}
          creatingSession={createSessionMut.isPending}
          isMobile={isMobile}
          isMobileVisible={showMobileSidebar}
          onReturnToTree={() => setShowMobileSidebar(true)}
        />
      </div>

      <div className={`${isContentVisible ? 'flex' : 'hidden'} w-full flex-1 min-w-0 flex-col h-full overflow-hidden bg-slate-50 dark:bg-slate-900 relative`}>
        <header className={`border-b border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-900 shrink-0 select-none ${isMobile ? 'px-4 py-2' : 'px-6 py-2 flex flex-wrap items-center justify-between'}`}>
          {isMobile ? (
            <>
              <div className="flex items-center justify-between gap-2 min-w-0">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <button
                    onClick={() => setShowMobileSidebar(true)}
                    className="p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer shrink-0"
                    title="打开目录树"
                    aria-label="打开目录树"
                  >
                    <PanelLeft className="w-4 h-4 text-slate-500 dark:text-slate-400" />
                  </button>
                  {sessionInfo && (
                    <div className={`flex items-center gap-2 py-1 min-w-0 ${!isPlannerRoot ? 'group/title' : ''}`}>
                      {editingTitle ? (
                        <input
                          ref={titleInputRef}
                          type="text"
                          value={editTitleValue}
                          onChange={(e) => setEditTitleValue(e.target.value)}
                          onBlur={handleCancelEditTitle}
                          onKeyDown={handleTitleKeyDown}
                          className="text-sm font-bold font-sans leading-none px-1 py-0.5 border border-blue-500 rounded-md bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 outline-none w-48"
                          autoFocus
                        />
                      ) : (
                        <>
                          <h1 className="text-slate-800 dark:text-slate-100 font-bold text-sm font-sans leading-none truncate">
                            {sessionInfo.session.title}
                          </h1>
                          {!isPlannerRoot && (
                            <button
                              onClick={handleStartEditTitle}
                              className="opacity-100 transition-opacity p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer shrink-0"
                              title="编辑标题"
                            >
                              <Pencil className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-2 -mx-1 px-1 overflow-x-auto overflow-y-hidden">
                <div className="flex min-w-max space-x-1">
                  <button onClick={() => setActiveTab('chat')} className={`px-3 py-2 text-xs font-semibold transition border-b-2 rounded-t-lg cursor-pointer whitespace-nowrap ${activeTab === 'chat' ? 'border-blue-600 text-slate-900 dark:text-slate-100 bg-slate-50 dark:bg-slate-800' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}`}>Chat</button>
                  <button onClick={() => setActiveTab('info')} className={`px-3 py-2 text-xs font-semibold transition border-b-2 rounded-t-lg cursor-pointer whitespace-nowrap ${activeTab === 'info' ? 'border-blue-600 text-slate-900 dark:text-slate-100 bg-slate-50 dark:bg-slate-800' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}`}>Session Info</button>
                  <button onClick={() => setActiveTab('diff')} className={`px-3 py-2 text-xs font-semibold transition border-b-2 rounded-t-lg cursor-pointer whitespace-nowrap ${activeTab === 'diff' ? 'border-blue-600 text-slate-900 dark:text-slate-100 bg-slate-50 dark:bg-slate-800' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}`}>Git</button>
                  <button onClick={() => setActiveTab('files')} className={`px-3 py-2 text-xs font-semibold transition border-b-2 rounded-t-lg cursor-pointer whitespace-nowrap ${activeTab === 'files' ? 'border-blue-600 text-slate-900 dark:text-slate-100 bg-slate-50 dark:bg-slate-800' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}`}>Files</button>
                  <button onClick={() => setActiveTab('doce')} className={`px-3 py-2 text-xs font-semibold transition border-b-2 rounded-t-lg cursor-pointer whitespace-nowrap ${activeTab === 'doce' ? 'border-blue-600 text-slate-900 dark:text-slate-100 bg-slate-50 dark:bg-slate-800' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}`}>Doce</button>
                </div>
              </div>
            </>
          ) : (
            <>
              {sessionInfo && (
                <div className={`flex items-center space-x-3 py-1 ${!isPlannerRoot ? 'group/title' : ''}`}>
                  {editingTitle ? (
                    <input
                      ref={titleInputRef}
                      type="text"
                      value={editTitleValue}
                      onChange={(e) => setEditTitleValue(e.target.value)}
                      onBlur={handleCancelEditTitle}
                      onKeyDown={handleTitleKeyDown}
                      className="text-sm font-bold font-sans leading-none px-1 py-0.5 border border-blue-500 rounded-md bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 outline-none w-64"
                      autoFocus
                    />
                  ) : (
                    <>
                      <h1 className="text-slate-800 dark:text-slate-100 font-bold text-sm mr-2 font-sans leading-none">
                        {sessionInfo.session.title}
                      </h1>
                      {!isPlannerRoot && (
                        <button
                          onClick={handleStartEditTitle}
                          className="opacity-0 group-hover/title:opacity-100 transition-opacity p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer"
                          title="编辑标题"
                        >
                          <Pencil className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}

              <div className="flex space-x-1">
                <button onClick={() => setActiveTab('chat')} className={`px-4 py-2 text-sm font-semibold transition border-b-2 rounded-t-lg cursor-pointer ${activeTab === 'chat' ? 'border-blue-600 text-slate-900 dark:text-slate-100 bg-slate-50 dark:bg-slate-800' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}`}>Chat</button>
                <button onClick={() => setActiveTab('info')} className={`px-4 py-2 text-sm font-semibold transition border-b-2 rounded-t-lg cursor-pointer ${activeTab === 'info' ? 'border-blue-600 text-slate-900 dark:text-slate-100 bg-slate-50 dark:bg-slate-800' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}`}>Session Info</button>
                <button onClick={() => setActiveTab('diff')} className={`px-4 py-2 text-sm font-semibold transition border-b-2 rounded-t-lg cursor-pointer ${activeTab === 'diff' ? 'border-blue-600 text-slate-900 dark:text-slate-100 bg-slate-50 dark:bg-slate-800' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}`}>Git</button>
                <button onClick={() => setActiveTab('files')} className={`px-4 py-2 text-sm font-semibold transition border-b-2 rounded-t-lg cursor-pointer ${activeTab === 'files' ? 'border-blue-600 text-slate-900 dark:text-slate-100 bg-slate-50 dark:bg-slate-800' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}`}>Files</button>
                <button onClick={() => setActiveTab('doce')} className={`px-4 py-2 text-sm font-semibold transition border-b-2 rounded-t-lg cursor-pointer ${activeTab === 'doce' ? 'border-blue-600 text-slate-900 dark:text-slate-100 bg-slate-50 dark:bg-slate-800' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}`}>Doce</button>
              </div>
            </>
          )}
        </header>

        {modelsStatusQuery.data?.ok === false && !modelsStatusQuery.isLoading && !modelsStatusQuery.isError ? (
          <div className="px-6 py-4 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900 flex items-center justify-between gap-4 shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0" />
              <div className="min-w-0">
                <div className="text-sm font-bold text-amber-800 dark:text-amber-200">尚未配置可用模型</div>
                <div className="text-xs text-amber-700 dark:text-amber-300">请先添加 Pi 原生平台密钥或自定义模型提供商，配置完成后即可创建项目和使用 Agent。</div>
              </div>
            </div>
            <button
              onClick={handleOpenProviderModal}
              className="px-4 py-2 text-xs font-semibold bg-amber-600 text-white hover:bg-amber-700 rounded-lg shadow-2xs transition cursor-pointer shrink-0 whitespace-nowrap"
            >
              添加模型
            </button>
          </div>
        ) : null}
        <div className="flex-1 overflow-hidden relative">
          {selectedSessionId ? (
            <>
              {activeTab === 'chat' && (
                <TabChat
                  messages={messages}
                  hasMore={hasMoreMessages}
                  loadingMore={loadingMoreMessages}
                  onLoadMore={handleLoadMore}
                  onSend={handleSend}
                  onStop={handleStop}
                  sending={sendMessageMut.isPending}
                  runtimeStatus={runtimeStatus}
                  sessionTitle={sessionInfo?.session.title}
                  selectedSessionId={selectedSessionId}
                  sendShortcutMode={sendShortcutMode}
                  models={modelsQuery.data ?? []}
                  currentModelValue={sessionInfo?.session.current_model ? `${sessionInfo.session.current_model.provider}/${sessionInfo.session.current_model.id}` : ''}
                  currentModelSupportsImages={currentModelSupportsImages}
                  onModelSelect={handleModelSelect}
                  thinkingLevelValue={thinkingLevelQuery.data?.current_level ?? null}
                  thinkingLevelOptions={thinkingLevelQuery.data?.available_levels}
                  onThinkingLevelSelect={(level: string) => {
                    if (selectedSessionId) {
                      setThinkingLevelMut.mutate({ sessionId: selectedSessionId, level });
                    }
                  }}
                  onArchiveSession={handleArchiveSession}
                  archivePending={archiveSessionMut.isPending}
                  showArchiveButton={!isPlannerRoot}
                  onCompactSession={handleCompactSession}
                  compactPending={compactSessionMut.isPending}
                  onSendPlannerRolePrompt={handleSendPlannerRolePrompt}
                  plannerRolePromptPending={plannerRolePromptMut.isPending}
                  showPlannerRolePromptButton={isPlannerRoot && runtimeStatus === 'idle'}
                  isMobile={isMobile}
                />
              )}
              {activeTab === 'info' && (
  <TabSessionInfo
    selectedSessionId={selectedSessionId}
    selectedProjectId={selectedProjectId}
  />
)}
              {activeTab === 'diff' && (
                <TabGitDiff
                  selectedSessionId={selectedSessionId}
                  activeTab={activeTab}
                />
              )}
              {activeTab === 'files' && (
                <TabFiles
                  selectedSessionId={selectedSessionId}
                />
              )}
              {activeTab === 'doce' && (
                <TabFiles
                  selectedSessionId={selectedSessionId}
                  rootPathFilter={['doce', 'docs', 'doc']}
                  panelTitle="Doce"
                  defaultExpanded={true}
                />
              )}
            </>
          ) : (
            <div className="h-full flex flex-col items-center justify-center p-8 bg-slate-50 dark:bg-slate-900/40">
              <div className="text-center space-y-2">
                <h2 className="text-base font-bold text-slate-700 dark:text-slate-300">未选择会话</h2>
                <p className="text-xs text-slate-400 dark:text-slate-500">在侧边栏选择或新建一个会话以开始工作。</p>
              </div>
            </div>
          )}
        </div>
      </div>

      <CreateProjectModal
        isOpen={showCreateProject}
        onClose={() => { setShowCreateProject(false); }}
        onCreated={(projectId, sessionId) => {
          setShowCreateProject(false);
          setSelectedProjectId(projectId);
          setSelectedSessionId(sessionId);
          treeQuery.refetch();
        }}
        modelsQueryData={modelsQuery.data ?? []}
        modelsQueryLoading={modelsQuery.isLoading}
        createProjectMut={createProjectMut}
        setProjectRoleModelsMut={setProjectRoleModelsMut}
      />

      <Modal isOpen={showSettings} onClose={() => setShowSettings(false)} title="设置" icon={<Settings className="w-4 h-4 text-slate-500 dark:text-slate-400" />} maxWidthClassName="max-w-xl">
        {/* Tab bar */}
        <div className="flex border-b border-slate-200 dark:border-slate-700 -mx-1">
          <button onClick={() => setSettingsTab('general')} className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition cursor-pointer ${settingsTab === 'general' ? 'border-blue-600 text-blue-700 dark:text-blue-400' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}`}>常规</button>
          <button onClick={() => setSettingsTab('notifications')} className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition cursor-pointer ${settingsTab === 'notifications' ? 'border-blue-600 text-blue-700 dark:text-blue-400' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}`}>通知</button>
          <button onClick={() => setSettingsTab('models')} className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition cursor-pointer ${settingsTab === 'models' ? 'border-blue-600 text-blue-700 dark:text-blue-400' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}`}>模型</button>
          <button onClick={() => setSettingsTab('packages')} className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition cursor-pointer ${settingsTab === 'packages' ? 'border-blue-600 text-blue-700 dark:text-blue-400' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}`}>包管理</button>
        </div>

        {/* 常规 tab */}
        {settingsTab === 'general' && (
          <div className="space-y-4">
            <div>
              <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">发送快捷键</label>
              <div className="flex gap-2">
                <button onClick={() => setSendShortcutMode('enter')} className={`flex-1 px-3 py-2 text-xs font-semibold rounded-lg border transition cursor-pointer ${sendShortcutMode === 'enter' ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-400' : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'}`}>Enter 发送</button>
                <button onClick={() => setSendShortcutMode('mod_enter')} className={`flex-1 px-3 py-2 text-xs font-semibold rounded-lg border transition cursor-pointer ${sendShortcutMode === 'mod_enter' ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-400' : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'}`}>Ctrl/Cmd+Enter 发送</button>
              </div>
            </div>
            <div>
              <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">主题</label>
              <div className="flex gap-2">
                <button onClick={() => setTheme('light')} className={`flex-1 px-3 py-2 text-xs font-semibold rounded-lg border transition cursor-pointer ${theme === 'light' ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-400' : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'}`}>浅色</button>
                <button onClick={() => setTheme('dark')} className={`flex-1 px-3 py-2 text-xs font-semibold rounded-lg border transition cursor-pointer ${theme === 'dark' ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-400' : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'}`}>深色</button>
              </div>
            </div>
          </div>
        )}

        {/* 通知 tab */}
        {settingsTab === 'notifications' && (
          <div className="space-y-4">
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 p-3 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">系统通知</div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">开启后，Planner、Feature Lead、Bugfix Lead 完成或出错时发送通知。</div>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" className="sr-only peer" checked={systemNotificationsEnabled} onChange={(e) => handleToggleSystemNotifications(e.target.checked)} />
                  <div className="w-9 h-5 bg-slate-300 dark:bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
                </label>
              </div>
              {notificationPermissionStatus === 'denied' && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400">系统通知被浏览器权限拒绝，请在浏览器设置中允许通知后重试。</p>
              )}
              {notificationPermissionStatus === 'default' && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400">通知权限未授予，请在弹窗中选择「允许」以启用系统通知。</p>
              )}
              {notificationPermissionStatus === 'unsupported' && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400">当前环境不支持系统通知（需要 HTTPS 或 localhost）。</p>
              )}
            </div>
          </div>
        )}

        {/* 模型 tab */}
        {settingsTab === 'models' && (
          <div className="space-y-4">
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 p-3 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">模型提供商</div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">支持 openai-completions、anthropic-messages、google-generative-ai、openai-responses</div>
                </div>
                <button onClick={handleOpenProviderModal} className="px-3 py-1.5 text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 rounded-lg shadow-2xs transition cursor-pointer">管理模型提供商</button>
              </div>
            </div>
          </div>
        )}

        {/* 包管理 tab */}
        {settingsTab === 'packages' && (
          <div className="space-y-4">
            <div className="text-[11px] text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900 rounded-lg px-3 py-2">
              Pi 包可能包含可执行扩展代码，请只安装可信来源。
            </div>

            <div>
              <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">安装新包</label>
              <div className="flex gap-2">
                <input
                  value={packageSource}
                  onChange={(e) => setPackageSource(e.target.value)}
                  placeholder="npm:@foo/pi-tools / git:github.com/user/repo"
                  className="flex-1 px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 transition placeholder:text-slate-400"
                />
                <button
                  onClick={async () => {
                    if (!packageSource.trim()) return;
                    setPackageError(null);
                    setPackageSuccess(null);
                    try {
                      await installPkgMut.mutateAsync({ source: packageSource.trim() });
                      setPackageSource('');
                      setPackageSuccess('安装成功');
                    } catch (err) {
                      setPackageError(err instanceof Error ? err.message : '安装失败');
                    }
                  }}
                  disabled={installPkgMut.isPending || !packageSource.trim()}
                  className="px-4 py-2 text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 rounded-lg shadow-2xs transition cursor-pointer disabled:opacity-50 shrink-0"
                >
                  {installPkgMut.isPending ? '安装中…' : '安装'}
                </button>
              </div>
              <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-1">当前为全局安装。项目级安装请前往「项目设置 → 扩展管理」。</p>
            </div>

            {packageError && (
              <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded-lg px-3 py-2">{packageError}</div>
            )}
            {packageSuccess && (
              <div className="text-xs text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-900 rounded-lg px-3 py-2">{packageSuccess}</div>
            )}

            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">已配置包</div>
                <button
                  onClick={() => packagesUpdatesQuery.refetch()}
                  disabled={packagesUpdatesQuery.isFetching}
                  className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw className={`w-3 h-3 ${packagesUpdatesQuery.isFetching ? 'animate-spin' : ''}`} />
                  检查更新
                </button>
              </div>
              <div className="space-y-2">
                {(packagesQuery.data ?? []).length === 0 ? (
                  <div className="text-xs text-slate-400 dark:text-slate-500 text-center py-4">暂无已配置的包</div>
                ) : (
                  (packagesQuery.data ?? []).map((pkg) => (
                    <div key={pkg.source} className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 px-3 py-2">
                      <label className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={!pkg.filtered}
                          onChange={async () => {
                            setPackageError(null);
                            setPackageSuccess(null);
                            try {
                              await togglePkgMut.mutateAsync({ source: pkg.source, filtered: !pkg.filtered });
                            } catch (err) {
                              setPackageError(err instanceof Error ? err.message : '切换失败');
                            }
                          }}
                          disabled={togglePkgMut.isPending}
                          className="w-3.5 h-3.5 rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 shrink-0"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-semibold text-slate-800 dark:text-slate-100 truncate">{pkg.source}</div>
                          <div className="text-[10px] text-slate-400 dark:text-slate-500">
                            {pkg.scope === 'user' ? '全局' : '项目'}
                            {pkg.installedPath ? ` · ${pkg.installedPath}` : ''}
                          </div>
                        </div>
                      </label>
                      <button
                        onClick={async () => {
                          setPackageError(null);
                          setPackageSuccess(null);
                          try {
                            await removePkgMut.mutateAsync({ source: pkg.source });
                            setPackageSuccess(`已移除：${pkg.source}`);
                          } catch (err) {
                            setPackageError(err instanceof Error ? err.message : '移除失败');
                          }
                        }}
                        disabled={removePkgMut.isPending}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 transition cursor-pointer disabled:opacity-50 shrink-0"
                        title="移除"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>

            {packagesUpdatesQuery.data && packagesUpdatesQuery.data.length > 0 && (
              <div>
                <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">可用更新</div>
                <div className="space-y-2">
                  {packagesUpdatesQuery.data.map((update) => (
                    <div key={update.source} className="flex items-center justify-between rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/20 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-semibold text-amber-800 dark:text-amber-200 truncate">{update.displayName}</div>
                        <div className="text-[10px] text-amber-600 dark:text-amber-400">{update.source} · {update.type === 'npm' ? 'npm 包' : 'git 仓库'}</div>
                      </div>
                      <button
                        onClick={async () => {
                          setPackageError(null);
                          setPackageSuccess(null);
                          try {
                            await updatePkgMut.mutateAsync(update.source);
                            setPackageSuccess(`已更新：${update.displayName}`);
                            packagesUpdatesQuery.refetch();
                            packagesQuery.refetch();
                          } catch (err) {
                            setPackageError(err instanceof Error ? err.message : '更新失败');
                          }
                        }}
                        disabled={updatePkgMut.isPending}
                        className="px-3 py-1 text-xs font-semibold bg-amber-600 text-white hover:bg-amber-700 rounded-lg transition cursor-pointer disabled:opacity-50"
                      >
                        更新
                      </button>
                    </div>
                  ))}
                </div>
                <div className="flex justify-end pt-2">
                  <button
                    onClick={async () => {
                      setPackageError(null);
                      setPackageSuccess(null);
                      try {
                        await updatePkgMut.mutateAsync(undefined);
                        setPackageSuccess('所有包已更新');
                        packagesUpdatesQuery.refetch();
                        packagesQuery.refetch();
                      } catch (err) {
                        setPackageError(err instanceof Error ? err.message : '更新失败');
                      }
                    }}
                    disabled={updatePkgMut.isPending}
                    className="px-3 py-1.5 text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 rounded-lg shadow-2xs transition cursor-pointer disabled:opacity-50"
                  >
                    {updatePkgMut.isPending ? '更新中…' : '更新全部'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      <ProjectSettingsModal
        isOpen={showProjectSettings}
        onClose={() => setShowProjectSettings(false)}
        projectId={selectedProjectId}
        modelsQueryData={modelsQuery.data ?? []}
        packagesQueryData={packagesQuery.data ?? []}
        projectPackagesQueryData={projectPackagesQuery.data ?? []}
        projectPackagesUpdatesQueryData={projectPackagesUpdatesQuery.data}
        projectPackagesUpdatesRefetch={projectPackagesUpdatesQuery.refetch}
        projectPackagesRefetch={projectPackagesQuery.refetch}
        installPkgMut={installPkgMut}
        removePkgMut={removePkgMut}
        updatePkgMut={updatePkgMut}
        togglePkgMut={togglePkgMut}
        setProjectRoleModelsMut={setProjectRoleModelsMut}
      />

      <ProviderModal
        isOpen={showProviderModal}
        onClose={() => { setShowProviderModal(false); }}
      />
    </div>
    </WebSocketProvider>
  );
}
