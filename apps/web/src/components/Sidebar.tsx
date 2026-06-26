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
} from 'lucide-react';

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

export default function Sidebar({
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
    onWidthChange(newWidth);
  }, [onWidthChange]);

  const finishResize = useCallback(() => {
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
            if (!s.title.toLowerCase().includes(q) && !roleLabel(s.role_template_key).includes(q)) {
              return filteredChildren.length > 0 && anyRunning(filteredChildren)
                ? { ...s, children: filteredChildren }
                : null;
            }
          }

          return { ...s, children: filteredChildren };
        })
        .filter((s): s is SessionTreeNodeDTO => s !== null);

    return projects
      .map((p) => {
        if (hasSearch && p.name.toLowerCase().includes(q)) {
          // project name matched — only apply archive/worker filters to sessions, skip search
          return { ...p, sessions: filterSessions(p.sessions, false) };
        }
        const filtered = filterSessions(p.sessions, true);
        return filtered.length > 0 ? { ...p, sessions: filtered } : null;
      })
      .filter((p): p is ProjectDTO => p !== null);
  }, [projects, sidebarSearch, showArchived, showWorker]);

  // Sort planner's immediate children: feature_lead > bugfix_lead > other roles > blank
  function sortPlannerChildren(sessions: SessionTreeNodeDTO[]): SessionTreeNodeDTO[] {
    const priority: Record<string, number> = {
      feature_lead: 0,
      bugfix_lead: 1,
      blank: 3,
    };
    return [...sessions].sort((a, b) => {
      const pa = priority[a.role_template_key] ?? 2;
      const pb = priority[b.role_template_key] ?? 2;
      return pa - pb;
    });
  }

  const renderSessionNode = (session: SessionTreeNodeDTO, projectId: string, depth: number): React.ReactNode => {
    const isActive = session.id === activeSessionId;
    const hasChildren = session.children.length > 0;
    const isCollapsed = collapsedSessions[session.id];
    const isArchived = Boolean(session.archived_at);
    const statusDotColor = runtimeColor(session.runtime_status);


    return (
      <div key={session.id} className="w-full flex flex-col">
        <div
          onClick={() => onSelectSession(projectId, session.id)}
          style={{ paddingLeft: isSidebarCollapsed ? '0px' : `${Math.max(0, depth * 14 + 8 - 20)}px` }}
          className={`group flex items-center justify-between p-1.5 rounded-lg cursor-pointer transition ${
            isActive
              ? 'bg-slate-200 dark:bg-slate-800 text-slate-900 dark:text-white font-semibold shadow-2xs'
              : 'hover:bg-slate-200/50 dark:hover:bg-slate-800/40 text-slate-600 dark:text-slate-300'
          } ${isArchived ? 'opacity-50' : ''}`}
        >
          <div className="flex items-center flex-1 min-w-0">
            {/* 固定宽度的 chevron 位，有按钮显示按钮，无按钮留空 — 保证图标文字对齐 */}
            {!isSidebarCollapsed && (
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
              {!isSidebarCollapsed && React.createElement(roleIcon(session.role_template_key), { className: `w-3.5 h-3.5 shrink-0 ${isActive ? 'text-blue-500' : 'text-slate-400'}` })}

            {!isSidebarCollapsed && (
              <span
                className="text-[11.5px] truncate font-sans tracking-tight"
                title={session.title}
              >
                {session.title}
              </span>
            )}
            </div>
          </div>

          {!isSidebarCollapsed && (
            <div className="flex items-center gap-1 shrink-0 select-none">
              <span
                className="text-[9px] text-slate-400 dark:text-slate-500 font-sans tracking-tight px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800 rounded-md font-medium max-w-[65px] truncate group-hover:opacity-40 transition-opacity cursor-context-menu"
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (onArchiveSession) {
                    const name = session.title || roleLabel(session.role_template_key);
                    if (confirm(`确定归档会话 "${name}"？`)) {
                      onArchiveSession(session.id);
                    }
                  }
                }}
              >
                {roleLabel(session.role_template_key)}
              </span>
              {statusDotColor ? (
                <div className={`w-2 h-2 rounded-full shrink-0 ${statusDotColor} ${session.runtime_status === 'running' ? 'animate-pulse' : ''}`} />
              ) : null}
            </div>
          )}
        </div>

        {!isCollapsed && hasChildren && (
          <div className="flex flex-col space-y-0.5 mt-0.5">
            {(session.role_template_key === 'planner' ? sortPlannerChildren(session.children) : session.children).map((child) => renderSessionNode(child, projectId, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className={`bg-slate-100 dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 flex flex-col h-screen select-none relative ${
        isDragging ? '' : 'transition-all duration-200'
      }`}
      style={{ width: isSidebarCollapsed ? 64 : sidebarWidth }}
    >
      {!isSidebarCollapsed && (
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
        {!isSidebarCollapsed && (
          <div className="flex items-center space-x-2">
            <div className="bg-blue-600 text-white font-black px-2 py-1 rounded text-sm tracking-widest font-sans flex items-center">
              Pi
            </div>
            <span className="font-semibold text-slate-800 dark:text-slate-100 text-sm tracking-tight font-sans">
              Piplus
            </span>
          </div>
        )}
        <button
          onClick={onToggleSidebar}
          className="p-1 px-1.5 hover:bg-slate-200/70 text-slate-500 rounded transition ml-auto flex items-center cursor-pointer"
        >
          {isSidebarCollapsed ? <ChevronRight className="w-4 h-4" /> : <span className="text-xs font-mono font-bold">«</span>}
        </button>
      </div>

      {/* New Project button */}
      {!isSidebarCollapsed && (
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
      {!isSidebarCollapsed && (
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
      {!isSidebarCollapsed && (
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
        {isSidebarCollapsed ? (
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
          filteredProjects.map((project) => {
            const isCollapsed = collapsedProjects[project.id];
            return (
              <div key={project.id} className="space-y-0.5">
                <div
                  className={`group flex items-center justify-between p-1.5 rounded-lg hover:bg-slate-200/50 dark:hover:bg-slate-800/50 text-slate-700 dark:text-slate-300 cursor-pointer ${
                    isSidebarCollapsed ? 'justify-center' : ''
                  }`}
                  onClick={() => !isSidebarCollapsed && toggleProject(project.id)}
                >
                  <div className="flex items-center space-x-1.5 flex-1 min-w-0">
                    {!isSidebarCollapsed ? (
                      <>
                        <FolderOpen className="w-4 h-4 shrink-0 text-blue-400/80 dark:text-blue-500/80" />
                        <span className="text-xs font-semibold truncate text-slate-700 dark:text-slate-200 leading-tight">
                          {project.name}
                        </span>
                      </>
                    ) : (
                      <div title={project.name}>
                        <Folder className="w-4 h-4 text-slate-400" />
                      </div>
                    )}
                  </div>

                  {!isSidebarCollapsed && (
                    <div className="flex items-center space-x-1 pl-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectProject(project.id);
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
                      <div className="flex items-center space-x-1">
                        {onArchiveProject && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (confirm(`确定归档项目 "${project.name}"？`)) {
                                onArchiveProject(project.id);
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
                              onOpenProjectSettings(project.id);
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
                              if (confirm(`确定删除项目 "${project.name}" 及其所有会话？`)) {
                                onDeleteProject(project.id);
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



                {/* Sessions */}
                {!isCollapsed && (
                  <div className={isSidebarCollapsed ? 'space-y-1' : 'space-y-0.5'}>
                    {project.sessions.map((session) => renderSessionNode(session, project.id, 1))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      {!isSidebarCollapsed && (
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
            className="ml-2 p-1.5 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-lg text-slate-500 dark:text-slate-400 transition cursor-pointer inline-flex items-center"
            title="GitHub 仓库"
          >
            <Github className="w-4 h-4" />
          </a>

          <button
            onClick={onOpenSettings}
            className="ml-auto p-1.5 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-lg text-slate-500 dark:text-slate-400 transition cursor-pointer"
            title="设置"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
