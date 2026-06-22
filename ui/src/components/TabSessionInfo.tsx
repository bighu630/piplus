import React, { useState } from "react";
import { Session, FileItem } from "../types";
import { 
  Activity, 
  User, 
  Cpu, 
  Clock, 
  CheckCircle, 
  FolderPlus, 
  Edit, 
  Trash2, 
  X, 
  Plus,
  FileCode,
  Tag,
  AlertCircle,
  TrendingUp,
  Zap
} from "lucide-react";

interface TabSessionInfoProps {
  activeSession: Session;
  isGenerating: boolean;
  onUpdateSessionMeta: (updates: Partial<Session>) => void;
  onAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
  onRunSessionAnalysis: () => void;
}

export default function TabSessionInfo({
  activeSession,
  isGenerating,
  onUpdateSessionMeta,
  onAddTag,
  onRemoveTag,
  onRunSessionAnalysis
}: TabSessionInfoProps) {
  const [isEditingResp, setIsEditingResp] = useState(false);
  const [responsibleInput, setResponsibleInput] = useState(activeSession.responsible);
  const [newTagInput, setNewTagInput] = useState("");
  const [showAddTag, setShowAddTag] = useState(false);

  // Suggested check list items based on active session status
  const [checklist, setChecklist] = useState<Array<{ id: string; text: string; done: boolean }>>([
    { id: "1", text: "Validate runtime environment variables", done: true },
    { id: "2", text: "Verify Gemini API server proxy configuration", done: true },
    { id: "3", text: "Conduct modular security audit on code modifications", done: false },
    { id: "4", text: "Draft unit tests for newly registered module endpoints", done: false }
  ]);

  const toggleChecklist = (id: string) => {
    setChecklist(checklist.map(item => item.id === id ? { ...item, done: !item.done } : item));
  };

  const handleRespSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (responsibleInput.trim()) {
      onUpdateSessionMeta({ responsible: responsibleInput.trim() });
      setIsEditingResp(false);
    }
  };

  const handleAddTagSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (newTagInput.trim()) {
      onAddTag(newTagInput.trim());
      setNewTagInput("");
      setShowAddTag(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto bg-slate-50 dark:bg-slate-900/10 p-6 space-y-6">
      
      {/* Session Summary Header Card */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-2xs space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-400 px-3 py-1 rounded-full text-xs font-semibold select-none">
            <Activity className="w-3.5 h-3.5" />
            <span>Active Session Overview</span>
          </div>
          
          <button
            onClick={onRunSessionAnalysis}
            disabled={isGenerating}
            className="flex items-center space-x-1.5 px-3 py-1.5 bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200/50 dark:border-indigo-900 rounded-xl text-indigo-600 dark:text-indigo-400 font-semibold hover:bg-indigo-100/70 dark:hover:bg-indigo-900 disabled:opacity-50 text-xs transition-all cursor-pointer"
          >
            <Zap className="w-3.5 h-3.5 shrink-0" />
            <span>Refine Summary with AI</span>
          </button>
        </div>

        <div>
          <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100 font-sans tracking-tight">
            {activeSession.name}
          </h2>
          <p className="text-slate-600 dark:text-slate-400 text-sm mt-2 leading-relaxed">
            {activeSession.description || "No full session summary compiled. Use the 'Refine Summary with AI' button or send comments in the chat to automatically summarize priorities."}
          </p>
        </div>

         {/* Highlight Meta Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
          
          {/* Owner / Responsible */}
          <div className="bg-slate-50 dark:bg-slate-800 border border-slate-150 dark:border-slate-800 rounded-xl p-4 space-y-2">
            <div className="flex items-center justify-between text-slate-400">
              <span className="text-[11px] font-bold uppercase tracking-wider">Responsible Person</span>
              <User className="w-3.5 h-3.5" />
            </div>
            
            {isEditingResp ? (
              <form onSubmit={handleRespSubmit} className="flex items-center space-x-1.5">
                <input
                  autoFocus
                  type="text"
                  value={responsibleInput}
                  onChange={(e) => setResponsibleInput(e.target.value)}
                  className="px-2 py-1 text-xs border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none bg-white dark:bg-slate-900 w-full text-slate-800 dark:text-slate-100"
                />
                <button type="submit" className="p-1 hover:bg-slate-200 dark:hover:bg-slate-700 rounded text-green-600">✓</button>
                <button type="button" onClick={() => setIsEditingResp(false)} className="p-1 hover:bg-slate-200 dark:hover:bg-slate-700 rounded text-slate-400">×</button>
              </form>
            ) : (
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                  {activeSession.responsible || "Not assigned"}
                </span>
                <button 
                  onClick={() => {
                    setResponsibleInput(activeSession.responsible);
                    setIsEditingResp(true);
                  }}
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center p-0.5 cursor-pointer"
                >
                  <Edit className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>

          {/* Connected Model */}
          <div className="bg-slate-50 dark:bg-slate-800 border border-slate-150 dark:border-slate-800 rounded-xl p-4 space-y-2 select-none">
            <div className="flex items-center justify-between text-slate-400">
              <span className="text-[11px] font-bold uppercase tracking-wider">Contextual LLM</span>
              <Cpu className="w-3.5 h-3.5" />
            </div>
            <div className="text-sm font-semibold text-slate-800 dark:text-slate-200 truncate">
              {activeSession.model}
            </div>
          </div>

          {/* Session Lifecycle status */}
          <div className="bg-slate-50 dark:bg-slate-800 border border-slate-150 dark:border-slate-800 rounded-xl p-4 space-y-2">
            <div className="flex items-center justify-between text-slate-400">
              <span className="text-[11px] font-bold uppercase tracking-wider">Status Node</span>
              <Clock className="w-3.5 h-3.5" />
            </div>
            <div className="flex items-center justify-between">
              <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                activeSession.status === "Active" 
                  ? "bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-150 dark:border-emerald-900/50 text-emerald-700 dark:text-emerald-400"
                  : activeSession.status === "Archived"
                  ? "bg-amber-50 dark:bg-amber-950/20 border border-amber-150 dark:border-amber-900/50 text-amber-700 dark:text-amber-400"
                  : "bg-slate-150 dark:bg-slate-800 text-slate-600 dark:text-slate-400"
              }`}>
                {activeSession.status}
              </span>
              <select
                value={activeSession.status}
                onChange={(e) => onUpdateSessionMeta({ status: e.target.value as any })}
                className="text-[11px] text-blue-600 dark:text-blue-400 border-none bg-transparent hover:underline focus:outline-none cursor-pointer outline-none"
              >
                <option value="Active">Active</option>
                <option value="Archived">Archived</option>
                <option value="Draft">Draft</option>
              </select>
            </div>
          </div>

        </div>
      </div>

      {/* Checklist & Files Grid layouts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        
        {/* Left column: Action Milestones Checklist */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-2xs space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
            <h3 className="font-bold text-slate-800 dark:text-slate-200 text-sm tracking-tight flex items-center space-x-1.5">
              <CheckCircle className="w-4 h-4 text-blue-500" />
              <span>Session Milestones Checklist</span>
            </h3>
            <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded">
              {checklist.filter(c => c.done).length}/{checklist.length} Done
            </span>
          </div>

          <div className="space-y-3">
            {checklist.map((item) => (
              <div 
                key={item.id} 
                onClick={() => toggleChecklist(item.id)}
                className={`flex items-start space-x-3 p-2.5 rounded-xl border border-transparent hover:bg-slate-50 dark:hover:bg-slate-800 hover:border-slate-150 dark:hover:border-slate-700/60 transition cursor-pointer select-none`}
              >
                <input 
                  type="checkbox"
                  checked={item.done}
                  readOnly
                  className="mt-0.5 h-4 w-4 text-blue-600 rounded focus:ring-blue-500 border-slate-300 dark:border-slate-700 pointer-events-none"
                />
                <span className={`text-xs text-slate-700 dark:text-slate-300 leading-normal ${item.done ? "line-through text-slate-400 dark:text-slate-500" : ""}`}>
                  {item.text}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Right column: Scope Files & Core Tags */}
        <div className="space-y-6">
          
          {/* Active scope files */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-2xs space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3 select-none">
              <h3 className="font-bold text-slate-800 dark:text-slate-200 text-sm tracking-tight flex items-center space-x-1.5">
                <FileCode className="w-4 h-4 text-indigo-500" />
                <span>Scope Files & Assets Context</span>
              </h3>
              <span className="text-[10px] font-mono text-slate-400">
                {activeSession.files.length} mounted
              </span>
            </div>

            {activeSession.files.length === 0 ? (
              <div className="text-center py-6 text-slate-400 dark:text-slate-500 text-xs">
                No active workspace files loaded. Use chat's "Attach File" toolbar to supply files.
              </div>
            ) : (
              <div className="space-y-2">
                {activeSession.files.map((file) => (
                  <div key={file.id} className="flex items-center justify-between p-2.5 rounded-xl border border-slate-150 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800">
                    <div className="flex items-center space-x-2.5 min-w-0">
                      <FileCode className="w-4 h-4 text-blue-500 shrink-0" />
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-slate-700 dark:text-slate-200 truncate">{file.name}</div>
                        <div className="text-[10px] text-slate-400 dark:text-slate-400 font-mono mt-0.5">{file.size} • {file.type.toUpperCase()}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Session Custom Tags */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-2xs space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <h3 className="font-bold text-slate-800 dark:text-slate-200 text-sm tracking-tight flex items-center space-x-1.5">
                <Tag className="w-3.5 h-3.5 text-pink-500" />
                <span>Category Tags</span>
              </h3>
            </div>

            <div className="flex flex-wrap gap-2 select-none">
              {activeSession.tags.map((tag) => (
                <div 
                  key={tag} 
                  className="flex items-center space-x-1 bg-pink-50 dark:bg-pink-950/30 text-pink-700 dark:text-pink-300 border border-pink-100 dark:border-pink-900/60 rounded-lg px-2 py-0.5 text-xs font-semibold shrink-0"
                >
                  <span>{tag}</span>
                  <button 
                    onClick={() => onRemoveTag(tag)}
                    className="hover:bg-pink-100 dark:hover:bg-pink-900 rounded p-0.5 text-pink-500 hover:text-pink-300"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}

              {showAddTag ? (
                <form onSubmit={handleAddTagSubmit} className="flex items-center space-x-1.5">
                  <input
                    autoFocus
                    type="text"
                    value={newTagInput}
                    onChange={(e) => setNewTagInput(e.target.value)}
                    placeholder="New tag..."
                    className="px-2 py-0.5 text-xs border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none bg-slate-50 dark:bg-slate-900 text-slate-800 dark:text-slate-200"
                  />
                  <button type="submit" className="text-[11px] bg-blue-600 text-white px-2 py-0.5 rounded hover:bg-blue-700">Add</button>
                  <button type="button" onClick={() => setShowAddTag(false)} className="text-slate-400">Cancel</button>
                </form>
              ) : (
                <button
                  onClick={() => setShowAddTag(true)}
                  className="flex items-center space-x-1 border border-dashed border-slate-300 dark:border-slate-700 text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-350 hover:border-slate-500 dark:hover:border-slate-500 text-xs px-2 py-0.5 rounded-lg transition shrink-0 cursor-pointer"
                >
                  <Plus className="w-3 h-3" />
                  <span>New Tag</span>
                </button>
              )}
            </div>
          </div>

        </div>

      </div>

    </div>
  );
}
