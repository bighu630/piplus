import React, { useState, useEffect } from "react";
import Sidebar from "./components/Sidebar";
import TabChat from "./components/TabChat";
import TabSessionInfo from "./components/TabSessionInfo";
import TabGitDiff from "./components/TabGitDiff";
import Modal from "./components/Modal";
import { Message, Session, Project, FileItem } from "./types";
import { 
  Sparkles, 
  Terminal, 
  HelpCircle, 
  Settings, 
  User, 
  ShieldCheck, 
  LogOut,
  FolderOpen,
  Archive,
  ChevronDown,
  Wrench,
  X
} from "lucide-react";

export default function App() {
  // Mock login user
  const [userEmail, setUserEmail] = useState("bighunb666@gmail.com");
  const [isLoggedIn, setIsLoggedIn] = useState(true);

  // Layout states
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [activeTab, setActiveTab] = useState<"chat" | "info" | "diff">("chat");
  const [isGenerating, setIsGenerating] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      const saved = localStorage.getItem("pi-workspace-theme");
      return (saved === "dark" || saved === "light") ? saved : "light";
    } catch (_) {
      return "light";
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("pi-workspace-theme", theme);
    } catch (_) {}
  }, [theme]);

  // Initialize beautiful mock project and session hierarchy as requested in the screenshot
  const [projects, setProjects] = useState<Project[]>([
    {
      id: "proj-alpha",
      name: "Project Alpha",
      collapsed: false,
      directory: "/src",
      githubUrl: "https://github.com/google/ai-studio",
      sessions: [
        {
          id: "session-a",
          name: "Session A",
          responsible: "Junior Dev Group",
          model: "Gemini 2.5 Flash",
          status: "Archived",
          tags: ["Archived", "Initial Setup"],
          description: "Configured target environments and initialized base container structures for project alpha deployment on Cloud Run.",
          files: [
            { id: "f-1", name: "package.json", size: "1.2 KB", type: "json" },
            { id: "f-2", name: "Dockerfile", size: "310 B", type: "dockerfile" }
          ],
          messages: [
            { id: "m-a1", role: "user", content: "Is the Docker container building correctly?", timestamp: "6/21/2026, 3:12:00 PM" },
            { id: "m-a2", role: "assistant", content: "Yes! The Docker container builds smoothly porting over target files on standard base Alpine templates.", timestamp: "6/21/2026, 3:12:30 PM" }
          ],
          gitDiffText: ""
        },
        {
          id: "session-b",
          name: "Session B",
          responsible: "负责人",
          model: "Claude 3.5 Sonnet",
          status: "Active",
          tags: ["Development", "State Engine", "Core UI"],
          description: "Active modular session focused on creating interactive React elements, maintaining context scope trees, and optimizing key state variables.",
          files: [
            { id: "f-3", name: "src/App.tsx", size: "4.8 KB", type: "typescript" },
            { id: "f-4", name: "src/components/Sidebar.tsx", size: "8.1 KB", type: "typescript" }
          ],
          messages: [
            { 
              id: "m-b1", 
              role: "user", 
              content: "How do I use the session object?", 
              timestamp: "6/21/2026, 6:30:12 PM" 
            },
            { 
              id: "m-b2", 
              role: "assistant", 
              content: `You can access session properties like \`session.id\` and \`session.status\`. Here is an example snippet:\n\n\`\`\`javascript\nconst session = default1 () => {\n    const session.id = session.session.id';\n    return session.status = new 'session.status';\n};\n\nexport object.function(() => {\n    console.logfanttsin('Here 'session B1 ...\")\n});\n\`\`\``, 
              timestamp: "6/21/2026, 6:31:05 PM" 
            }
          ],
          gitDiffText: `diff --git a/src/types.ts b/src/types.ts
index b82f10b..e2df401 100644
--- a/src/types.ts
+++ b/src/types.ts
@@ -10,3 +10,12 @@ export interface Message {
 export interface Session {
   id: string;
   name: string;
+  responsible: string;
+  model: string;
+  status: "Active" | "Archived" | "Draft";
+  messages: Message[];
+  files: FileItem[];
+  description: string;
+  tags: string[];
+  gitDiffText?: string;
 }`
         },
         {
           id: "session-b1",
           name: "Sub-session B1",
           responsible: "负责人在Sub",
           model: "Claude 3.5 Sonnet",
           status: "Active",
           tags: ["Deployment"],
           description: "Nested secondary sub-module associated with deployment tests.",
           files: [],
           messages: [],
           gitDiffText: ""
         }
       ]
     },
     {
       id: "proj-beta",
       name: "Project Beta",
       collapsed: true,
       sessions: []
     }
   ]);

  // Helper to find a session recursively inside tree
  const findSessionRecursive = (sessions: Session[], id: string): Session | undefined => {
    for (const s of sessions) {
      if (s.id === id) return s;
      if (s.subSessions && s.subSessions.length > 0) {
        const found = findSessionRecursive(s.subSessions, id);
        if (found) return found;
      }
    }
    return undefined;
  };

  // Helper to map/update a session recursively
  const mapSessionsRecursive = (sessions: Session[], id: string, mapper: (s: Session) => Session): Session[] => {
    return sessions.map(s => {
      if (s.id === id) {
        return mapper(s);
      }
      if (s.subSessions && s.subSessions.length > 0) {
        return {
          ...s,
          subSessions: mapSessionsRecursive(s.subSessions, id, mapper)
        };
      }
      return s;
    });
  };

  // Helper to delete session recursively
  const filterSessionsRecursive = (sessions: Session[], idToDelete: string): Session[] => {
    return sessions
      .filter(s => s.id !== idToDelete)
      .map(s => {
        if (s.subSessions && s.subSessions.length > 0) {
          return {
            ...s,
            subSessions: filterSessionsRecursive(s.subSessions, idToDelete)
          };
        }
        return s;
      });
  };

  // Helper to append subsession recursively
  const addSubSessionRecursive = (sessions: Session[], parentId: string, newSub: Session): Session[] => {
    return sessions.map(s => {
      if (s.id === parentId) {
        return {
          ...s,
          subSessions: [...(s.subSessions || []), newSub]
        };
      }
      if (s.subSessions && s.subSessions.length > 0) {
        return {
          ...s,
          subSessions: addSubSessionRecursive(s.subSessions, parentId, newSub)
        };
      }
      return s;
    });
  };

  const [activeSessionId, setActiveSessionId] = useState<string>("session-b");

  // Helper to get active session
  let activeSession: Session | undefined;
  let activeProjectId: string | undefined;

  for (const proj of projects) {
    const s = findSessionRecursive(proj.sessions, activeSessionId);
    if (s) {
      activeSession = s;
      activeProjectId = proj.id;
      break;
    }
  }

  // Fallback if none found
  if (!activeSession && projects[0]?.sessions) {
    const s = findSessionRecursive(projects[0].sessions, "session-b");
    if (s) {
      activeSession = s;
      activeProjectId = projects[0].id;
    } else if (projects[0].sessions[0]) {
      activeSession = projects[0].sessions[0];
      activeProjectId = projects[0].id;
    }
  }

  // Active handlers
  const handleSelectSession = (sessionId: string) => {
    setActiveSessionId(sessionId);
  };

  const handleToggleSidebar = () => {
    setIsSidebarCollapsed(!isSidebarCollapsed);
  };

  // Add new project
  const handleAddProject = (name: string, directory?: string, githubUrl?: string) => {
    const newProject: Project = {
      id: `proj-${Math.random().toString(36).substr(2, 9)}`,
      name,
      collapsed: false,
      sessions: [],
      directory: directory || "未绑定",
      githubUrl: githubUrl || ""
    };
    setProjects([...projects, newProject]);
  };

  // Add new session to project
  const handleAddSession = (projectId: string, name: string, parentSessionId?: string) => {
    const newSession: Session = {
      id: `session-${Math.random().toString(36).substr(2, 9)}`,
      name,
      responsible: "负责人",
      model: activeSession ? activeSession.model : "Claude 3.5 Sonnet",
      status: "Active",
      messages: [],
      files: [],
      description: "A newly created live development session.",
      tags: ["Draft"],
      gitDiffText: ""
    };

    setProjects(projects.map(proj => {
      if (proj.id === projectId) {
        if (parentSessionId) {
          return {
            ...proj,
            collapsed: false,
            sessions: addSubSessionRecursive(proj.sessions, parentSessionId, newSession)
          };
        } else {
          return {
            ...proj,
            collapsed: false,
            sessions: [...proj.sessions, newSession]
          };
        }
      }
      return proj;
    }));

    setActiveSessionId(newSession.id);
  };

  // Delete session
  const handleDeleteSession = (projectId: string, sessionId: string) => {
    setProjects(projects.map(proj => {
      if (proj.id === projectId) {
        return {
          ...proj,
          sessions: filterSessionsRecursive(proj.sessions, sessionId)
        };
      }
      return proj;
    }));

    // Reset focus
    if (activeSessionId === sessionId) {
      setActiveSessionId("");
    }
  };

  // Delete project
  const handleDeleteProject = (projectId: string) => {
    setProjects(projects.filter(proj => proj.id !== projectId));
  };

  // Toggle Collapse
  const handleToggleProjectCollapse = (projectId: string) => {
    setProjects(projects.map(proj => 
      proj.id === projectId ? { ...proj, collapsed: !proj.collapsed } : proj
    ));
  };

  // Archive Current Active Session
  const handleArchiveCurrentSession = () => {
    if (!activeSession) return;
    const updatedStatus = activeSession.status === "Archived" ? "Active" : "Archived";
    
    setProjects(projects.map(proj => ({
      ...proj,
      sessions: mapSessionsRecursive(proj.sessions, activeSessionId, s => ({
        ...s,
        status: updatedStatus
      }))
    })));
  };

  // Update Model Selectors
  const handleModelChange = (modelName: string) => {
    if (!activeSession) return;
    setProjects(projects.map(proj => ({
      ...proj,
      sessions: mapSessionsRecursive(proj.sessions, activeSessionId, s => ({
        ...s,
        model: modelName
      }))
    })));
  };

  // Send Chat message (Triggers real server-side proxy Gemini processing via high-speed WebSocket stream)
  const handleSendMessage = async (userText: string) => {
    if (!activeSession || isGenerating) return;

    // 1. Create and attach user message locally
    const userMsg: Message = {
      id: `msg-${Date.now()}-u`,
      role: "user",
      content: userText,
      timestamp: new Date().toLocaleTimeString()
    };

    const currentMessages = [...activeSession.messages, userMsg];

    // 2. Prepare empty assistant message for streaming chunks
    const assistantMsgId = `msg-${Date.now()}-a`;
    const initialAssistantMsg: Message = {
      id: assistantMsgId,
      role: "assistant",
      content: "",
      timestamp: new Date().toLocaleTimeString()
    };

    // Optimistically update conversation locally with user and placeholder assistant message
    const currentMessagesWithAssistant = [...currentMessages, initialAssistantMsg];
    setProjects(prevProjects => prevProjects.map(proj => ({
      ...proj,
      sessions: mapSessionsRecursive(proj.sessions, activeSessionId, s => ({
        ...s,
        messages: currentMessagesWithAssistant
      }))
    })));

    setIsGenerating(true);
    setGlobalError(null);

    let accumulatedContent = "";
    let receivedAnyChunks = false;

    const triggerLocalFallback = () => {
      const fallbackContent = `I received your command: "${userText}".\n\nI can assist with workspace configuration, directory alignment, and code design. Let me know if you want me to update our project or Git tab schemas.\n\n*Note: Add your GEMINI_API_KEY inside your Secrets setting panel on the right side if you want full AI responses.*`;
      
      setProjects(prevProjects => prevProjects.map(proj => ({
        ...proj,
        sessions: mapSessionsRecursive(proj.sessions, activeSessionId, s => ({
          ...s,
          messages: s.messages.map(m => m.id === assistantMsgId ? { ...m, content: fallbackContent } : m)
        }))
      })));
      setIsGenerating(false);
    };

    try {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws";
      const wsUrl = `${protocol}//${window.location.host}/api/ws`;
      const socket = new WebSocket(wsUrl);

      // Save socket globally or in window so we can close it if user cancels
      (window as any)._activeWs = socket;

      socket.onopen = () => {
        socket.send(JSON.stringify({
          type: "chat",
          messages: currentMessages,
          model: activeSession.model,
          systemInstruction: "You are Pi AI, a highly smart development partner. When asked to write code snippets, please provide highly clean code formatted inside markdown code blocks (using three backticks) so that copy features work. Help explain key architecture details clearly."
        }));
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "chunk") {
            receivedAnyChunks = true;
            accumulatedContent += data.text;
            
            setProjects(prevProjects => prevProjects.map(proj => ({
              ...proj,
              sessions: mapSessionsRecursive(proj.sessions, activeSessionId, s => ({
                ...s,
                messages: s.messages.map(m => m.id === assistantMsgId ? { ...m, content: accumulatedContent } : m)
              }))
            })));
          } else if (data.type === "done") {
            setIsGenerating(false);
            socket.close();
            (window as any)._activeWs = null;
          } else if (data.type === "error") {
            throw new Error(data.message || "WebSocket API Error");
          }
        } catch (err) {
          console.error("Error parsing WS packet:", err);
        }
      };

      socket.onerror = (err) => {
        console.warn("WebSocket stream error, falling back:", err);
        if (!receivedAnyChunks) {
          triggerLocalFallback();
        } else {
          setIsGenerating(false);
        }
      };

      socket.onclose = () => {
        setIsGenerating(false);
        (window as any)._activeWs = null;
      };

    } catch (err: any) {
      console.warn("Express WebSocket unavailable. Gracefully fallback with local intelligence response:", err);
      triggerLocalFallback();
    }
  };

  // Attach File from file attachment selector
  const handleAttachFile = (file: FileItem) => {
    if (!activeSession) return;
    setProjects(projects.map(proj => ({
      ...proj,
      sessions: mapSessionsRecursive(proj.sessions, activeSessionId, s => ({
        ...s,
        files: [...s.files, file]
      }))
    })));
  };

  // Dettach file
  const handleDettachFile = (fileId: string) => {
    if (!activeSession) return;
    setProjects(projects.map(proj => ({
      ...proj,
      sessions: mapSessionsRecursive(proj.sessions, activeSessionId, s => ({
        ...s,
        files: s.files.filter(f => f.id !== fileId)
      }))
    })));
  };

  // Stop Generation
  const handleStopGeneration = () => {
    setIsGenerating(false);
    if ((window as any)._activeWs) {
      try {
        (window as any)._activeWs.close();
      } catch (e) {}
      (window as any)._activeWs = null;
    }
  };

  // Update session metadata (Info panel)
  const handleUpdateSessionMeta = (updates: Partial<Session>) => {
    if (!activeSession) return;
    setProjects(projects.map(proj => ({
      ...proj,
      sessions: mapSessionsRecursive(proj.sessions, activeSessionId, s => ({
        ...s,
        ...updates
      }))
    })));
  };

  // Add Tag
  const handleAddTag = (tag: string) => {
    if (!activeSession) return;
    if (activeSession.tags.includes(tag)) return;
    setProjects(projects.map(proj => ({
      ...proj,
      sessions: mapSessionsRecursive(proj.sessions, activeSessionId, s => ({
        ...s,
        tags: [...s.tags, tag]
      }))
    })));
  };

  // Remove Tag
  const handleRemoveTag = (tag: string) => {
    if (!activeSession) return;
    setProjects(projects.map(proj => ({
      ...proj,
      sessions: mapSessionsRecursive(proj.sessions, activeSessionId, s => ({
        ...s,
        tags: s.tags.filter(t => t !== tag)
      }))
    })));
  };

  // Generate Git Diff dynamically via Server Gemini API
  const handleGenerateDiff = async () => {
    if (!activeSession || isGenerating) return;
    setIsGenerating(true);
    setGlobalError(null);

    try {
      const response = await fetch("/api/generate-diff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: activeSession.messages,
          sessionName: activeSession.name
        })
      });

      if (!response.ok) {
        throw new Error("Unable to contact backend engine.");
      }

      const body = await response.json();
      setProjects(prevProjects => prevProjects.map(proj => ({
        ...proj,
        sessions: mapSessionsRecursive(proj.sessions, activeSessionId, s => ({
          ...s,
          gitDiffText: body.diff
        }))
      })));
    } catch (err) {
      console.warn("Backend unavailable. Fallback to sample diff:", err);
      
      const fallbackDiff = `diff --git a/src/App.tsx b/src/App.tsx
index df923aa..e31aaef 100644
--- a/src/App.tsx
+++ b/src/App.tsx
@@ -12,4 +12,11 @@
+  // Added dynamic state handling for visual updates
+  const [checkedElements, setCheckedElements] = useState<string[]>([]);
+  const onCheckEvent = (id: string) => {
+    setCheckedElements([...checkedElements, id]);
+  };
+`;

      setProjects(prevProjects => prevProjects.map(proj => ({
        ...proj,
        sessions: mapSessionsRecursive(proj.sessions, activeSessionId, s => ({
          ...s,
          gitDiffText: fallbackDiff
        }))
      })));
    } finally {
      setIsGenerating(false);
    }
  };

  // Run AI Session Info Analysis & Updater via server API
  const handleRunSessionAnalysis = async () => {
    if (!activeSession || isGenerating) return;
    setIsGenerating(true);
    setGlobalError(null);

    try {
      const response = await fetch("/api/analyze-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: activeSession.messages,
          sessionName: activeSession.name
        })
      });

      if (!response.ok) {
        throw new Error("Backend offline.");
      }

      const body = await response.json();
      setProjects(prevProjects => prevProjects.map(proj => ({
        ...proj,
        sessions: mapSessionsRecursive(proj.sessions, activeSessionId, s => ({
          ...s, 
          description: body.description,
          responsible: body.suggestedResponsible || s.responsible,
          tags: Array.from(new Set([...s.tags, ...body.keyTasks.slice(0, 2)]))
        }))
      })));
    } catch (err) {
      const fallbackDescription = "Analyzed conversation flow: Client queried code templates concerning state handling parameters. The session was resolved by suggesting named exports in vanilla ECMAScript environments.";
      setProjects(prevProjects => prevProjects.map(proj => ({
        ...proj,
        sessions: mapSessionsRecursive(proj.sessions, activeSessionId, s => ({
          ...s,
          description: fallbackDescription
        }))
      })));
    } finally {
      setIsGenerating(false);
    }
  };

  // Auth logout / login toggle
  const handleLogoutToggle = () => {
    if (isLoggedIn) {
      setIsLoggedIn(false);
    } else {
      setIsLoggedIn(true);
    }
  };

  // System modal configs
  const handleSaveSettings = (e: React.FormEvent) => {
    e.preventDefault();
    setShowSettings(false);
  };

  return (
    <div className={`flex h-screen w-screen overflow-hidden bg-slate-100 dark:bg-slate-950 text-slate-800 dark:text-slate-100 font-sans antialiased ${theme}`}>
      {isLoggedIn ? (
        <>
          {/* SIDEBAR TREE NODE */}
          <Sidebar
            projects={projects}
            activeSessionId={activeSessionId}
            isSidebarCollapsed={isSidebarCollapsed}
            onSelectSession={handleSelectSession}
            onToggleSidebar={handleToggleSidebar}
            onAddProject={handleAddProject}
            onAddSession={handleAddSession}
            onDeleteSession={handleDeleteSession}
            onDeleteProject={handleDeleteProject}
            onToggleProjectCollapse={handleToggleProjectCollapse}
            onOpenSettings={() => setShowSettings(true)}
            onLogout={handleLogoutToggle}
          />

          {/* MAIN DYNAMIC CONTENT */}
          <div className="flex-1 flex flex-col h-full bg-white dark:bg-slate-900 relative">
            {/* Top Navigation Row */}
            <header className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-6 py-2 shrink-0 flex flex-wrap items-center justify-between select-none">
              
              {/* Left hand tabs switch */}
              <div className="flex space-x-1 border-b border-transparent">
                <button
                  onClick={() => setActiveTab("chat")}
                  className={`px-4 py-2 text-sm font-semibold transition border-b-2 rounded-t-lg cursor-pointer ${
                    activeTab === "chat"
                      ? "border-blue-600 text-slate-900 dark:text-slate-100 bg-slate-50 dark:bg-slate-800"
                      : "border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
                  }`}
                >
                  Chat
                </button>
                <button
                  onClick={() => setActiveTab("info")}
                  className={`px-4 py-2 text-sm font-semibold transition border-b-2 rounded-t-lg cursor-pointer ${
                    activeTab === "info"
                      ? "border-blue-600 text-slate-900 dark:text-slate-100 bg-slate-50 dark:bg-slate-800"
                      : "border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
                  }`}
                >
                  Session Info
                </button>
                <button
                  onClick={() => setActiveTab("diff")}
                  className={`px-4 py-2 text-sm font-semibold transition border-b-2 rounded-t-lg cursor-pointer ${
                    activeTab === "diff"
                      ? "border-blue-600 text-slate-900 dark:text-slate-100 bg-slate-50 dark:bg-slate-800"
                      : "border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
                  }`}
                >
                  Git Diff
                </button>
              </div>

              {/* Right hand dynamic controls - Archive button and Model Dropdown selector */}
              {activeSession && (
                <div className="flex items-center space-x-3 py-1">
                  <h1 className="text-slate-800 dark:text-slate-100 font-bold text-base mr-4 font-sans leading-none">
                    {activeSession.name} - <span className="opacity-75 font-normal text-sm text-slate-600 dark:text-slate-400">{activeSession.responsible}</span>
                  </h1>

                  <button
                    onClick={handleArchiveCurrentSession}
                    className="flex items-center space-x-1 px-3 py-1.5 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-300 transition cursor-pointer"
                  >
                    <Archive className="w-3.5 h-3.5" />
                    <span>{activeSession.status === "Archived" ? "Unarchive" : "Archive"}</span>
                  </button>

                  <div className="relative">
                    <select
                      value={activeSession.model}
                      onChange={(e) => handleModelChange(e.target.value)}
                      className="appearance-none bg-slate-50 dark:bg-slate-800 border border-slate-250 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-xl px-3 py-1.5 pr-8 text-xs font-semibold text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer"
                    >
                      <option value="Claude 3.5 Sonnet">🤖 Claude 3.5 Sonnet</option>
                      <option value="Gemini 2.5 Flash">🪐 Gemini 2.5 Flash</option>
                      <option value="DeepSeek Coder M">🧩 DeepSeek Coder M</option>
                    </select>
                    <ChevronDown className="w-3.5 h-3.5 absolute right-2.5 top-2.5 pointer-events-none text-slate-500" />
                  </div>
                </div>
              )}
            </header>

            {/* Dynamic tabs mount */}
            <div className="flex-1 overflow-hidden relative">
              {activeSession ? (
                <>
                  {activeTab === "chat" && (
                    <TabChat
                      activeSession={activeSession}
                      isGenerating={isGenerating}
                      onSendMessage={handleSendMessage}
                      onAttachFile={handleAttachFile}
                      onDettachFile={handleDettachFile}
                      onStopGeneration={handleStopGeneration}
                    />
                  )}

                  {activeTab === "info" && (
                    <TabSessionInfo
                      activeSession={activeSession}
                      isGenerating={isGenerating}
                      onUpdateSessionMeta={handleUpdateSessionMeta}
                      onAddTag={handleAddTag}
                      onRemoveTag={handleRemoveTag}
                      onRunSessionAnalysis={handleRunSessionAnalysis}
                    />
                  )}

                  {activeTab === "diff" && (
                    <TabGitDiff
                      activeSession={activeSession}
                      isGenerating={isGenerating}
                      onGenerateDiff={handleGenerateDiff}
                    />
                  )}
                </>
              ) : (
                <div className="h-full flex flex-col items-center justify-center p-8 bg-slate-50 dark:bg-slate-900/40">
                  <div className="text-center space-y-2">
                    <h2 className="text-base font-bold text-slate-700 dark:text-slate-300">No session selected</h2>
                    <p className="text-xs text-slate-400 dark:text-slate-500">Select or create a new session in the Sidebar to begin tracking code edits.</p>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Settings Modal Dialog overlay */}
          <Modal
            isOpen={showSettings}
            onClose={() => setShowSettings(false)}
            title="Pi Workspace Controls"
            icon={<Settings className="w-4 h-4 text-slate-500 dark:text-slate-400" />}
          >
            <form onSubmit={handleSaveSettings} className="space-y-4">
              <div>
                <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">Developer Identity (Email)</label>
                <input
                  type="email"
                  value={userEmail}
                  onChange={(e) => setUserEmail(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-800 dark:text-slate-100 rounded-lg focus:outline-none"
                />
              </div>

              {/* Dark Mode switcher button array preset */}
              <div>
                <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">Color Theme Preset</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    id="theme-light-btn"
                    onClick={() => setTheme("light")}
                    className={`px-3 py-2 text-xs border rounded-lg font-semibold transition flex items-center justify-center space-x-1.5 cursor-pointer ${
                      theme === "light"
                        ? "bg-blue-50 dark:bg-slate-800 border-blue-500 text-blue-600 dark:text-blue-400"
                        : "border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800"
                    }`}
                  >
                    <span>☀️</span>
                    <span>Light Mode</span>
                  </button>
                  <button
                    type="button"
                    id="theme-dark-btn"
                    onClick={() => setTheme("dark")}
                    className={`px-3 py-2 text-xs border rounded-lg font-semibold transition flex items-center justify-center space-x-1.5 cursor-pointer ${
                      theme === "dark"
                        ? "bg-slate-800 dark:bg-blue-950/40 border-blue-500 text-blue-400 dark:text-blue-400"
                        : "border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800"
                    }`}
                  >
                    <span>🌙</span>
                    <span>Dark Mode</span>
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">Target Hosting Container Port</label>
                <input
                  type="text"
                  disabled
                  value="Port 3000 (Active Proxy Router)"
                  className="w-full px-3 py-2 text-xs border border-slate-200 dark:border-slate-800 rounded-lg bg-slate-50 dark:bg-slate-950 text-slate-500 dark:text-slate-600 cursor-not-allowed font-mono"
                />
              </div>
              <div className="flex flex-col space-y-2 pt-2 text-[11px] text-slate-400 dark:text-slate-400 font-mono leading-normal bg-slate-50 dark:bg-slate-900 p-3 rounded-xl border border-slate-150 dark:border-slate-800/80">
                <div className="flex items-center space-x-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-green-600 dark:text-green-500" />
                  <span className="font-semibold text-slate-600 dark:text-slate-400">Proxy Shield: Active</span>
                </div>
                <span className="text-slate-500 dark:text-slate-400">All external requests of connected LLM engines route securely through node processes to guarantee strict browser privacy.</span>
              </div>

              <div className="flex space-x-2 justify-end pt-2">
                <button
                  type="button"
                  onClick={() => setShowSettings(false)}
                  className="px-3 py-1.5 text-xs text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md font-medium"
                >
                  Dismiss
                </button>
                <button
                  type="submit"
                  className="px-3.5 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-md transition"
                >
                  Apply Shifts
                </button>
              </div>
            </form>
          </Modal>
        </>
      ) : (
        <div className="flex-1 h-screen flex flex-col items-center justify-center p-8 bg-slate-50">
          <div className="bg-white border border-slate-200 rounded-2xl shadow-md p-8 text-center max-w-sm space-y-6">
            <div className="flex flex-col items-center space-y-2">
              <div className="bg-blue-600 text-white font-black px-3 py-1.5 rounded-lg text-lg tracking-widest font-sans flex items-center justify-center">
                Pi
              </div>
              <h2 className="font-bold text-lg text-slate-800 tracking-tight">Pi Session Manager</h2>
              <p className="text-xs text-slate-500 max-w-[260px] leading-relaxed">
                Connect your workspace sessions and synchronize secure code patches with model workflows.
              </p>
            </div>

            <div className="text-left bg-slate-50 p-4 rounded-xl border border-slate-150 font-sans space-y-3">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Confirm Identity</span>
              <div className="text-xs font-semibold text-slate-700 truncate">{userEmail}</div>
            </div>

            <button
              onClick={() => setIsLoggedIn(true)}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2.5 rounded-xl text-sm transition"
            >
              Access Manager Workspace
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
