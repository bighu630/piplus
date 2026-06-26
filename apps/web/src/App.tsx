import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ProjectDTO, SessionTreeNodeDTO, ChatMessageDTO, ChatImageContentBlockDTO, ServerMessage } from '@piplus/shared';
import type { ProviderFormPayload, SessionMessageImageAttachment } from './lib/api';
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
  useCompactSessionMutation,
  useLoginMutation,
  useLogoutMutation,
  useModelsStatus,
  useModels,
  useSetSessionModelMutation,
  useArchiveProjectMutation,
  useDeleteProjectMutation,
  useGitPullMutation,
  useGitPushMutation,
  useGitCommitMutation,
  useAddGitignoreMutation,
  useGitBranches,
  useGitCheckoutMutation,
  useTestModelProviderMutation,
  useCreateModelProviderMutation,
  useUpdateSessionTitleMutation,
  useProjectRoleModels,
  useSetProjectRoleModelsMutation,
} from './lib/hooks';
import {
  Settings,
  ChevronDown,
  PlusCircle,
  Database,
  Trash2,
  Pencil,
  PanelLeft,
} from 'lucide-react';

type Tab = 'chat' | 'info' | 'diff' | 'files';
type SendShortcutMode = 'enter' | 'mod_enter';
type ProviderModelForm = ProviderFormPayload['models'][number];

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

function createEmptyProviderModel(): ProviderModelForm {
  return {
    id: '',
    name: '',
    reasoning: false,
    inputImage: false,
    input: undefined,
    api: '',
    contextWindow: undefined,
    maxTokens: undefined,
    cost: undefined,
    compat: '',
    thinkingLevelMap: '',
  };
}

const ROLE_CONFIG_KEYS = [
  { key: 'planner', label: '负责人' },
  { key: 'worker', label: '执行者' },
  { key: 'reviewer', label: '审查者' },
  { key: 'feature_lead', label: '需求负责人' },
  { key: 'bugfix_lead', label: 'Bug负责人' },
  { key: 'blank', label: '空白' },
];

const CONFIGURABLE_ROLE_KEYS = ROLE_CONFIG_KEYS.filter((r) => r.key !== 'planner');

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

  const [createName, setCreateName] = useState('');
  const [createMode, setCreateMode] = useState<'existing' | 'git_clone'>('existing');
  const [createPath, setCreatePath] = useState('');
  const [createRepoUrl, setCreateRepoUrl] = useState('');
  const [createProjectModelKey, setCreateProjectModelKey] = useState('');
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [editRoleModels, setEditRoleModels] = useState<Record<string, string>>({});
  const [roleDefaultModels, setRoleDefaultModels] = useState<Record<string, { provider: string; id: string } | null>>({});

  const [providerKey, setProviderKey] = useState('');
  const [providerBaseUrl, setProviderBaseUrl] = useState('');
  const [providerApiKey, setProviderApiKey] = useState('');
  const [providerAuthHeader, setProviderAuthHeader] = useState(true);
  const [supportsDeveloperRole, setSupportsDeveloperRole] = useState(false);
  const [supportsReasoningEffort, setSupportsReasoningEffort] = useState(false);
  const [providerApi, setProviderApi] = useState('');
  const [providerHeaders, setProviderHeaders] = useState('');
  const [providerCompatJson, setProviderCompatJson] = useState('');
  const [providerModels, setProviderModels] = useState<ProviderModelForm[]>([createEmptyProviderModel()]);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [providerTestResult, setProviderTestResult] = useState<string | null>(null);
  const [providerTestModels, setProviderTestModels] = useState<Array<{ id: string; name?: string }>>([]);

  const [streamNote, setStreamNote] = useState('');
  const [streamingContent, setStreamingContent] = useState('');
  const [pendingUserMessages, setPendingUserMessages] = useState<ChatMessageDTO[]>([]);
  const [currentModelSupportsImages, setCurrentModelSupportsImages] = useState<boolean | null>(null);
  const [runtimeErrors, setRuntimeErrors] = useState<Array<{runId: string; error: string}>>([]);
  const [wsConnected, setWsConnected] = useState(false);

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
    if (Number.isFinite(sidebarWidth)) {
      try { localStorage.setItem('pi-sidebar-width', String(sidebarWidth)); } catch {}
    }
  }, [sidebarWidth]);

  const queryClient = useQueryClient();
  const treeQuery = useTree();
  const refetchTree = treeQuery.refetch;
  const tree = treeQuery.data?.projects ?? [];
  const sessionInfoQuery = useSessionInfo(selectedSessionId);
  const sessionInfo = sessionInfoQuery.data;
  const gitDiffQuery = useSessionGitDiff(activeTab === 'diff' ? selectedSessionId : null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const fileTreeQuery = useSessionFileTree(activeTab === 'files' ? selectedSessionId : null);
  const fileContentQuery = useSessionFileContent(activeTab === 'files' ? selectedSessionId : null, activeTab === 'files' ? selectedFilePath : null);
  const modelsQuery = useModels();
  const setModelMut = useSetSessionModelMutation();
  const testProviderMut = useTestModelProviderMutation();
  const createProviderMut = useCreateModelProviderMutation();
  const setProjectRoleModelsMut = useSetProjectRoleModelsMutation();
  const projectRoleModelsQuery = useProjectRoleModels(showProjectSettings ? selectedProjectId : null);

  const createProjectMut = useCreateProjectMutation();
  const createSessionMut = useCreateSessionMutation();
  const sendMessageMut = useSendMessageMutation(selectedSessionId);
  const stopSessionMut = useStopSessionMutation();
  const archiveSessionMut = useArchiveSessionMutation();
  const compactSessionMut = useCompactSessionMutation();
  const archiveProjectMut = useArchiveProjectMutation();
  const deleteProjectMut = useDeleteProjectMutation();
  const currentSessionNode = selectedSessionId ? findSessionNode(tree, selectedSessionId) : null;
  const runtimeStatus = currentSessionNode?.runtime_status ?? sessionInfo?.session.runtime_status ?? 'idle';
  const messagesQuery = useSessionMessages(activeTab === 'chat' ? selectedSessionId : null, 20, runtimeStatus === 'running' ? 1500 : false);
  const messages = messagesQuery.data?.pages.flatMap((p) => p.messages).sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) ?? [];
  const hasMoreMessages = Boolean(messagesQuery.hasNextPage);
  const loadingMoreMessages = messagesQuery.isFetchingNextPage;

  useEffect(() => {
    setPendingUserMessages([]);
    setStreamingContent('');
    setStreamNote('');
    setRuntimeErrors([]);
    setSelectedFilePath(null);
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
  const selectedProjectIdRef = useRef(selectedProjectId);
  selectedProjectIdRef.current = selectedProjectId;
  const socketRef = useRef<ReturnType<typeof createWorkspaceSocket> | null>(null);

  useEffect(() => {
    if (!selectedSessionId) return;
    const socket = createWorkspaceSocket({
      onMessage(event) {
        try {
          const message = JSON.parse(event.data as string) as ServerMessage;
          if (message.kind === 'chat_stream' && message.scope?.session_id === selectedSessionId) {
            if (activeTabRef.current === 'chat') {
              const delta = message.payload?.delta ?? '';
              setStreamNote(`${message.phase}${delta ? ' · streaming' : ''}`);
              if (message.phase === 'start') {
                setStreamingContent('');
                setRuntimeErrors([]);  // clear old error
              }
              else if (message.phase === 'delta') setStreamingContent((prev) => prev + delta);
            }
            if (message.phase === 'complete') {
              setStreamingContent('');
              setStreamNote('');
              setPendingUserMessages([]);
              Promise.all([
                queryClient.invalidateQueries({ queryKey: ['session', 'messages', selectedSessionId] }),
                queryClient.invalidateQueries({ queryKey: ['tree'] }),
                queryClient.invalidateQueries({ queryKey: ['session', 'info', selectedSessionId] }),
                queryClient.invalidateQueries({ queryKey: ['session', 'context-usage', selectedSessionId] }),
              ]);
            }
            if (message.phase === 'error') {
              const errorText = message.payload?.error ?? 'Unknown agent loop error';
              setRuntimeErrors([{ runId: message.payload?.stream_id ?? 'unknown', error: errorText }]);
              setStreamingContent('');
            }
          }
          if (message.kind === 'event' && message.type === 'session.runtime_status_changed') {
            treeQuery.refetch();
            const status = message.payload?.runtime_status;
            if (status === 'running') {
              // Refetch messages immediately so tool_call entries appear promptly
              queryClient.invalidateQueries({ queryKey: ['session', 'messages', selectedSessionId] });
            }
            if (status === 'idle') {
              setStreamingContent('');
              setStreamNote('');
              setPendingUserMessages([]);
              const idleError = message.payload?.error;
              if (idleError && typeof idleError === 'string' && idleError) {
                setRuntimeErrors([{ runId: 'runtime-status', error: idleError }]);
              }
              Promise.all([
                queryClient.invalidateQueries({ queryKey: ['session', 'info', selectedSessionId] }),
                queryClient.invalidateQueries({ queryKey: ['session', 'messages', selectedSessionId] }),
                queryClient.invalidateQueries({ queryKey: ['tree'] }),
              ]);
            }
          }
          if (message.kind === 'event' && (message.type === 'tree.changed' || message.type === 'project.created' || message.type === 'session.created' || message.type === 'session.archived')) {
            treeQuery.refetch();
          }
          if (message.kind === 'event' && (message.type === 'session.compaction_end' || message.type === 'session.compacted')) {
            const eventSessionId = (message.payload as Record<string, unknown>)?.session_id ?? selectedSessionId;
            if (typeof eventSessionId === 'string' && eventSessionId) {
              queryClient.invalidateQueries({ queryKey: ['session', 'context-usage', eventSessionId] });
            }
          }
        } catch {}
      },
      onOpen() {
        setWsConnected(true);
        socket.hello();
        socket.setContext({
          project_id: selectedProjectIdRef.current ?? undefined,
          session_id: selectedSessionId,
          current_tab: activeTabRef.current === 'info' ? 'session_info' : activeTabRef.current === 'diff' ? 'git_diff' : activeTabRef.current === 'files' ? 'files' : 'chat',
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
  }, [selectedSessionId, queryClient, refetchTree]);

  useEffect(() => {
    if (!socketRef.current || !selectedSessionId) return;
    socketRef.current.setContext({
      project_id: selectedProjectId ?? undefined,
      session_id: selectedSessionId,
      current_tab: activeTab === 'info' ? 'session_info' : activeTab === 'diff' ? 'git_diff' : activeTab === 'files' ? 'files' : 'chat',
    });
  }, [activeTab, selectedProjectId, selectedSessionId]);

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

  const handleCreateProject = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createName.trim()) return;
    try {
      const result = await createProjectMut.mutateAsync({
        name: createName.trim(),
        mode: createMode,
        path: createMode === 'existing' ? createPath : undefined,
        repoUrl: createMode === 'git_clone' ? createRepoUrl : undefined,
        model: createProjectModelKey ? (() => {
          const [provider, id] = createProjectModelKey.split('/');
          return provider && id ? { provider, id, label: createProjectModelKey } : null;
        })() : null,
      });
      // Save role default models after project creation
      if (Object.keys(roleDefaultModels).length > 0) {
        try {
          await setProjectRoleModelsMut.mutateAsync({ projectId: result.projectId, models: roleDefaultModels });
        } catch { /* non-critical */ }
      }
      setShowCreateProject(false);
      setCreateName('');
      setCreatePath('');
      setCreateRepoUrl('');
      setCreateProjectModelKey('');
      setRoleDefaultModels({});
      if (result.sessionId) {
        setSelectedProjectId(result.projectId);
        setSelectedSessionId(result.sessionId);
      }
      await treeQuery.refetch();
    } catch {}
  }, [createName, createMode, createPath, createRepoUrl, createProjectModelKey, createProjectMut, treeQuery, roleDefaultModels, setProjectRoleModelsMut]);

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
    setRuntimeErrors([]);
    const optimisticId = `optimistic_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const imageBlocks: ChatImageContentBlockDTO[] = attachments.map((attachment) => ({
      type: 'image',
      mime_type: attachment.mime_type,
      media_type: attachment.mime_type,
      filename: attachment.filename ?? null,
      uri: null,
      data_base64: attachment.data_base64,
    }));
    const optimisticMessage: ChatMessageDTO = {
      id: optimisticId,
      role: 'user',
      message_kind: 'normal',
      source_session_id: null,
      content_text: content,
      content_blocks: [
        ...(content ? [{ type: 'text' as const, text: content }] : []),
        ...imageBlocks,
      ],
      created_at: new Date().toISOString(),
    };
    setPendingUserMessages((prev) => [...prev, optimisticMessage]);
    try {
      await sendMessageMut.mutateAsync({ content, attachments });
      queryClient.invalidateQueries({ queryKey: ['session', 'messages', selectedSessionId] });
    } catch (error) {
      setPendingUserMessages((prev) => prev.filter((message) => message.id !== optimisticId));
      throw error;
    }
  }, [selectedSessionId, sendMessageMut, queryClient]);

  const handleStop = useCallback(async () => {
    if (!selectedSessionId) return;
    setStreamNote('stopping');
    try {
      await stopSessionMut.mutateAsync(selectedSessionId);
    } catch {
      setStreamNote('');
      throw new Error('stop_session_failed');
    }
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
  }, [selectedSessionId, setModelMut, queryClient]);

  const handleRefreshDiff = useCallback(() => {
    if (!selectedSessionId) return;
    queryClient.invalidateQueries({ queryKey: ['session', 'git-diff', selectedSessionId] });
  }, [selectedSessionId, queryClient]);

  const gitPullMut = useGitPullMutation();
  const gitPushMut = useGitPushMutation();
  const gitCommitMut = useGitCommitMutation();
  const addGitignoreMut = useAddGitignoreMutation();
  const gitBranchesQuery = useGitBranches(activeTab === 'diff' ? selectedSessionId : null);
  const gitCheckoutMut = useGitCheckoutMutation();
  const updateTitleMut = useUpdateSessionTitleMutation();

  const resetProviderForm = useCallback(() => {
    setProviderKey('');
    setProviderBaseUrl('');
    setProviderApiKey('');
    setProviderAuthHeader(true);
    setSupportsDeveloperRole(false);
    setSupportsReasoningEffort(false);
    setProviderApi('');
    setProviderHeaders('');
    setProviderCompatJson('');
    setProviderModels([createEmptyProviderModel()]);
    setProviderError(null);
    setProviderTestResult(null);
    setProviderTestModels([]);
  }, []);

  const handleOpenProviderModal = useCallback(() => {
    setShowSettings(false);
    resetProviderForm();
    setShowProviderModal(true);
  }, [resetProviderForm]);

  const handleCloseProviderModal = useCallback(() => {
    setShowProviderModal(false);
    setProviderError(null);
  }, []);

  const updateProviderModel = useCallback((index: number, patch: Partial<ProviderModelForm>) => {
    setProviderModels((current) => current.map((model, modelIndex) => modelIndex === index ? { ...model, ...patch } : model));
  }, []);

  const handleAddProviderModel = useCallback(() => {
    setProviderModels((current) => [...current, createEmptyProviderModel()]);
  }, []);

  const handleRemoveProviderModel = useCallback((index: number) => {
    setProviderModels((current) => current.length === 1 ? current : current.filter((_, modelIndex) => modelIndex !== index));
  }, []);

  const buildProviderPayload = useCallback((): ProviderFormPayload => {
    // Parse compat JSON: merge explicit checkboxes with extra compat fields
    const compatObj: Record<string, unknown> = {
      supportsDeveloperRole,
      supportsReasoningEffort,
    };
    if (providerCompatJson.trim()) {
      try {
        const extra = JSON.parse(providerCompatJson.trim());
        Object.assign(compatObj, extra);
      } catch { /* invalid JSON, skip */ }
    }

    // Parse headers JSON
    let headersObj: Record<string, string> | undefined;
    if (providerHeaders.trim()) {
      try {
        headersObj = JSON.parse(providerHeaders.trim());
      } catch { /* invalid JSON, skip */ }
    }

    return {
      providerKey: providerKey.trim(),
      baseUrl: providerBaseUrl.trim(),
      apiKey: providerApiKey,
      authHeader: providerAuthHeader,
      api: providerApi.trim() || undefined,
      headers: headersObj,
      compat: Object.keys(compatObj).length > 0 ? compatObj : undefined,
      models: providerModels.map((model) => ({
        id: model.id.trim(),
        name: model.name?.trim() || undefined,
        reasoning: Boolean(model.reasoning),
        inputImage: Boolean(model.inputImage),
        input: model.input,
        api: model.api?.trim() || undefined,
        contextWindow: model.contextWindow ? Number(model.contextWindow) : undefined,
        maxTokens: model.maxTokens ? Number(model.maxTokens) : undefined,
        cost: model.cost
          ? {
              ...(model.cost.input !== undefined && !Number.isNaN(Number(model.cost.input)) ? { input: Number(model.cost.input) } : {}),
              ...(model.cost.output !== undefined && !Number.isNaN(Number(model.cost.output)) ? { output: Number(model.cost.output) } : {}),
              ...(model.cost.cacheRead !== undefined && !Number.isNaN(Number(model.cost.cacheRead)) ? { cacheRead: Number(model.cost.cacheRead) } : {}),
              ...(model.cost.cacheWrite !== undefined && !Number.isNaN(Number(model.cost.cacheWrite)) ? { cacheWrite: Number(model.cost.cacheWrite) } : {}),
            }
          : undefined,
        compat: model.compat?.trim()
          ? (() => { try { const p = JSON.parse(model.compat!.trim()); return p; } catch { return undefined; } })()
          : undefined,
        thinkingLevelMap: model.thinkingLevelMap?.trim()
          ? (() => { try { const p = JSON.parse(model.thinkingLevelMap!.trim()); return p; } catch { return undefined; } })()
          : undefined,
      })),
    };
  }, [providerKey, providerBaseUrl, providerApiKey, providerAuthHeader, supportsDeveloperRole, supportsReasoningEffort, providerApi, providerHeaders, providerCompatJson, providerModels]);

  const validateProviderPayload = useCallback((payload: ProviderFormPayload) => {
    if (!payload.providerKey) return '请填写 providerKey';
    if (!payload.baseUrl) return '请填写 baseUrl';
    if (payload.models.length === 0) return '请至少添加一个模型';
    if (payload.models.some((model) => !model.id)) return '请填写所有模型的 id';
    return null;
  }, []);

  const handleTestProvider = useCallback(async () => {
    const payload = buildProviderPayload();
    const error = validateProviderPayload(payload);
    if (error) {
      setProviderError(error);
      return;
    }
    setProviderError(null);
    setProviderTestResult(null);
    setProviderTestModels([]);
    try {
      const result = await testProviderMut.mutateAsync({
        providerKey: payload.providerKey,
        baseUrl: payload.baseUrl,
        apiKey: payload.apiKey,
        authHeader: payload.authHeader,
      });
      if (!result.ok) {
        setProviderError(result.error ?? '测试连接失败');
        return;
      }
      setProviderTestModels(result.models ?? []);
      setProviderTestResult(result.models && result.models.length > 0 ? `测试成功，发现 ${result.models.length} 个模型` : '测试成功');
    } catch (error) {
      setProviderError(error instanceof Error ? error.message : '测试连接失败');
    }
  }, [buildProviderPayload, validateProviderPayload, testProviderMut]);

  const handleSaveProvider = useCallback(async () => {
    const payload = buildProviderPayload();
    const error = validateProviderPayload(payload);
    if (error) {
      setProviderError(error);
      return;
    }
    setProviderError(null);
    try {
      await createProviderMut.mutateAsync(payload);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['models'] }),
        queryClient.invalidateQueries({ queryKey: ['models', 'status'] }),
      ]);
      setShowProviderModal(false);
    } catch (saveError) {
      setProviderError(saveError instanceof Error ? saveError.message : '保存失败');
    }
  }, [buildProviderPayload, validateProviderPayload, createProviderMut, queryClient]);

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

  // Populate editRoleModels when the project settings modal opens and data arrives
  useEffect(() => {
    if (showProjectSettings && projectRoleModelsQuery.data) {
      const initial: Record<string, string> = {};
      for (const role of ROLE_CONFIG_KEYS) {
        const model = projectRoleModelsQuery.data[role.key];
        initial[role.key] = model ? `${model.provider}/${model.id}` : '';
      }
      setEditRoleModels(initial);
    }
  }, [showProjectSettings, projectRoleModelsQuery.data]);

  const handleOpenProjectSettings = useCallback((projectId: string) => {
    setSelectedProjectId(projectId);
    setShowProjectSettings(true);
  }, []);

  const handleRoleModelChange = useCallback((roleKey: string, value: string) => {
    setEditRoleModels((prev) => ({ ...prev, [roleKey]: value }));
  }, []);

  const handleSaveProjectRoleModels = useCallback(async () => {
    if (!selectedProjectId) return;
    const models: Record<string, { provider: string; id: string } | null> = {};
    for (const [roleKey, value] of Object.entries(editRoleModels)) {
      if (value) {
        const [provider, id] = value.split('/');
        if (provider && id) models[roleKey] = { provider, id };
      } else {
        models[roleKey] = null;
      }
    }
    await setProjectRoleModelsMut.mutateAsync({ projectId: selectedProjectId, models });
    setShowProjectSettings(false);
  }, [selectedProjectId, editRoleModels, setProjectRoleModelsMut]);

  // Also set roleDefaultModels when creating a project
  const handleCreateProjectRoleModelChange = useCallback((roleKey: string, value: string) => {
    setRoleDefaultModels((prev) => {
      if (!value) {
        const next = { ...prev };
        delete next[roleKey];
        return next;
      }
      const [provider, id] = value.split('/');
      if (provider && id) {
        return { ...prev, [roleKey]: { provider, id } };
      }
      return prev;
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
          onArchiveSession={handleArchiveSession}
          onDeleteProject={handleDeleteProject}
          onLogout={handleLogout}
          onOpenSettings={() => setShowSettings(true)}
          onOpenProjectSettings={handleOpenProjectSettings}
          showArchived={showArchived}
          onToggleShowArchived={() => {
            setShowArchived((v) => {
              const next = !v;
              try { localStorage.setItem('pi-show-archived', String(next)); } catch {}
              return next;
            });
          }}
          showWorker={showWorker}
          onToggleShowWorker={() => {
            setShowWorker((v) => {
              const next = !v;
              try { localStorage.setItem('pi-show-worker', String(next)); } catch {}
              return next;
            });
          }}
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
              </div>
            </>
          )}
        </header>

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
                  runtimeErrors={runtimeErrors}
                  sessionTitle={sessionInfo?.session.title}
                  wsConnected={wsConnected}
                  selectedSessionId={selectedSessionId}
                  sendShortcutMode={sendShortcutMode}
                  models={modelsQuery.data ?? []}
                  currentModelValue={sessionInfo?.session.current_model ? `${sessionInfo.session.current_model.provider}/${sessionInfo.session.current_model.id}` : ''}
                  currentModelSupportsImages={currentModelSupportsImages}
                  onModelSelect={handleModelSelect}
                  onArchiveSession={handleArchiveSession}
                  archivePending={archiveSessionMut.isPending}
                  showArchiveButton={!isPlannerRoot}
                  onCompactSession={handleCompactSession}
                  compactPending={compactSessionMut.isPending}
                />
              )}
              {activeTab === 'info' && <TabSessionInfo sessionInfo={sessionInfo ?? null} isLoading={sessionInfoQuery.isLoading} />}
              {activeTab === 'diff' && (
                <TabGitDiff
                  diff={gitDiffQuery.data?.diff ?? null}
                  isLoading={gitDiffQuery.isLoading}
                  onRefresh={handleRefreshDiff}
                  onPull={() => gitPullMut.mutateAsync(selectedSessionId)}
                  onPush={() => gitPushMut.mutateAsync(selectedSessionId)}
                  onCommit={(message) => gitCommitMut.mutateAsync({ sessionId: selectedSessionId, message })}
                  isPulling={gitPullMut.isPending}
                  isPushing={gitPushMut.isPending}
                  isCommitting={gitCommitMut.isPending}
                  onAddGitignore={(filePath) => addGitignoreMut.mutateAsync({ sessionId: selectedSessionId, path: filePath })}
                  isAddingGitignore={addGitignoreMut.isPending}
                  currentBranch={gitBranchesQuery.data?.current_branch ?? null}
                  branches={gitBranchesQuery.data?.branches ?? null}
                  onCheckout={(branch) => gitCheckoutMut.mutateAsync({ sessionId: selectedSessionId, branch })}
                  isCheckingOut={gitCheckoutMut.isPending}
                  cwd={gitDiffQuery.data?.cwd ?? gitBranchesQuery.data?.cwd ?? null}
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
                  onRefresh={() => { void fileTreeQuery.refetch(); }}
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

      <Modal isOpen={showCreateProject} onClose={() => { setShowCreateProject(false); setRoleDefaultModels({}); }} title="新建项目" icon={<PlusCircle className="w-4 h-4 text-blue-600 dark:text-blue-400" />}>
        <form onSubmit={handleCreateProject} className="space-y-4">
          <div>
            <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">项目名称 <span className="text-red-500">*</span></label>
            <input required autoFocus type="text" placeholder="请输入项目名称..." value={createName} onChange={(e) => setCreateName(e.target.value)} className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 transition placeholder:text-slate-400" />
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">模式</label>
            <div className="flex gap-2">
              <button type="button" onClick={() => setCreateMode('existing')} className={`flex-1 px-3 py-2 text-xs font-semibold rounded-lg border transition cursor-pointer ${createMode === 'existing' ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-400' : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'}`}>绑定目录</button>
              <button type="button" onClick={() => setCreateMode('git_clone')} className={`flex-1 px-3 py-2 text-xs font-semibold rounded-lg border transition cursor-pointer ${createMode === 'git_clone' ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-400' : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'}`}>Git Clone</button>
            </div>
          </div>
          {createMode === 'existing' ? (
            <div>
              <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">项目路径 <span className="text-red-500">*</span></label>
              <input required type="text" placeholder="/path/to/project" value={createPath} onChange={(e) => setCreatePath(e.target.value)} className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 transition placeholder:text-slate-400" />
            </div>
          ) : (
            <div>
              <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">Git 仓库地址 <span className="text-red-500">*</span></label>
              <input required type="url" placeholder="https://github.com/user/repo" value={createRepoUrl} onChange={(e) => setCreateRepoUrl(e.target.value)} className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 transition placeholder:text-slate-400" />
            </div>
          )}
          <div>
            <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">负责人模型</label>
            <div className="relative">
              <select value={createProjectModelKey} onChange={(e) => setCreateProjectModelKey(e.target.value)} className="w-full appearance-none px-3 py-2 pr-8 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 transition">
                <option value="">使用默认模型</option>
                {(modelsQuery.data ?? []).map((m) => <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>{m.provider} / {m.label}</option>)}
              </select>
              <ChevronDown className="w-3.5 h-3.5 absolute right-2.5 top-2.5 pointer-events-none text-slate-500" />
            </div>
          </div>
          <details className="group">
            <summary className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5 cursor-pointer hover:text-slate-700 dark:hover:text-slate-300 select-none">
              角色默认模型（可选）
            </summary>
            <div className="mt-2 space-y-3 pl-2 border-l-2 border-slate-200 dark:border-slate-800">
              {CONFIGURABLE_ROLE_KEYS.map((role) => (
                <div key={role.key} className="flex items-center gap-3">
                  <span className="text-xs text-slate-600 dark:text-slate-400 w-20">{role.label}</span>
                  <div className="relative flex-1">
                    <select
                      value={roleDefaultModels[role.key] ? `${roleDefaultModels[role.key]!.provider}/${roleDefaultModels[role.key]!.id}` : ''}
                      onChange={(e) => handleCreateProjectRoleModelChange(role.key, e.target.value)}
                      className="w-full appearance-none px-3 py-2 pr-8 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 transition"
                    >
                      <option value="">继承（使用默认模型）</option>
                      {(modelsQuery.data ?? []).map((m) => (
                        <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>{m.provider} / {m.label}</option>
                      ))}
                    </select>
                    <ChevronDown className="w-3.5 h-3.5 absolute right-2 top-2.5 pointer-events-none text-slate-500" />
                  </div>
                </div>
              ))}
            </div>
          </details>
          <div className="flex space-x-2 pt-3 justify-end border-t border-slate-150 dark:border-slate-800">
            <button type="button" onClick={() => { setShowCreateProject(false); setRoleDefaultModels({}); }} className="px-3 py-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition cursor-pointer">取消</button>
            <button type="submit" disabled={createProjectMut.isPending} className="px-4 py-1.5 text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 rounded-lg shadow-2xs hover:shadow-xs transition cursor-pointer disabled:opacity-50">{createProjectMut.isPending ? '创建中…' : '确认创建'}</button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={showSettings} onClose={() => setShowSettings(false)} title="设置" icon={<Settings className="w-4 h-4 text-slate-500 dark:text-slate-400" />}>
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
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">模型提供商</div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">支持 openai-completions、anthropic-messages、google-generative-ai、openai-responses</div>
              </div>
              <button onClick={handleOpenProviderModal} className="px-3 py-1.5 text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 rounded-lg shadow-2xs transition cursor-pointer">添加模型提供商</button>
            </div>
          </div>
          <div className="flex justify-end pt-3 border-t border-slate-150 dark:border-slate-800">
            <button onClick={() => setShowSettings(false)} className="px-4 py-1.5 text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 rounded-lg shadow-2xs transition cursor-pointer">关闭</button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={showProjectSettings} onClose={() => setShowProjectSettings(false)} title="项目设置" icon={<Settings className="w-4 h-4" />}>
        <div className="space-y-4">
          <div className="text-xs font-semibold text-slate-700 dark:text-slate-200 mb-2">角色默认模型</div>
          {CONFIGURABLE_ROLE_KEYS.map((role) => (
            <div key={role.key} className="flex items-center gap-3">
              <span className="text-xs text-slate-600 dark:text-slate-400 w-20">{role.label}</span>
              <div className="relative flex-1">
                <select
                  value={editRoleModels[role.key] ?? ''}
                  onChange={(e) => handleRoleModelChange(role.key, e.target.value)}
                  className="w-full appearance-none px-3 py-2 pr-8 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-white dark:bg-slate-950 text-slate-800 dark:text-slate-100 transition"
                >
                  <option value="">继承（使用父级模型）</option>
                  {(modelsQuery.data ?? []).map((m) => (
                    <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>{m.provider} / {m.label}</option>
                  ))}
                </select>
                <ChevronDown className="w-3.5 h-3.5 absolute right-2 top-2.5 pointer-events-none text-slate-500" />
              </div>
            </div>
          ))}
          <div className="flex justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
            <button onClick={() => setShowProjectSettings(false)} className="px-3 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg cursor-pointer">取消</button>
            <button onClick={handleSaveProjectRoleModels} disabled={setProjectRoleModelsMut.isPending} className="px-4 py-1.5 text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 rounded-lg cursor-pointer disabled:opacity-50">
              {setProjectRoleModelsMut.isPending ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={showProviderModal} onClose={handleCloseProviderModal} title="添加模型提供商" icon={<Database className="w-4 h-4 text-blue-600 dark:text-blue-400" />} maxWidthClassName="max-w-3xl">
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">providerKey</label>
              <input value={providerKey} onChange={(e) => setProviderKey(e.target.value)} placeholder="例如 custom-openai" className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950" />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">baseUrl</label>
              <input value={providerBaseUrl} onChange={(e) => setProviderBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950" />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">api</label>
              <select value={providerApi} onChange={(e) => setProviderApi(e.target.value)} className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950">
                <option value="">openai-completions（默认）</option>
                <option value="openai-completions">openai-completions</option>
                <option value="openai-responses">openai-responses</option>
                <option value="anthropic-messages">anthropic-messages</option>
                <option value="google-generative-ai">google-generative-ai</option>
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">apiKey</label>
              <input value={providerApiKey} onChange={(e) => setProviderApiKey(e.target.value)} type="password" placeholder="sk-..." className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950" />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300"><input type="checkbox" checked={providerAuthHeader} onChange={(e) => setProviderAuthHeader(e.target.checked)} /> authHeader</label>
            <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300"><input type="checkbox" checked={supportsDeveloperRole} onChange={(e) => setSupportsDeveloperRole(e.target.checked)} /> compat.supportsDeveloperRole</label>
            <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300"><input type="checkbox" checked={supportsReasoningEffort} onChange={(e) => setSupportsReasoningEffort(e.target.checked)} /> compat.supportsReasoningEffort</label>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">headers（JSON，可选）</label>
              <textarea value={providerHeaders} onChange={(e) => setProviderHeaders(e.target.value)} placeholder='{
  "x-custom-header": "value"
}' rows={3} className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 font-mono" />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">compat 额外字段（JSON，可选）</label>
              <textarea value={providerCompatJson} onChange={(e) => setProviderCompatJson(e.target.value)} placeholder='{
  "supportsUsageInStreaming": false,
  "maxTokensField": "max_tokens",
  "thinkingFormat": "deepseek"
}' rows={3} className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 font-mono" />
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">模型列表</div>
              <button onClick={handleAddProviderModel} className="px-3 py-1.5 text-xs font-semibold border border-slate-300 dark:border-slate-700 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">添加模型项</button>
            </div>
            {providerModels.map((model, index) => (
              <div key={index} className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-3 bg-slate-50 dark:bg-slate-950/40">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">模型 {index + 1}</div>
                  <button onClick={() => handleRemoveProviderModel(index)} disabled={providerModels.length === 1} className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 cursor-pointer"><Trash2 className="w-4 h-4" /></button>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <input value={model.id} onChange={(e) => updateProviderModel(index, { id: e.target.value })} placeholder="id" className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950" />
                  <input value={model.name ?? ''} onChange={(e) => updateProviderModel(index, { name: e.target.value })} placeholder="name（可选）" className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950" />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <select value={model.api ?? ''} onChange={(e) => updateProviderModel(index, { api: e.target.value })} className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950">
                      <option value="">api（继承提供商）</option>
                      <option value="openai-completions">openai-completions</option>
                      <option value="openai-responses">openai-responses</option>
                      <option value="anthropic-messages">anthropic-messages</option>
                      <option value="google-generative-ai">google-generative-ai</option>
                    </select>
                  </div>
                  <input value={model.contextWindow ?? ''} onChange={(e) => updateProviderModel(index, { contextWindow: e.target.value ? Number(e.target.value) : undefined })} type="number" placeholder="contextWindow（可选）" className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950" />
                  <input value={model.maxTokens ?? ''} onChange={(e) => updateProviderModel(index, { maxTokens: e.target.value ? Number(e.target.value) : undefined })} type="number" placeholder="maxTokens（可选）" className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950" />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                  <input value={model.cost?.input ?? ''} onChange={(e) => updateProviderModel(index, { cost: { ...model.cost, input: e.target.value ? Number(e.target.value) : undefined } })} type="number" step="0.01" min="0" placeholder="cost.input" className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950" />
                  <input value={model.cost?.output ?? ''} onChange={(e) => updateProviderModel(index, { cost: { ...model.cost, output: e.target.value ? Number(e.target.value) : undefined } })} type="number" step="0.01" min="0" placeholder="cost.output" className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950" />
                  <input value={model.cost?.cacheRead ?? ''} onChange={(e) => updateProviderModel(index, { cost: { ...model.cost, cacheRead: e.target.value ? Number(e.target.value) : undefined } })} type="number" step="0.01" min="0" placeholder="cost.cacheRead" className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950" />
                  <input value={model.cost?.cacheWrite ?? ''} onChange={(e) => updateProviderModel(index, { cost: { ...model.cost, cacheWrite: e.target.value ? Number(e.target.value) : undefined } })} type="number" step="0.01" min="0" placeholder="cost.cacheWrite" className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950" />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">compat（可选）</label>
                    <textarea value={model.compat ?? ''} onChange={(e) => updateProviderModel(index, { compat: e.target.value })} placeholder='例：{ &quot;forceAdaptiveThinking&quot;: true, &quot;thinkingFormat&quot;: &quot;deepseek&quot; }' rows={2} className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950 font-mono" />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">thinkingLevelMap（可选）</label>
                    <textarea value={model.thinkingLevelMap ?? ''} onChange={(e) => updateProviderModel(index, { thinkingLevelMap: e.target.value })} placeholder='例：{ &quot;off&quot;: null, &quot;medium&quot;: &quot;medium&quot;, &quot;high&quot;: &quot;high&quot; }' rows={2} className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950 font-mono" />
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="flex flex-wrap gap-4">
                    <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={model.reasoning} onChange={(e) => updateProviderModel(index, { reasoning: e.target.checked })} /> reasoning</label>
                    <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={model.inputImage} onChange={(e) => updateProviderModel(index, { inputImage: e.target.checked })} /> inputImage</label>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">input（可选）</label>
                    <div className="flex flex-wrap gap-4">
                      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={model.input?.includes('text') ?? false} onChange={(e) => {
                        const current = model.input ?? [];
                        const next = e.target.checked
                          ? [...current, 'text']
                          : current.filter((t) => t !== 'text');
                        updateProviderModel(index, { input: next.length > 0 ? next : undefined });
                      }} /> text</label>
                      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={model.input?.includes('image') ?? false} onChange={(e) => {
                        const current = model.input ?? [];
                        const next = e.target.checked
                          ? [...current, 'image']
                          : current.filter((t) => t !== 'image');
                        updateProviderModel(index, { input: next.length > 0 ? next : undefined });
                      }} /> image</label>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {providerError && <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded-lg px-3 py-2">{providerError}</div>}
          {providerTestResult && <div className="text-xs text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-900 rounded-lg px-3 py-2">{providerTestResult}</div>}
          {providerTestModels.length > 0 && (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-2">
              <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">测试返回模型</div>
              <div className="flex flex-wrap gap-2">{providerTestModels.map((model) => <span key={model.id} className="px-2 py-1 rounded-md bg-slate-100 dark:bg-slate-800 text-xs text-slate-700 dark:text-slate-200">{model.name ?? model.id}</span>)}</div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-3 border-t border-slate-150 dark:border-slate-800">
            <button onClick={handleCloseProviderModal} className="px-3 py-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition cursor-pointer">取消</button>
            <button onClick={handleTestProvider} disabled={testProviderMut.isPending} className="px-4 py-1.5 text-xs font-semibold border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition cursor-pointer disabled:opacity-50">{testProviderMut.isPending ? '测试中…' : '测试连接'}</button>
            <button onClick={handleSaveProvider} disabled={createProviderMut.isPending} className="px-4 py-1.5 text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 rounded-lg shadow-2xs transition cursor-pointer disabled:opacity-50">{createProviderMut.isPending ? '保存中…' : '保存'}</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
