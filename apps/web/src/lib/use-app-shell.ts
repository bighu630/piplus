import { useCallback, useEffect, useMemo, useState, startTransition } from 'react';
import type { Tab } from '../components/TabBar';
import { useWebSocket, useWebSocketConnected } from './ws-provider';
import { findSessionNode } from './tree-utils';
import { useIsMobile } from './use-is-mobile';
import { usePersistentState } from './use-persistent-state';
import { useAppTheme } from './use-app-theme';
import { useSystemNotifications } from './use-system-notifications';
import { useSessionSelection } from './use-session-selection';
import { useSessionActions } from './use-session-actions';
import { computeSessionMessagesRefetchInterval } from './session-messages-refetch';
import { useTitleEditing } from './use-title-editing';
import { useTerminalBridge } from './use-terminal-bridge';
import { useProjectActions } from './use-project-actions';
import {
  SIDEBAR_WIDTH_DEFAULT,
  clampSidebarWidth,
  initialHiddenCompletedRoles,
  parseHiddenCompletedRoles,
  parseShowCompleted,
} from './app-prefs';
import {
  useAuthSession,
  useAuthStatus,
  useCreateProjectMutation,
  useInstallPackageMutation,
  useLoginMutation,
  useLogoutMutation,
  useModels,
  useModelsStatus,
  usePackageUpdates,
  usePackages,
  useRemovePackageMutation,
  useSessionInfo,
  useSessionMessages,
  useSessionThinkingLevel,
  useSetProjectRoleModelsMutation,
  useSettings,
  useTogglePackageMutation,
  useTree,
  useUpdatePackagesMutation,
} from './hooks';

type SendShortcutMode = 'enter' | 'mod_enter';

/**
 * App 的组合根：auth、查询、UI 状态、主题/通知与各专项 hook 都在这里编排，
 * App 组件只负责消费这里返回的成组 props 并渲染布局。
 */
export function useAppShell() {
  // ── auth ────────────────────────────────────────────────────────────
  const authStatusQuery = useAuthStatus();
  const authQuery = useAuthSession();
  const loginMutation = useLoginMutation();
  const logoutMutation = useLogoutMutation();
  const modelsStatusQuery = useModelsStatus();
  const isLoggedIn = authStatusQuery.data?.requiresPassword === false || Boolean(authQuery.data?.ok);

  const handleLogin = useCallback(async (password: string) => {
    try {
      await loginMutation.mutateAsync(password);
      authQuery.refetch();
    } catch {}
  }, [loginMutation, authQuery]);

  const handleLogout = useCallback(() => {
    logoutMutation.mutate();
  }, [logoutMutation]);

  // ── UI 状态 ─────────────────────────────────────────────────────────
  const isMobile = useIsMobile();
  const [activeTab, setActiveTab] = useState<Tab>('chat');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [showProviderModal, setShowProviderModal] = useState(false);
  const [showProjectSettings, setShowProjectSettings] = useState(false);

  const [sidebarWidth, setSidebarWidth] = usePersistentState<number>('pi-sidebar-width', SIDEBAR_WIDTH_DEFAULT, {
    parse: clampSidebarWidth,
  });
  const [showArchived, setShowArchived] = usePersistentState<boolean>('pi-show-archived', false, {
    parse: (raw) => raw === 'true',
  });
  const [showCompleted, setShowCompleted] = usePersistentState<boolean>('pi-show-completed', true, {
    parse: parseShowCompleted,
  });
  const [hideRoleLabels, setHideRoleLabels] = usePersistentState<boolean>('pi-hide-role-labels', false, {
    parse: (raw) => raw === 'true',
  });
  const [sendShortcutMode, setSendShortcutMode] = usePersistentState<SendShortcutMode>('pi-send-shortcut-mode', 'enter', {
    parse: (raw) => (raw === 'mod_enter' ? 'mod_enter' : 'enter'),
  });
  const [hiddenCompletedRoles, setHiddenCompletedRoles] = usePersistentState<string[]>('pi-hidden-completed-roles',
    initialHiddenCompletedRoles,
    {
      parse: parseHiddenCompletedRoles,
      serialize: (roles) => JSON.stringify(roles),
    },
  );

  const { theme, setTheme, resolvedTheme } = useAppTheme();
  const {
    enabled: systemNotificationsEnabled,
    toggle: handleToggleSystemNotifications,
    permissionStatus: notificationPermissionStatus,
  } = useSystemNotifications();

  const toggleShowArchived = useCallback(() => setShowArchived((v) => !v), [setShowArchived]);
  const toggleShowCompleted = useCallback(() => setShowCompleted((v) => !v), [setShowCompleted]);

  // ── 查询 ────────────────────────────────────────────────────────────
  const treeQuery = useTree();
  const tree = treeQuery.data?.projects ?? [];
  const modelsQuery = useModels();
  const settingsQuery = useSettings();
  const visionRelayEnabled = settingsQuery.data?.vision_enabled === 'true'
    && !!settingsQuery.data?.vision_model
    && settingsQuery.data.vision_model.includes('/');
  // 「隐藏对话框时间戳」：默认关闭，仅 'true' 视为开启（设置保存后经 query invalidate 即时生效）
  const hideChatTimestamps = settingsQuery.data?.hide_chat_timestamps === 'true';
  // 「运行中允许插话（steer）」：默认关闭，仅 'true' 视为开启
  const allowRuntimeInjection = settingsQuery.data?.allow_runtime_message_injection === 'true';

  const onSessionSelected = useCallback(() => {
    // 标题编辑的复位不在这里做：切换会话时 useTitleEditing 的 session-change effect 会复位，
    // 而同会话点击必然先触发输入框 blur → handleCancelEditTitle，两者合起来覆盖了原实现。
    setActiveTab('chat');
  }, []);

  const {
    selectedSessionId,
    setSelectedSessionId,
    selectedProjectId,
    setSelectedProjectId,
    showMobileSidebar,
    setShowMobileSidebar,
    isSidebarVisible,
    isContentVisible,
    handleSelectSession,
    handleNavigateToSession,
  } = useSessionSelection({ tree, isMobile, activeTab, onSessionSelected });

  const sessionInfo = useSessionInfo(selectedSessionId).data;
  const thinkingLevelQuery = useSessionThinkingLevel(selectedSessionId);
  const { localRuntimeStatusBySession } = useWebSocket();
  const wsConnected = useWebSocketConnected();

  const currentSessionNode = selectedSessionId ? findSessionNode(tree, selectedSessionId) : null;
  // localRuntimeStatusBySession is updated immediately from WS runtime_status_changed events,
  // before async query refetches complete. This prevents stale query data from
  // keeping the UI stuck in 'running' after the session has actually ended.
  const runtimeStatus = selectedSessionId
    ? (localRuntimeStatusBySession[selectedSessionId] ?? currentSessionNode?.runtime_status ?? sessionInfo?.session.runtime_status ?? 'idle')
    : 'idle';

  // WS 已连接时不做轮询：流式内容由 useChatStream 驱动；落库消息由 WS 事件 invalidate
  // （chat_stream complete 按逐条 assistant 消息触发；runtime idle 再兜一次）+ 窗口聚焦/重连触发重拉。
  // 仅在 running 且 WS 断开时保留 5s 兜底，避免断线期间 UI 卡在运行中。
  const messagesQuery = useSessionMessages(
    activeTab === 'chat' ? selectedSessionId : null,
    20,
    computeSessionMessagesRefetchInterval(runtimeStatus, wsConnected),
  );
  const messages = useMemo(
    () => messagesQuery.data?.pages.flatMap((p) => p.messages).sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) ?? [],
    [messagesQuery.data],
  );

  const [currentModelSupportsImages, setCurrentModelSupportsImages] = useState<boolean | null>(null);
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

  // ── 项目级查询 / mutation ───────────────────────────────────────────
  const createProjectMut = useCreateProjectMutation();
  const setProjectRoleModelsMut = useSetProjectRoleModelsMutation();
  const projectPackagesQuery = usePackages(showProjectSettings ? selectedProjectId : null);
  const projectPackagesUpdatesQuery = usePackageUpdates(showProjectSettings ? selectedProjectId : null);
  const installPkgMut = useInstallPackageMutation();
  const removePkgMut = useRemovePackageMutation();
  const updatePkgMut = useUpdatePackagesMutation();
  const togglePkgMut = useTogglePackageMutation();

  // ── 专项 hook 组合 ──────────────────────────────────────────────────
  const sessionActions = useSessionActions({
    selectedSessionId,
    selectedProjectId,
    setSelectedSessionId,
    tree,
    treeQuery,
    messagesQuery,
    onSelectSession: handleSelectSession,
  });
  const title = useTitleEditing({ selectedSessionId, sessionInfo });
  const { terminalRef, handleTerminalMessage } = useTerminalBridge(selectedSessionId);
  const { handleArchiveProject, handleDeleteProject, handleToggleProjectPinned, handleOpenProjectSettings } = useProjectActions({
    treeQuery,
    setSelectedProjectId,
    setShowProjectSettings,
  });

  const openProviderModal = useCallback(() => {
    setShowSettings(false);
    setShowProviderModal(true);
  }, []);

  const onProjectCreated = useCallback((projectId: string, sessionId: string) => {
    setShowCreateProject(false);
    setSelectedProjectId(projectId);
    setSelectedSessionId(sessionId);
    treeQuery.refetch();
  }, [setSelectedProjectId, setSelectedSessionId, treeQuery]);

  const isPlannerRoot = sessionInfo?.role_template.key === 'planner' && sessionInfo.lineage.depth === 0;
  const modelsNotConfigured = modelsStatusQuery.data?.ok === false
    && !modelsStatusQuery.isLoading
    && !modelsStatusQuery.isError;

  // ── 成组 props（App 直接展开，避免把 25+ 个 prop 的接线堆在 JSX 里） ──
  const sidebar = {
    projects: tree,
    activeSessionId: selectedSessionId,
    isSidebarCollapsed: sidebarCollapsed,
    sidebarWidth,
    onWidthChange: setSidebarWidth,
    onSelectSession: handleSelectSession,
    onSelectProject: setSelectedProjectId,
    onToggleSidebar: () => setSidebarCollapsed(!sidebarCollapsed),
    onCreateProject: () => setShowCreateProject(true),
    onCreateSession: sessionActions.handleCreateSession,
    onArchiveProject: handleArchiveProject,
    onToggleProjectPinned: handleToggleProjectPinned,
    onToggleSessionPinned: sessionActions.handleToggleSessionPinned,
    onArchiveSession: sessionActions.handleArchiveSession,
    onDeleteProject: handleDeleteProject,
    onLogout: handleLogout,
    onOpenSettings: () => startTransition(() => setShowSettings(true)),
    onOpenProjectSettings: handleOpenProjectSettings,
    showArchived,
    onToggleShowArchived: toggleShowArchived,
    showCompleted,
    onToggleShowCompleted: toggleShowCompleted,
    hiddenCompletedRoles,
    treeLoading: treeQuery.isLoading,
    creatingSession: sessionActions.creatingSession,
    isMobile,
    isMobileVisible: showMobileSidebar,
    onReturnToTree: () => setShowMobileSidebar(true),
    hideRoleLabels,
  };

  const header = {
    hasSession: Boolean(sessionInfo),
    title: sessionInfo?.session.title ?? '',
    isPlannerRoot,
    editing: title.editingTitle,
    editValue: title.editTitleValue,
    onEditValueChange: title.setEditTitleValue,
    onStartEdit: title.handleStartEditTitle,
    onCancel: title.handleCancelEditTitle,
    onKeyDown: title.handleTitleKeyDown,
    inputRef: title.titleInputRef,
    isMobile,
    activeTab,
    onSelectTab: setActiveTab,
    onOpenSidebar: () => setShowMobileSidebar(true),
  };

  const currentModel = sessionInfo?.session.current_model;
  const tabChat = {
    messages,
    hasMore: Boolean(messagesQuery.hasNextPage),
    loadingMore: messagesQuery.isFetchingNextPage,
    onLoadMore: sessionActions.handleLoadMore,
    onSend: sessionActions.handleSend,
    onStop: sessionActions.handleStop,
    sending: sessionActions.sending,
    runtimeStatus,
    selectedSessionId,
    sendShortcutMode,
    models: modelsQuery.data ?? [],
    currentModelValue: currentModel ? `${currentModel.provider}/${currentModel.id}` : '',
    currentModelSupportsImages,
    visionRelayEnabled,
    onModelSelect: sessionActions.handleModelSelect,
    thinkingLevelValue: thinkingLevelQuery.data?.current_level ?? null,
    thinkingLevelOptions: thinkingLevelQuery.data?.available_levels,
    onThinkingLevelSelect: sessionActions.handleThinkingLevelSelect,
    onArchiveSession: sessionActions.handleArchiveSession,
    archivePending: sessionActions.archivePending,
    showArchiveButton: !isPlannerRoot,
    onCompactSession: sessionActions.handleCompactSession,
    compactPending: sessionActions.compactPending,
    onSendPlannerRolePrompt: sessionActions.handleSendPlannerRolePrompt,
    plannerRolePromptPending: sessionActions.plannerRolePromptPending,
    showPlannerRolePromptButton: isPlannerRoot && runtimeStatus === 'idle',
    isMobile,
    hideChatTimestamps,
    allowRuntimeInjection,
  };

  const modals = {
    showCreateProject,
    onCloseCreateProject: () => setShowCreateProject(false),
    onProjectCreated,
    modelsData: modelsQuery.data ?? [],
    modelsLoading: modelsQuery.isLoading,
    createProjectMut,
    setProjectRoleModelsMut,
    showSettings,
    onCloseSettings: () => setShowSettings(false),
    sendShortcutMode,
    onSendShortcutModeChange: setSendShortcutMode,
    theme,
    onThemeChange: setTheme,
    systemNotificationsEnabled,
    onToggleSystemNotifications: handleToggleSystemNotifications,
    notificationPermissionStatus: notificationPermissionStatus ?? '',
    onOpenProviderModal: openProviderModal,
    installPkgMut,
    togglePkgMut,
    removePkgMut,
    updatePkgMut,
    hideRoleLabels,
    onHideRoleLabelsChange: setHideRoleLabels,
    hiddenCompletedRoles,
    onHiddenCompletedRolesChange: setHiddenCompletedRoles,
    showProjectSettings,
    onCloseProjectSettings: () => setShowProjectSettings(false),
    projectId: selectedProjectId,
    projectPackagesQueryData: projectPackagesQuery.data ?? [],
    projectPackagesUpdatesQueryData: projectPackagesUpdatesQuery.data,
    projectPackagesUpdatesRefetch: projectPackagesUpdatesQuery.refetch,
    projectPackagesRefetch: projectPackagesQuery.refetch,
    showProviderModal,
    onCloseProviderModal: () => setShowProviderModal(false),
  };

  return {
    authStatusQuery,
    isLoggedIn,
    loginMutation,
    modelsStatusQuery,
    handleLogin,
    handleLogout,
    isMobile,
    selectedSessionId,
    selectedProjectId,
    activeTab,
    isSidebarVisible,
    isContentVisible,
    resolvedTheme,
    wsConnected,
    isPlannerRoot,
    modelsNotConfigured,
    openProviderModal,
    handleNavigateToSession,
    terminalRef,
    handleTerminalMessage,
    sidebar,
    header,
    tabChat,
    modals,
  };
}
