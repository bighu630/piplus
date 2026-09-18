import { useCallback, useEffect, useMemo, useRef, useState, startTransition } from 'react';
import type { ProjectDTO } from '@piplus/shared';
import { findFirstSession, findProjectId } from './tree-utils';
import { getSessionIdFromPath, getSessionPath } from './session-path';
import { useWebSocket } from './ws-provider';

interface UseSessionSelectionArgs {
  tree: ProjectDTO[];
  isMobile: boolean;
  /** 当前标签页：仅用于同步 WS 会话上下文。 */
  activeTab: string;
  /** 会话切换时的附带 UI 动作（Tab 归位到 chat、退出标题编辑等）。 */
  onSessionSelected?: () => void;
}

/**
 * URL ↔ 会话选择的单一来源：
 * - 从 URL 初始化并双向同步（history.replaceState）；
 * - 树到达后校验选中会话、找不到则回退到第一个未归档会话；
 * - 移动端侧边栏显隐；
 * - 选中会话时恢复其运行时；
 * - 同步 WS 会话上下文。
 */
export function useSessionSelection({ tree, isMobile, activeTab, onSessionSelected }: UseSessionSelectionArgs) {
  const { setSessionContext } = useWebSocket();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [showMobileSidebar, setShowMobileSidebar] = useState(
    () => !(typeof window !== 'undefined' && getSessionIdFromPath(window.location.pathname)),
  );
  const initialUrlSessionId = useMemo(() => getSessionIdFromPath(window.location.pathname), []);
  const lastRestoredSessionRef = useRef<string | null>(null);

  const isSidebarVisible = !isMobile || showMobileSidebar;
  const isContentVisible = !isMobile || !showMobileSidebar;

  // Restore session runtime when entering a session
  useEffect(() => {
    if (!selectedSessionId) return;
    if (selectedSessionId === lastRestoredSessionRef.current) return;
    lastRestoredSessionRef.current = selectedSessionId;
    import('./api').then(({ restoreSessionRuntime }) => {
      restoreSessionRuntime(selectedSessionId).catch(() => {});
    });
  }, [selectedSessionId]);

  // 树 ← URL/当前选中：校验存在性，缺失则回退到第一个未归档会话
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

  // URL ← 当前选中
  useEffect(() => {
    const targetPath = getSessionPath(selectedSessionId);
    if (window.location.pathname !== targetPath) {
      window.history.replaceState(null, '', targetPath);
    }
  }, [selectedSessionId]);

  // 选中会话变化时重新推导所属项目
  useEffect(() => {
    if (!selectedSessionId || !tree.length) return;
    const pid = findProjectId(tree, selectedSessionId);
    if (pid) setSelectedProjectId(pid);
  }, [selectedSessionId, tree]);

  // 移动端：无选中会话时展示树
  useEffect(() => {
    if (!isMobile) {
      setShowMobileSidebar(false);
      return;
    }
    setShowMobileSidebar(!selectedSessionId);
  }, [isMobile, selectedSessionId]);

  useEffect(() => {
    setSessionContext(selectedSessionId, selectedProjectId, activeTab);
  }, [selectedSessionId, selectedProjectId, activeTab, setSessionContext]);

  const handleSelectSession = useCallback((projectId: string, sessionId: string) => {
    startTransition(() => {
      setSelectedProjectId(projectId);
      setSelectedSessionId(sessionId);
      onSessionSelected?.();
      if (isMobile) setShowMobileSidebar(false);
    });
  }, [isMobile, onSessionSelected]);

  /**
   * ask_question 通知/toast 的跳转：把用户带到提问所在会话。
   * 树里能找到项目就走与侧边栏点击同一条路径（切项目 + 会话 + chat 标签）；
   * 找不到时仍先设置会话 id（树还在加载时，树到达后校验 effect 会自动定位到它）；
   * 若该会话已不在树中（如已归档），校验 effect 会回退到第一个会话。
   */
  const handleNavigateToSession = useCallback((sessionId: string) => {
    const projectId = tree.length > 0 ? findProjectId(tree, sessionId) : null;
    if (projectId) {
      handleSelectSession(projectId, sessionId);
      return;
    }
    startTransition(() => {
      setSelectedSessionId(sessionId);
      onSessionSelected?.();
      if (isMobile) setShowMobileSidebar(false);
    });
  }, [tree, handleSelectSession, isMobile, onSessionSelected]);

  return {
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
  };
}
