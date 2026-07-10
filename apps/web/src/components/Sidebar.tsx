import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type { ProjectDTO, SessionTreeNodeDTO } from '@piplus/shared';
import {
  Folder,
  FolderOpen,
  Github,
  FileText,
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  LogOut,
  Settings,
  PlusCircle,
  Search,
  Archive,
  Star,
  Circle,
  Triangle,
  Bug,
  Eye,
  User,
  ArrowUp,
} from 'lucide-react';
import { fuzzyMatch } from '../lib/fuzzy';
import { version as appVersion } from '../../../../apps/desktop/package.json';

interface SidebarProps {
  projects: ProjectDTO[];
  activeSessionId: string | null;
  isSidebarCollapsed: boolean;
  sidebarWidth: number;
  onWidthChange: (width: number) => void;
  onSelectSession: (projectId: string, sessionId: string) => void;
  onSelectProject: (projectId: string) => void;
  onToggleSidebar: () => void;
  onCreateProject: () => void;
  onCreateSession: () => void;
  onArchiveProject?: (projectId: string) => void;
  onToggleSessionPinned?: (sessionId: string, pinned: boolean) => void;
  onToggleProjectPinned?: (projectId: string, pinned: boolean) => void;
  onArchiveSession?: (sessionId: string) => void;
  onDeleteProject?: (projectId: string) => void;
  onLogout: () => void;
  onOpenSettings: () => void;
  onOpenProjectSettings?: (projectId: string) => void;
  showArchived: boolean;
  onToggleShowArchived: () => void;
  showWorker: boolean;
  onToggleShowWorker: () => void;
  treeLoading: boolean;
  creatingSession: boolean;
  /** 移动端模式：全宽展示树，无折叠/拖拽交互 */
  isMobile?: boolean;
  /** 移动端模式下控制侧边栏显示/隐藏 */
  isMobileVisible?: boolean;
  /** 移动端返回目录树回调 */
  onReturnToTree?: () => void;
  /** 隐藏 session 树上的角色名 */
  hideRoleLabels?: boolean;
}

function roleLabel(key: string): string {
  const map: Record<string, string> = {
    planner: '规划者',
    worker: '执行者',
    reviewer: '审查者',
    feature_lead: '需求负责人',
    bugfix_lead: 'Bug负责人',
    blank: '空白',
  };
  return map[key] ?? key;
}

function roleIcon(key: string) {
  const map: Record<string, React.ComponentType<{ className?: string }>> = {
    planner: Star,
    worker: Circle,
    reviewer: Eye,
    feature_lead: Triangle,
    bugfix_lead: Bug,
    blank: User,
  };
  return map[key] ?? FileText;
}

function projectInitials(name: string): string {
  const trimmed = name?.trim() ?? '';
  if (trimmed.length === 0) return '?';
  return trimmed[0].toUpperCase();
}

function runtimeColor(status: string): string | null {
  switch (status) {
    case 'running':
      return 'bg-emerald-500';
    case 'stopping':
    case 'error':
      return 'bg-amber-500';
    case 'idle':
    default:
      return null;
  }
}

function Sidebar({
  projects,
  activeSessionId,
  isSidebarCollapsed,
  sidebarWidth,
  onWidthChange,
  onSelectSession,
  onSelectProject,
  onToggleSidebar,
  onCreateProject,
  onCreateSession,
  onToggleSessionPinned,
  onToggleProjectPinned,
  onArchiveProject,
  onArchiveSession,
  onDeleteProject,
  onLogout,
  onOpenSettings,
  onOpenProjectSettings,
  showArchived,
  onToggleShowArchived,
  showWorker,
  onToggleShowWorker,
  treeLoading,
  creatingSession,
  isMobile,
  isMobileVisible,
  onReturnToTree,
  hideRoleLabels,
}: SidebarProps) {
  const [sidebarSearch, setSidebarSearch] = useState('');
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem('pi-collapsed-projects');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });
  const [collapsedSessions, setCollapsedSessions] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem('pi-collapsed-sessions');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const [isDragging, setIsDragging] = useState(false);
  const dragInfo = useRef({ startX: 0, startWidth: 0 });
  const draggingRef = useRef(false);
  const sidebarRef = useRef<HTMLDivElement>(null);

  const handleResizePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragInfo.current = { startX: e.clientX, startWidth: sidebarWidth };
    draggingRef.current = true;
    setIsDragging(true);
  }, [sidebarWidth]);

  const handleResizePointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    const delta = e.clientX - dragInfo.current.startX;
    const newWidth = Math.max(240, Math.min(520, dragInfo.current.startWidth + delta));
    // 直接操作 DOM，避免触发 React 重渲染
    if (sidebarRef.current) {
      sidebarRef.current.style.width = `${newWidth}px`;
    }
  }, [onWidthChange]);

  const finishResize = useCallback(() => {
    if (draggingRef.current && sidebarRef.current) {
      // 松手时同步最终宽度到 React state
      const finalWidth = parseInt(sidebarRef.current.style.width, 10);
      if (!isNaN(finalWidth)) {
        onWidthChange(finalWidth);
      }
    }
    draggingRef.current = false;
    setIsDragging(false);
  }, []);

  const handleResizePointerUp = finishResize;
  const handleResizePointerCancel = finishResize;
  const handleLostPointerCapture = finishResize;

  // Cleanup dragging state on unmount, in case the component is removed mid-drag
  useEffect(() => {
    return () => {
      draggingRef.current = false;
      setIsDragging(false);
    };
  }, []);

  const toggleProject = (id: string) => {
    setCollapsedProjects((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleSession = (id: string) => {
    setCollapsedSessions((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  useEffect(() => {
    try { localStorage.setItem('pi-collapsed-projects', JSON.stringify(collapsedProjects)); } catch {}
  }, [collapsedProjects]);

  useEffect(() => {
    try { localStorage.setItem('pi-collapsed-sessions', JSON.stringify(collapsedSessions)); } catch {}
  }, [collapsedSessions]);

  const filteredProjects = useMemo(() => {
    const q = sidebarSearch?.toLowerCase() ?? '';
    const hasSearch = q.length > 0;

    // Check if any session in the tree is running (recursive)
    function anyRunning(sessions: SessionTreeNodeDTO[]): boolean {
      return sessions.some((s) => s.runtime_status === 'running' || anyRunning(s.children));
    }

    const filterSessions = (sessions: SessionTreeNodeDTO[], includeSearch: boolean): SessionTreeNodeDTO[] =>
      sessions
        .map((s) => {
          const filteredChildren = filterSessions(s.children, includeSearch);

          // Running sessions always pass all filters
          if (s.runtime_status === 'running') {
            return { ...s, children: filteredChildren };
          }

          // Check standard filters
          if (!showArchived && s.archived_at) {
            // Keep as bridge node only if has running descendant
            return filteredChildren.length > 0 && anyRunning(filteredChildren)
              ? { ...s, children: filteredChildren }
              : null;
          }
          if (s.role_template_key === 'worker' && !showWorker) {
            return filteredChildren.length > 0 && anyRunning(filteredChildren)
              ? { ...s, children: filteredChildren }
              : null;
          }
          if (includeSearch && hasSearch) {
            if (!fuzzyMatch(q, s.title) && !fuzzyMatch(q, s.role_template_key) && !fuzzyMatch(q, roleLabel(s.role_template_key))) {
              // Bridge node: keep visible if any child matched the search
              return filteredChildren.length > 0
                ? { ...s, children: filteredChildren }
                : null;
            }
          }

          return { ...s, children: filteredChildren };
        })
        .filter((s): s is SessionTreeNodeDTO => s !== null);

    return projects
      .map((p) => {
        if (hasSearch && fuzzyMatch(q, p.name)) {
          // project name matched — only apply archive/worker filters to sessions, skip search
          return { ...p, sessions: filterSessions(p.sessions, false) };
        }
        const filtered = filterSessions(p.sessions, true);
        return filtered.length > 0 ? { ...p, sessions: filtered } : null;
      })
      .filter((p): p is ProjectDTO => p !== null);
  }, [projects, sidebarSearch, showArchived, showWorker]);

  // Shared comparator: blank first (no children, compact), then pinned first, then newest pinned first, then last_activity_at desc
  function sortByPinnedThenActivity(a: SessionTreeNodeDTO, b: SessionTreeNodeDTO): number {
    // Blank sessions at top
    if (a.role_template_key === 'blank' && b.role_template_key !== 'blank') return -1;
    if (a.role_template_key !== 'blank' && b.role_template_key === 'blank') return 1;
    if (a.pinned_at && b.pinned_at) {
      // Newer pinned first
      if (a.pinned_at < b.pinned_at) return 1;
      if (a.pinned_at > b.pinned_at) return -1;
    }
    // Fall back to last_activity_at desc for deterministic order
    if (a.last_activity_at < b.last_activity_at) return 1;
    if (a.last_activity_at > b.last_activity_at) return -1;
    return 0;
  }

  // Sort planner's immediate children: pinned first, then role priority, then activity
  function sortPlannerChildren(sessions: SessionTreeNodeDTO[]): SessionTreeNodeDTO[] {
    const priority: Record<string, number> = {
      blank: 0,
      feature_lead: 1,
      bugfix_lead: 2,
    };
    return [...sessions].sort((a, b) => {
      // Pinned first
      if (a.pinned_at && !b.pinned_at) return -1;
      if (!a.pinned_at && b.pinned_at) return 1;
      // Both pinned: newer pinned_at first
      if (a.pinned_at && b.pinned_at) {
        if (a.pinned_at < b.pinned_at) return 1;
        if (a.pinned_at > b.pinned_at) return -1;
      }
      // Same pinned state: sort by role priority
      const pa = priority[a.role_template_key] ?? 3;
      const pb = priority[b.role_template_key] ?? 3;
      if (pa !== pb) return pa - pb;
      // Same role: fall back to last_activity_at desc
      if (a.last_activity_at < b.last_activity_at) return 1;
      if (a.last_activity_at > b.last_activity_at) return -1;
      return 0;
    });
  }

  const renderSessionNode = (session: SessionTreeNodeDTO, projectId: string, depth: number): React.ReactNode => {
    const isActive = session.id === activeSessionId;
    const hasChildren = session.children.length > 0;
    const isCollapsed = collapsedSessions[session.id];
    const isArchived = Boolean(session.archived_at);
    const statusDotColor = runtimeColor(session.runtime_status);
    const isPinned = Boolean(session.pinned_at);


    return (
      <div key={session.id} className="w-full flex flex-col">
        <div
          onClick={() => onSelectSession(projectId, session.id)}
          style={{ paddingLeft: effectiveCollapsed ? '0px' : `${Math.max(0, depth * 14 + 8 - 20)}px` }}
          className={`group flex items-center justify-between p-1.5 rounded-lg cursor-pointer transition ${hideRoleLabels ? 'relative' : ''} ${
            isActive
              ? 'bg-slate-200 dark:bg-slate-800 text-slate-900 dark:text-white font-semibold shadow-2xs'
              : 'hover:bg-slate-200/50 dark:hover:bg-slate-800/40 text-slate-600 dark:text-slate-300'
          } ${isArchived ? 'opacity-50' : ''}`}
        >
          <div className="flex items-center flex-1 min-w-0">
            {/* 固定宽度的 chevron 位，有按钮显示按钮，无按钮留空 — 保证图标文字对齐 */}
            {!effectiveCollapsed && (
              <div className="w-4 shrink-0 flex items-center justify-start">
                {hasChildren && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleSession(session.id);
                    }}
                    className="p-0.5 hover:bg-slate-300/60 rounded text-slate-500"
                  >
                    <ChevronDown className={`w-3 h-3 transition-transform duration-200 ${isCollapsed ? '-rotate-90' : ''}`} />
                  </button>
                )}
              </div>
            )}
            <div className="flex items-center space-x-1.5 min-w-0">
              {(isPinned || !effectiveCollapsed) && React.createElement(roleIcon(session.role_template_key), { className: `w-3.5 h-3.5 shrink-0 ${isActive ? 'text-blue-500' : isPinned ? 'text-amber-300 dark:text-amber-300' : 'text-slate-400'}` })}

            {!effectiveCollapsed && (
              <span
                className="text-[11.5px] truncate font-sans tracking-tight"
                title={session.title}
              >
                {session.title}
              </span>
            )}
            </div>
          </div>

          {!effectiveCollapsed && (hideRoleLabels ? (
            <>
              <div className="absolute right-1.5 top-1/2 -translate-y-1/2 z-10 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                <span
                  className={`text-[9px] font-sans tracking-tight px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800 rounded-md font-medium max-w-[65px] truncate cursor-pointer ${isPinned ? 'text-amber-600 dark:text-amber-400' : 'text-slate-400 dark:text-slate-500'}`}
                  title={isPinned ? '左键取消置顶，右键归档' : '左键置顶，右键归档'}
                  onClick={(e) => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    if (onToggleSessionPinned) {
                      onToggleSessionPinned(session.id, !isPinned);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (onArchiveSession) {
                      const name = session.title || roleLabel(session.role_template_key);
                      setTimeout(() => {
                        if (confirm(`确定归档会话 "${name}"？`)) {
                          onArchiveSession(session.id);
                        }
                      }, 0);
                    }
                  }}
                >
                  {roleLabel(session.role_template_key)}
                </span>
              </div>
              {statusDotColor ? (
                <div className={`w-2 h-2 rounded-full shrink-0 ${statusDotColor} ${session.runtime_status === 'running' ? 'animate-pulse' : ''}`} />
              ) : null}
            </>
          ) : (
            <div className="flex items-center gap-1 shrink-0 select-none">
              <span
                className={`text-[9px] font-sans tracking-tight px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800 rounded-md font-medium max-w-[65px] truncate cursor-pointer ${isPinned ? 'text-amber-600 dark:text-amber-400' : 'text-slate-400 dark:text-slate-500'}`}
                title={isPinned ? '左键取消置顶，右键归档' : '左键置顶，右键归档'}
                onClick={(e) => {
                  if (e.button !== 0) return;
                  e.stopPropagation();
                  if (onToggleSessionPinned) {
                    onToggleSessionPinned(session.id, !isPinned);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (onArchiveSession) {
                    const name = session.title || roleLabel(session.role_template_key);
                    setTimeout(() => {
                      if (confirm(`确定归档会话 "${name}"？`)) {
                        onArchiveSession(session.id);
                      }
                    }, 0);
                  }
                }}
              >
                {roleLabel(session.role_template_key)}
              </span>
              {statusDotColor ? (
                <div className={`w-2 h-2 rounded-full shrink-0 ${statusDotColor} ${session.runtime_status === 'running' ? 'animate-pulse' : ''}`} />
              ) : null}
            </div>
          ))}
        </div>

        {!isCollapsed && hasChildren && (
          <div className="flex flex-col space-y-0.5 mt-0.5">
            {(session.role_template_key === 'planner' 
              ? sortPlannerChildren(session.children) 
              : [...session.children].sort(sortByPinnedThenActivity)
            ).map((child) => renderSessionNode(child, projectId, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const isMobileMode = isMobile === true;
  const isVisible = isMobileMode ? isMobileVisible === true : true;
  // 移动端：把 isSidebarCollapsed 视为 false（始终展开），禁用折叠/拖拽
  const effectiveCollapsed = isMobileMode ? false : isSidebarCollapsed;

  return (
    <div
      ref={sidebarRef}
      className={`bg-slate-100 dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 flex flex-col h-[100dvh] min-h-0 overflow-hidden select-none relative ${
        isDragging ? '' : 'transition-all duration-200'
      } ${!isVisible ? 'hidden' : ''}`}
      style={{
        width: isMobileMode ? '100%' : effectiveCollapsed ? 64 : sidebarWidth,
      }}
    >
      {/* 移动端不显示拖拽手柄 */}
      {!isMobileMode && !effectiveCollapsed && (
        <div
          className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-blue-500/30 active:bg-blue-500/50 z-10"
          style={{ touchAction: 'none' }}
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerUp}
          onPointerCancel={handleResizePointerCancel}
          onLostPointerCapture={handleLostPointerCapture}
        />
      )}
      {/* Header */}
      <div className="p-4 border-b border-slate-200 dark:border-slate-800/80 flex items-center justify-between">
        {!isMobileMode && !effectiveCollapsed && (
          <div className="flex items-center space-x-2">
            <div className="bg-blue-600 text-white font-black px-2 py-1 rounded text-sm tracking-widest font-sans flex items-center">
              Pi
            </div>
            <span className="font-semibold text-slate-800 dark:text-slate-100 text-sm tracking-tight font-sans">
              Piplus
            </span>
            <span className="text-[10px] text-slate-400 dark:text-slate-600 font-mono">v{appVersion}</span>
          </div>
        )}

        {/* 移动端：返回按钮 + 标题 */}
        {isMobileMode && (
          <div className="flex items-center space-x-2 w-full">
            <button
              onClick={onReturnToTree}
              className="p-1.5 hover:bg-slate-200/70 text-slate-500 rounded transition flex items-center cursor-pointer"
              title="返回目录树"
              aria-label="返回目录树"
            >
              <ChevronRight className="w-5 h-5 rotate-180" />
            </button>
            <span className="font-semibold text-slate-800 dark:text-slate-100 text-sm tracking-tight font-sans">
              Piplus
            </span>
            <span className="text-[10px] text-slate-400 dark:text-slate-600 font-mono">v{appVersion}</span>
          </div>
        )}

        {/* 桌面端：折叠切换按钮 */}
        {!isMobileMode && (
          <button
            onClick={onToggleSidebar}
            className="p-1 px-1.5 hover:bg-slate-200/70 text-slate-500 rounded transition ml-auto flex items-center cursor-pointer"
          >
            {effectiveCollapsed ? <ChevronRight className="w-4 h-4" /> : <span className="text-xs font-mono font-bold">«</span>}
          </button>
        )}
      </div>

      {/* New Project button */}
      {!effectiveCollapsed && (
        <div className="p-3 shrink-0">
          <button
            onClick={onCreateProject}
            className="w-full bg-blue-600 hover:bg-blue-700 hover:shadow-sm text-white font-medium py-2 px-4 rounded-xl text-xs flex items-center justify-center space-x-2 transition cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>新建项目</span>
          </button>
        </div>
      )}

      {/* Search */}
      {!effectiveCollapsed && (
        <div className="px-3 mb-2 relative">
          <input
            type="text"
            placeholder="搜索会话..."
            value={sidebarSearch}
            onChange={(e) => setSidebarSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-xs border border-slate-200 dark:border-slate-800 rounded-lg focus:outline-none bg-slate-100/60 dark:bg-slate-800/60 focus:bg-white dark:focus:bg-slate-800 text-slate-700 dark:text-slate-200 placeholder:text-slate-400"
          />
          <Search className="w-3.5 h-3.5 absolute left-5 top-2.5 text-slate-400 dark:text-slate-500" />
        </div>
      )}

      {/* Filter toggles */}
      {!effectiveCollapsed && (
        <div className="px-3 mb-2 flex flex-row items-center">
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={onToggleShowArchived}
              className="w-3 h-3 accent-slate-600 rounded cursor-pointer dark:bg-slate-700 dark:border-slate-600"
            />
            <span className={`text-[10px] font-semibold ${showArchived ? 'text-amber-700 dark:text-amber-400' : 'text-slate-400 dark:text-slate-500'}`}>
              显示已归档
            </span>
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer select-none ml-auto">
            <input
              type="checkbox"
              checked={showWorker}
              onChange={onToggleShowWorker}
              className="w-3 h-3 accent-slate-600 rounded cursor-pointer dark:bg-slate-700 dark:border-slate-600"
            />
            <span className={`text-[10px] font-semibold ${showWorker ? 'text-blue-700 dark:text-blue-400' : 'text-slate-400 dark:text-slate-500'}`}>
              显示已完成Worker
            </span>
          </label>
        </div>
      )}

      {/* Tree */}
      <div className="flex-1 overflow-y-auto px-2 space-y-1 py-2">
        {effectiveCollapsed ? (
          treeLoading ? (
            <div className="text-xs text-slate-400 text-center py-4">加载中…</div>
          ) : filteredProjects.length === 0 ? null : (
            <div className="flex flex-col items-center space-y-2 py-2">
              {filteredProjects.map((project) => (
                <button
                  key={project.id}
                  onClick={onToggleSidebar}
                  className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 text-sm font-semibold cursor-pointer transition-colors"
                  title={project.name}
                >
                  {projectInitials(project.name)}
                </button>
              ))}
            </div>
          )
        ) : treeLoading ? (
          <div className="text-xs text-slate-400 text-center py-4">加载中…</div>
        ) : filteredProjects.length === 0 ? (
          <div className="text-xs text-slate-400 text-center py-4">暂无项目</div>
        ) : (
          filteredProjects.map((fp) => {
            const isCollapsed = collapsedProjects[fp.id];
            return (
              <div key={fp.id} className="space-y-0.5">
                <div
                  className={`group flex items-center justify-between p-1.5 rounded-lg hover:bg-slate-200/50 dark:hover:bg-slate-800/50 text-slate-700 dark:text-slate-300 cursor-pointer ${
                    effectiveCollapsed ? 'justify-center' : ''
                  }`}
                  onClick={() => !effectiveCollapsed && toggleProject(fp.id)}
                >
                  <div className="flex items-center space-x-1.5 flex-1 min-w-0">
                    {!effectiveCollapsed ? (
                      <>
                        <FolderOpen className="w-4 h-4 shrink-0 text-blue-400/80 dark:text-blue-500/80" />
                        <span className="text-xs font-semibold truncate text-slate-700 dark:text-slate-200 leading-tight">
                          {fp.name}
                        </span>
                      </>
                    ) : (
                      <div title={fp.name}>
                        <Folder className="w-4 h-4 text-slate-400" />
                      </div>
                    )}
                  </div>

                  {!effectiveCollapsed && (
                    <div className="flex items-center space-x-1 pl-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectProject(fp.id);
                          onCreateSession();
                        }}
                        className="p-0.5 hover:bg-blue-50 hover:text-blue-600 rounded text-slate-400 cursor-pointer transition-colors"
                        title="新建空白 Session"
                        disabled={creatingSession}
                        type="button"
                      >
                        {creatingSession ? (
                          <span className="block w-3 h-3 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
                        ) : (
                          <Plus className="w-3.5 h-3.5" />
                        )}
                      </button>
                      {onToggleProjectPinned && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleProjectPinned(fp.id, !Boolean(fp.pinned_at));
                          }}
                          className={`p-0.5 rounded cursor-pointer transition-colors ${fp.pinned_at ? 'text-amber-500 hover:text-amber-600 hover:bg-amber-50' : 'text-slate-400 hover:text-amber-500 hover:bg-amber-50'}`}
                          title={fp.pinned_at ? '取消置顶' : '置顶项目'}
                          type="button"
                        >
                          <ArrowUp className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <div className="flex items-center space-x-1">
                        {onArchiveProject && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (confirm(`确定归档项目 "${fp.name}"？`)) {
                                onArchiveProject(fp.id);
                              }
                            }}
                            className="p-0.5 hover:bg-amber-100 hover:text-amber-600 rounded text-slate-400 cursor-pointer transition-colors"
                            title="归档项目"
                          >
                            <Archive className="w-3 h-3" />
                          </button>
                        )}
                        {onOpenProjectSettings && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenProjectSettings(fp.id);
                            }}
                            className="p-0.5 hover:bg-slate-100 hover:text-slate-600 rounded text-slate-400 cursor-pointer transition-colors"
                            title="项目设置"
                          >
                            <Settings className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {onDeleteProject && projects.length > 1 && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (confirm(`确定删除项目 "${fp.name}" 及其所有会话？`)) {
                                onDeleteProject(fp.id);
                              }
                            }}
                            className="p-0.5 hover:bg-red-50 hover:text-red-600 rounded text-slate-400 cursor-pointer transition-colors"
                            title="删除项目"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>



                {/* Sessions — fp.sessions comes from filteredProjects, already filtered */}
                {!isCollapsed && (
                  <div className={effectiveCollapsed ? 'space-y-1' : 'space-y-0.5'}>
                    {[...fp.sessions].sort(sortByPinnedThenActivity).map((session) => renderSessionNode(session, fp.id, 1))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      {!effectiveCollapsed && (
        <div className="p-3 border-t border-slate-200 dark:border-slate-800 bg-slate-200/60 dark:bg-slate-900/60 flex flex-row items-center">
          <button
            onClick={onLogout}
            className="flex items-center space-x-1.5 hover:bg-slate-200 dark:hover:bg-slate-800 p-1.5 rounded-lg text-slate-600 dark:text-slate-300 transition text-[11.5px] font-sans cursor-pointer"
          >
            <LogOut className="w-4 h-4 text-slate-500 dark:text-slate-400" />
            <span>退出登录</span>
          </button>

          <a
            href="https://github.com/bighu630/piplus"
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto p-1.5 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-lg text-slate-500 dark:text-slate-400 transition cursor-pointer inline-flex items-center"
            title="GitHub 仓库"
          >
            <Github className="w-4 h-4" />
          </a>

          <button
            onClick={onOpenSettings}
            className="ml-2 p-1.5 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-lg text-slate-500 dark:text-slate-400 transition cursor-pointer"
            title="设置"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}

export default React.memo(Sidebar);
