import React, { useState } from "react";
import { Project, Session } from "../types";
import Modal from "./Modal";
import { 
  Folder, 
  FolderOpen, 
  FileText, 
  ChevronDown, 
  ChevronRight, 
  Plus, 
  Trash2, 
  LogOut, 
  Settings, 
  PlusCircle,
  X,
  Sparkles,
  Search,
  Check,
  Star,
  Circle,
  Triangle,
  Bug,
  Eye,
  User,
} from "lucide-react";

// ... (existing code until SidebarProps)

function roleIcon(key?: string) {
  const map: Record<string, React.ComponentType<{ className?: string }>> = {
    planner: Star,
    worker: Circle,
    reviewer: Eye,
    feature_lead: Triangle,
    bugfix_lead: Bug,
    blank: User,
  };
  return (key && map[key]) ? map[key] : FileText;
}

interface SidebarProps {
  projects: Project[];
  activeSessionId: string;
  isSidebarCollapsed: boolean;
  onSelectSession: (sessionId: string) => void;
  onToggleSidebar: () => void;
  onAddProject: (name: string, department?: string, githubUrl?: string) => void;
  onAddSession: (projectId: string, name: string, parentSessionId?: string) => void;
  onDeleteSession: (projectId: string, sessionId: string) => void;
  onDeleteProject: (projectId: string) => void;
  onToggleProjectCollapse: (projectId: string) => void;
  onOpenSettings: () => void;
  onLogout: () => void;
}

export default function Sidebar({
  projects,
  activeSessionId,
  isSidebarCollapsed,
  onSelectSession,
  onToggleSidebar,
  onAddProject,
  onAddSession,
  onDeleteSession,
  onDeleteProject,
  onToggleProjectCollapse,
  onOpenSettings,
  onLogout
}: SidebarProps) {
  const [showAddProject, setShowAddProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectDirectory, setNewProjectDirectory] = useState("/src");
  const [customDirectory, setCustomDirectory] = useState("");
  const [newProjectGithubUrl, setNewProjectGithubUrl] = useState("");

  const [addingSessionToProjectId, setAddingSessionToProjectId] = useState<string | null>(null);
  const [newSessionName, setNewSessionName] = useState("");
  const [sidebarSearch, setSidebarSearch] = useState("");

  const [collapsedSessionIds, setCollapsedSessionIds] = useState<Record<string, boolean>>({});
  const [addingSubSessionToId, setAddingSubSessionToId] = useState<string | null>(null);
  const [newSubSessionName, setNewSubSessionName] = useState("");

  const handleAddProjectSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (newProjectName.trim()) {
      const dirVal = newProjectDirectory === "其他" ? customDirectory.trim() : newProjectDirectory;
      onAddProject(
        newProjectName.trim(), 
        dirVal || "未绑定", 
        newProjectGithubUrl.trim()
      );
      setNewProjectName("");
      setNewProjectDirectory("/src");
      setCustomDirectory("");
      setNewProjectGithubUrl("");
      setShowAddProject(false);
    }
  };

  const handleAddSessionSubmit = (e: React.FormEvent, projectId: string) => {
    e.preventDefault();
    if (newSessionName.trim()) {
      onAddSession(projectId, newSessionName.trim());
      setNewSessionName("");
      setAddingSessionToProjectId(null);
    }
  };

  const toggleSessionCollapse = (sessionId: string) => {
    setCollapsedSessionIds(prev => ({
      ...prev,
      [sessionId]: !prev[sessionId]
    }));
  };

  const handleAddSubSessionSubmit = (e: React.FormEvent, projectId: string, parentSessionId: string) => {
    e.preventDefault();
    if (newSubSessionName.trim()) {
      onAddSession(projectId, newSubSessionName.trim(), parentSessionId);
      setNewSubSessionName("");
      setAddingSubSessionToId(null);
    }
  };

  // Recursive search filtering helper
  const filterSessionsBySearch = (sessions: Session[], query: string): Session[] => {
    if (!query) return sessions;
    const q = query.toLowerCase();
    
    return sessions
      .map((s): Session | null => {
        const selfMatch = s.name.toLowerCase().includes(q) || s.responsible.toLowerCase().includes(q);
        const childMatched = s.subSessions ? filterSessionsBySearch(s.subSessions, query) : [];
        if (selfMatch || childMatched.length > 0) {
          return {
            ...s,
            subSessions: childMatched
          };
        }
        return null;
      })
      .filter((s): s is Session => s !== null);
  };

  // Filter projects/sessions if search is set
  const filteredProjects = projects.map(p => {
    const matchingSessions = filterSessionsBySearch(p.sessions, sidebarSearch);
    return { ...p, sessions: matchingSessions };
  }).filter(p => p.name.toLowerCase().includes(sidebarSearch.toLowerCase()) || p.sessions.length > 0);

  // Recursive formatter to render sessions tree beautifully
  const renderSessionNode = (session: Session, projectId: string, level: number = 1) => {
    const isSelected = session.id === activeSessionId;
    const hasChildren = session.subSessions && session.subSessions.length > 0;
    const isCollapsed = collapsedSessionIds[session.id] || false;

    return (
      <div key={session.id} className="w-full flex flex-col">
        {/* Session header row */}
        <div
          onClick={() => onSelectSession(session.id)}
          style={{ paddingLeft: isSidebarCollapsed ? "8px" : `${level * 16}px` }}
          className={`group flex items-center justify-between p-1.5 rounded-lg cursor-pointer transition ${
            isSelected 
              ? "bg-slate-200 dark:bg-slate-800 text-slate-900 dark:text-white font-semibold shadow-2xs" 
              : "hover:bg-slate-200/50 dark:hover:bg-slate-800/40 text-slate-600 dark:text-slate-300"
          }`}
        >
          <div className="flex items-center space-x-1.5 flex-1 min-w-0">
            {/* Collapse/Expand for parent sub-sessions */}
            {!isSidebarCollapsed && hasChildren ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleSessionCollapse(session.id);
                }}
                className="p-0.5 hover:bg-slate-300/60 rounded text-slate-500 shrink-0 focus:outline-none"
              >
                <ChevronDown className={`w-3 h-3 transition-transform duration-200 ${isCollapsed ? "-rotate-90" : ""}`} />
              </button>
            ) : !isSidebarCollapsed ? (
              <div className="w-4 h-4 shrink-0" />
            ) : null}

            {React.createElement(roleIcon((session as any).roleKey), { className: `w-3.5 h-3.5 shrink-0 ${isSelected ? "text-blue-500" : "text-slate-400"}` })}
            
            {!isSidebarCollapsed && (
              <span className="text-[11.5px] truncate font-sans tracking-tight">
                {session.name}
              </span>
            )}
          </div>

          {isSelected && !isSidebarCollapsed && (
            <div className="w-1.5 h-1.5 bg-blue-500 rounded-full mr-1.5 shrink-0" />
          )}

          {!isSidebarCollapsed && (
            <div className="flex items-center space-x-1.5 shrink-0 select-none">
              {/* Role badge */}
              {session.responsible && (
                <span className="text-[9px] text-slate-400 dark:text-slate-500 font-sans tracking-tight px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800 rounded-md font-medium max-w-[65px] truncate group-hover:opacity-40 transition-opacity">
                  {session.responsible}
                </span>
              )}
              
              {/* Delete button */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Delete session "${session.name}"?`)) {
                    onDeleteSession(projectId, session.id);
                  }
                }}
                className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-red-50 hover:text-red-600 rounded text-slate-400 shrink-0 transition"
                title="Delete Session"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>

        {/* Nested Sub-sessions list */}
        {!isCollapsed && hasChildren && (
          <div className="flex flex-col space-y-0.5 mt-0.5">
            {session.subSessions?.map((child) => renderSessionNode(child, projectId, level + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div 
      className={`bg-slate-50 dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 display flex flex-col transition-all duration-300 ${
        isSidebarCollapsed ? "w-16" : "w-64"
      } h-screen select-none`}
    >
      {/* Sidebar Header */}
      <div className="p-4 border-b border-slate-100 dark:border-slate-800/80 flex items-center justify-between">
        {!isSidebarCollapsed && (
          <div className="flex items-center space-x-2">
            <div className="bg-blue-600 text-white font-black px-2 py-1 rounded text-sm tracking-widest font-sans flex items-center">
              Pi
            </div>
            <span className="font-semibold text-slate-800 dark:text-slate-100 text-sm tracking-tight font-sans">
              Pi Session Manager
            </span>
          </div>
        )}
        <button 
          onClick={onToggleSidebar}
          className="p-1 px-1.5 hover:bg-slate-200/70 text-slate-500 rounded transition ml-auto flex items-center"
          title={isSidebarCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
        >
          {isSidebarCollapsed ? (
            <ChevronRight className="w-4 h-4" />
          ) : (
            <span className="text-xs font-mono font-bold">{"<<"}</span>
          )}
        </button>
      </div>

      {/* New Project Pill Button */}
      <div className="p-3 shrink-0">
        {!isSidebarCollapsed ? (
          <button
            onClick={() => setShowAddProject(true)}
            className="w-full bg-blue-600 hover:bg-blue-700 hover:shadow-sm text-white font-medium py-2 px-4 rounded-xl text-xs flex items-center justify-center space-x-2 transition cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>New Project</span>
          </button>
        ) : (
          <button
            onClick={() => setShowAddProject(true)}
            className="w-8 h-8 mx-auto bg-blue-600 hover:bg-blue-700 text-white rounded-lg flex items-center justify-center transition cursor-pointer"
            title="Create New Project"
          >
            <Plus className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Centered Add Project Dialog Modal */}
      <Modal
        isOpen={showAddProject}
        onClose={() => setShowAddProject(false)}
        title="新建项目 (Create Project)"
        icon={<PlusCircle className="w-4 h-4 text-blue-600 dark:text-blue-400" />}
      >
        <form onSubmit={handleAddProjectSubmit} className="space-y-4">
          {/* Name */}
          <div>
            <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">
              项目名称 <span className="text-red-500">*</span>
            </label>
            <input
              required
              autoFocus
              type="text"
              placeholder="请输入项目名称..."
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 transition placeholder:text-slate-400 dark:placeholder:text-slate-500"
            />
          </div>

          {/* Directory Bindings Selection */}
          <div>
            <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">
              关联到目录 <span className="text-slate-400 dark:text-slate-500 font-normal">(必填)</span>
            </label>
            <select
              value={newProjectDirectory}
              onChange={(e) => setNewProjectDirectory(e.target.value)}
              className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 transition mb-2"
            >
              <option value="/src">/src (源代码库)</option>
              <option value="/src/components">/src/components (组件库)</option>
              <option value="/">/ (根目录)</option>
              <option value="/public">/public (静态资源)</option>
              <option value="/server">/server (后端服务端)</option>
              <option value="其他">其他 / 自定义路径...</option>
            </select>

            {newProjectDirectory === "其他" && (
              <input
                required
                type="text"
                placeholder="请输入自定义关联目录路径 (例如 /src/utils)..."
                value={customDirectory}
                onChange={(e) => setCustomDirectory(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 transition mt-1"
              />
            )}
          </div>

          {/* GitHub Repo Address (Optional) */}
          <div>
            <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">
              GitHub 仓库地址 <span className="text-slate-400 dark:text-slate-500 font-normal">(可选)</span>
            </label>
            <input
              type="url"
              placeholder="https://github.com/your-username/your-repo"
              value={newProjectGithubUrl}
              onChange={(e) => setNewProjectGithubUrl(e.target.value)}
              className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 transition placeholder:text-slate-400 dark:placeholder:text-slate-500"
            />
          </div>

          {/* Action buttons */}
          <div className="flex space-x-2 pt-3 justify-end border-t border-slate-150 dark:border-slate-800">
            <button
              type="button"
              onClick={() => setShowAddProject(false)}
              className="px-3 py-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition"
            >
              取消 (Cancel)
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 rounded-lg shadow-2xs hover:shadow-xs transition cursor-pointer"
            >
              确认创建 (Create)
            </button>
          </div>
        </form>
      </Modal>

      {/* Search Filter input */}
      {!isSidebarCollapsed && (
        <div className="px-3 mb-3 relative">
          <input
            type="text"
            placeholder="Search sessions..."
            value={sidebarSearch}
            onChange={(e) => setSidebarSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-xs border border-slate-200 dark:border-slate-800 rounded-lg focus:outline-none bg-slate-100/60 dark:bg-slate-800/60 focus:bg-white dark:focus:bg-slate-800 text-slate-700 dark:text-slate-200 placeholder:text-slate-400"
          />
          <Search className="w-3.5 h-3.5 absolute left-5.5 top-2.5 text-slate-400 dark:text-slate-500" />
        </div>
      )}

      {/* Project & Session list tree */}
      <div className="flex-1 overflow-y-auto px-2 space-y-1 py-2">
        {filteredProjects.map((project) => {
          const isAddingToThisProject = addingSessionToProjectId === project.id;
          
          return (
            <div key={project.id} className="space-y-0.5">
              {/* Project Header Node */}
              <div 
                className={`group flex items-center justify-between p-1.5 rounded-lg hover:bg-slate-200/50 dark:hover:bg-slate-800/50 text-slate-700 dark:text-slate-300 cursor-pointer ${
                  isSidebarCollapsed ? "justify-center" : ""
                }`}
              >
                <div 
                  className="flex items-center space-x-1.5 flex-1 min-w-0"
                  onClick={() => !isSidebarCollapsed && onToggleProjectCollapse(project.id)}
                >
                  {project.collapsed ? (
                    <ChevronRight className="w-3.5 h-3.5 shrink-0 text-slate-400 dark:text-slate-500" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5 shrink-0 text-slate-400 dark:text-slate-500" />
                  )}
                  
                  {!isSidebarCollapsed ? (
                    <>
                      {project.collapsed ? (
                        <Folder className="w-4 h-4 shrink-0 text-slate-400 dark:text-slate-500" />
                      ) : (
                        <FolderOpen className="w-4 h-4 shrink-0 text-blue-400/80 dark:text-blue-500/80" />
                      )}
                      <div className="flex flex-col min-w-0">
                        <span className="text-xs font-semibold truncate text-slate-700 dark:text-slate-200 leading-tight">
                          {project.name}
                        </span>
                        {(project.directory || project.githubUrl) && (
                          <div className="flex items-center space-x-1.5 mt-0.5">
                            {project.directory && (
                              <span className="text-[9px] bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-800 px-1 rounded font-mono select-none truncate max-w-[120px]" title={`关联目录: ${project.directory}`}>
                                {project.directory}
                              </span>
                            )}
                            {project.githubUrl && (
                              <a
                                href={project.githubUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-[9px] text-slate-400 dark:text-slate-500 hover:text-blue-500 dark:hover:text-blue-400 font-medium truncate max-w-[70px] underline decoration-slate-300"
                                title={`GitHub Repository: ${project.githubUrl}`}
                              >
                                repo
                              </a>
                            )}
                          </div>
                        )}
                      </div>
                    </>
                  ) : (
                    <div title={project.name}>
                      <Folder className="w-4 h-4 text-slate-400" />
                    </div>
                  )}
                </div>

                {!isSidebarCollapsed && (
                  <div className="opacity-0 group-hover:opacity-100 flex items-center space-x-1 pl-1">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setAddingSessionToProjectId(project.id);
                      }}
                      className="p-0.5 hover:bg-slate-200 rounded text-slate-500"
                      title="New Session"
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                    {projects.length > 1 && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Delete project "${project.name}" and its sessions?`)) {
                            onDeleteProject(project.id);
                          }
                        }}
                        className="p-0.5 hover:bg-red-50 hover:text-red-600 rounded text-slate-400"
                        title="Delete Project"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Add Session Inline Form */}
              {!isSidebarCollapsed && isAddingToThisProject && (
                <form 
                  onSubmit={(e) => handleAddSessionSubmit(e, project.id)}
                  className="ml-5 my-1 mr-1 p-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-2xs space-y-1.5"
                >
                  <input
                    autoFocus
                    type="text"
                    placeholder="New session name..."
                    value={newSessionName}
                    onChange={(e) => setNewSessionName(e.target.value)}
                    className="w-full px-2 py-1 text-xs border border-slate-200 dark:border-slate-700 rounded focus:outline-none bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100"
                  />
                  <div className="flex space-x-1.5 justify-end">
                    <button
                      type="button"
                      onClick={() => setAddingSessionToProjectId(null)}
                      className="px-1.5 py-0.5 text-[10px] text-slate-500 dark:text-slate-450 hover:bg-slate-100 dark:hover:bg-slate-700 rounded"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="px-2 py-0.5 text-[10px] bg-blue-600 text-white hover:bg-blue-700 rounded"
                    >
                      Create
                    </button>
                  </div>
                </form>
              )}

              {/* Sessions Nodes */}
              {!project.collapsed && (
                <div className={`${isSidebarCollapsed ? "space-y-1" : "space-y-0.5 ml-1"}`}>
                  {project.sessions.map((session) => renderSessionNode(session, project.id, 1))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Logout & Settings Footer */}
      <div className="p-3 border-t border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-900/60 flex flex-col space-y-2">
        <div className="flex items-center justify-between">
          <button
            onClick={onLogout}
            className={`flex items-center space-x-1.5 hover:bg-slate-200 dark:hover:bg-slate-800 p-1.5 rounded-lg text-slate-600 dark:text-slate-350 transition text-[11.5px] font-sans ${
              isSidebarCollapsed ? "justify-center w-full" : "pr-3"
            }`}
          >
            <LogOut className="w-4 h-4 text-slate-500 dark:text-slate-400" />
            {!isSidebarCollapsed && <span>Logout</span>}
          </button>

          {!isSidebarCollapsed && (
            <button
              onClick={onOpenSettings}
              className="p-1.5 hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 rounded-lg transition"
              title="System Controls"
            >
              <Settings className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
