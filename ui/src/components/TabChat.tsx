import React, { useState, useRef, useEffect } from "react";
import { Message, Session, FileItem } from "../types";
import ReactMarkdown from "react-markdown";
import { 
  Send, 
  Paperclip, 
  Square, 
  Copy, 
  Check, 
  Sparkles, 
  Terminal, 
  Plus, 
  FileCode,
  X,
  AlertCircle
} from "lucide-react";

interface TabChatProps {
  activeSession: Session;
  isGenerating: boolean;
  onSendMessage: (text: string) => void;
  onAttachFile: (file: FileItem) => void;
  onDettachFile: (fileId: string) => void;
  onStopGeneration: () => void;
}

export default function TabChat({
  activeSession,
  isGenerating,
  onSendMessage,
  onAttachFile,
  onDettachFile,
  onStopGeneration
}: TabChatProps) {
  const [inputText, setInputText] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [fileInputOpened, setFileInputOpened] = useState(false);
  
  // Simulated file picker state
  const [simName, setSimName] = useState("");
  const [simSize, setSimSize] = useState("4.2 KB");

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeSession.messages, isGenerating]);

  const handleSendSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputText.trim() && !isGenerating) {
      onSendMessage(inputText.trim());
      setInputText("");
    }
  };

  const handleSuggestClick = (suggestion: string) => {
    if (!isGenerating) {
      onSendMessage(suggestion);
    }
  };

  const handleCopyCode = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleSimAttachSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (simName.trim()) {
      onAttachFile({
        id: Math.random().toString(36).substr(2, 9),
        name: simName.trim(),
        size: simSize,
        type: simName.includes(".") ? simName.split(".").pop() || "txt" : "txt"
      });
      setSimName("");
      setFileInputOpened(false);
    }
  };

  // Helper component to render rich beautiful Markdown
  const MarkdownRenderer = ({ content }: { content: string }) => {
    return (
      <div className="markdown-body">
        <ReactMarkdown
          components={{
            p({ children, ...props }) {
              return <p className="text-slate-700 dark:text-slate-300 leading-relaxed my-2 text-[13.5px]" {...props}>{children}</p>;
            },
            h1({ children, ...props }) {
              return <h1 className="text-base font-bold text-slate-800 dark:text-slate-100 mt-4 mb-2" {...props}>{children}</h1>;
            },
            h2({ children, ...props }) {
              return <h2 className="text-sm font-bold text-slate-800 dark:text-slate-100 mt-3 mb-1.5" {...props}>{children}</h2>;
            },
            h3({ children, ...props }) {
              return <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 mt-2 mb-1" {...props}>{children}</h3>;
            },
            ul({ children, ...props }) {
              return <ul className="list-disc pl-5 my-2 text-xs text-slate-700 dark:text-slate-300 space-y-1" {...props}>{children}</ul>;
            },
            ol({ children, ...props }) {
              return <ol className="list-decimal pl-5 my-2 text-xs text-slate-700 dark:text-slate-300 space-y-1" {...props}>{children}</ol>;
            },
            li({ children, ...props }) {
              return <li className="leading-relaxed text-[13px]" {...props}>{children}</li>;
            },
            blockquote({ children, ...props }) {
              return <blockquote className="border-l-4 border-slate-350 dark:border-slate-700 bg-slate-50 dark:bg-slate-804/50 pl-3.5 py-1.5 my-3 italic text-slate-600 dark:text-slate-400 rounded-r-lg" {...props}>{children}</blockquote>;
            },
            a({ children, ...props }) {
              return <a className="text-blue-600 hover:underline hover:text-blue-700 font-medium cursor-pointer" {...props}>{children}</a>;
            },
            code({ node, className, children, ...props }: any) {
              const match = /language-(\w+)/.exec(className || "");
              const codeText = String(children).replace(/\n$/, "");
              const isInline = !className;

              if (!isInline) {
                const language = match ? match[1] : "code";
                const blockId = Math.random().toString(36).substr(2, 9);
                return (
                  <div className="my-3 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-slate-50 dark:bg-slate-900 relative font-mono text-xs shadow-3xs max-w-full">
                    {/* Header */}
                    <div className="bg-slate-100/80 dark:bg-slate-800 px-4 py-1.5 flex items-center justify-between text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800 select-none">
                      <span className="text-[10px] font-mono font-bold uppercase tracking-wider">{language}</span>
                      <button
                        type="button"
                        onClick={() => handleCopyCode(codeText, blockId)}
                        className="flex items-center space-x-1.5 hover:bg-slate-200 dark:hover:bg-slate-800 px-2.5 py-1 rounded text-[11px] text-slate-600 dark:text-slate-350 font-sans cursor-pointer transition-colors"
                      >
                        {copiedId === blockId ? (
                          <>
                            <Check className="w-3 h-3 text-green-600" />
                            <span className="text-green-600 font-medium">Copied</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3 h-3" />
                            <span>Copy</span>
                          </>
                        )}
                      </button>
                    </div>
                    {/* Body */}
                    <pre className="p-4 overflow-x-auto text-[11.5px] leading-relaxed text-slate-800 dark:text-slate-200 bg-white dark:bg-slate-950">
                      <code>{codeText}</code>
                    </pre>
                  </div>
                );
              }

              return (
                <code className="bg-slate-100 dark:bg-slate-800 border border-slate-150 dark:border-slate-700 text-slate-800 dark:text-slate-200 px-1.5 py-0.5 rounded font-mono text-[11px] font-semibold" {...props}>
                  {children}
                </code>
              );
            }
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    );
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-100/40 dark:bg-slate-900/10 relative">
      {/* Scrollable messages container */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
        {activeSession.messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center p-8 text-center max-w-md mx-auto space-y-4">
            <div className="bg-blue-50 dark:bg-slate-800 text-blue-600 dark:text-blue-400 p-3.5 rounded-full">
              <Sparkles className="w-6 h-6 animate-pulse" />
            </div>
            <div>
              <h3 className="font-semibold text-slate-800 dark:text-slate-200 text-base">New Session Chat</h3>
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-1 leading-normal">
                Ask questions, build tools, reference attached files, and let the session manager compile context seamlessly!
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {activeSession.messages.map((msg) => {
              const isUser = msg.role === "user";
              return (
                <div 
                  key={msg.id} 
                  className={`flex ${isUser ? "justify-end" : "justify-start"} items-start w-full`}
                >
                  <div className={`flex flex-col ${isUser ? "items-end" : "items-start"} ${isUser ? "max-w-[85%]" : "max-w-full flex-1"}`}>
                    {isUser ? (
                      <div className="bg-blue-600 text-white rounded-2xl px-4 py-2.5 text-sm shadow-xs font-sans leading-relaxed">
                        {msg.content}
                      </div>
                    ) : (
                      <div className="text-slate-800 dark:text-slate-200 w-full pl-0">
                        <MarkdownRenderer content={msg.content} />
                      </div>
                    )}
                    <span className="text-[10px] text-slate-400 dark:text-slate-500 mt-2 px-1 font-mono">
                      {msg.timestamp}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Typing state indicator */}
        {isGenerating && (
          <div className="flex items-start w-full">
            <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700/80 rounded-2xl p-4 shadow-2xs flex items-center space-x-2 text-xs text-slate-500 dark:text-slate-400 font-sans">
              <div className="flex space-x-1">
                <span className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
              <span className="italic pl-1 text-slate-600 dark:text-slate-300 font-medium flex items-center space-x-1">
                <span>Pi Assistant is streaming response via WebSocket</span>
                <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-ping" />
              </span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Suggested prompting templates */}
      {activeSession.messages.length > 0 && !isGenerating && (
        <div className="px-6 py-2 flex flex-wrap gap-2 select-none shrink-0 bg-white/40 dark:bg-slate-900/60 border-t border-slate-100 dark:border-slate-800/60">
          <button 
            onClick={() => handleSuggestClick("Create a customized Git Diff of our new session features")}
            className="text-[11px] bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-750 border border-slate-200/80 dark:border-slate-700 rounded-full px-3 py-1 text-slate-600 dark:text-slate-300 shadow-3xs cursor-pointer transition-colors"
          >
            📊 Generate Git Diff
          </button>
          <button 
            onClick={() => handleSuggestClick("Analyze this session and update metadata summary")}
            className="text-[11px] bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-750 border border-slate-200/80 dark:border-slate-700 rounded-full px-3 py-1 text-slate-600 dark:text-slate-300 shadow-3xs cursor-pointer transition-colors"
          >
            🧩 Analyze Session Info
          </button>
          <button 
            onClick={() => handleSuggestClick("How can I structure my config files for production?")}
            className="text-[11px] bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-750 border border-slate-200/80 dark:border-slate-700 rounded-full px-3 py-1 text-slate-600 dark:text-slate-300 shadow-3xs cursor-pointer transition-colors"
          >
            ⚙️ Structure Project Configs
          </button>
        </div>
      )}

      {/* Attachments quick pill inside input footer */}
      {activeSession.files.length > 0 && (
        <div className="px-6 py-1.5 bg-slate-50 dark:bg-slate-900 border-t border-slate-150 dark:border-slate-800/60 flex items-center space-x-2 overflow-x-auto select-none shrink-0">
          <span className="text-[10px] text-slate-400 dark:text-slate-500 font-bold tracking-wider shrink-0 uppercase">Context Files:</span>
          {activeSession.files.map((file) => (
            <div key={file.id} className="flex items-center space-x-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 pl-2 pr-1 py-0.5 rounded-md text-[10.5px] text-slate-600 dark:text-slate-200">
              <FileCode className="w-3 h-3 text-blue-500 shrink-0" />
              <span className="truncate max-w-[120px]">{file.name}</span>
              <button 
                onClick={() => onDettachFile(file.id)}
                className="hover:bg-slate-100 dark:hover:bg-slate-700 rounded text-slate-400 dark:text-slate-500 hover:text-red-600 p-0.5 cursor-pointer"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Simulated File Attachment prompt modal */}
      {fileInputOpened && (
        <div className="absolute bottom-24 left-6 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700/80 rounded-xl shadow-lg p-4 z-55 w-80">
          <div className="flex items-center justify-between mb-3 border-b border-slate-100 dark:border-slate-700/60 pb-1.5">
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">Attach Simulated Workspace File</span>
            <button onClick={() => setFileInputOpened(false)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
              <X className="w-4 h-4" />
            </button>
          </div>
          <form onSubmit={handleSimAttachSubmit} className="space-y-3">
            <div>
              <label className="block text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase mb-1">File Name</label>
              <input
                autoFocus
                type="text"
                placeholder="e.g., config/database.ts"
                value={simName}
                onChange={(e) => setSimName(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none text-slate-800 dark:text-slate-100 placeholder:text-slate-400"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase mb-1">Size & Details</label>
              <input
                type="text"
                placeholder="e.g., 2.4 KB"
                value={simSize}
                onChange={(e) => setSimSize(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none text-slate-800 dark:text-slate-100 placeholder:text-slate-400"
              />
            </div>
            <div className="flex space-x-2 justify-end">
              <button
                type="button"
                onClick={() => setFileInputOpened(false)}
                className="px-2.5 py-1 text-xs text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!simName.trim()}
                className="px-3 py-1 text-xs bg-blue-600 text-white font-medium rounded hover:bg-blue-700 disabled:opacity-50"
              >
                Attach Context
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Input panel area at the bottom */}
      <div className="p-4 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800/80 shadow-sm shrink-0">
        <form onSubmit={handleSendSubmit} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-2xl shadow-2xs overflow-hidden">
          {/* Main text area */}
          <textarea
            rows={2}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSendSubmit(e);
              }
            }}
            placeholder="向当前 session 发送消息..."
            className="w-full px-4 py-3 text-sm focus:outline-none resize-none bg-transparent placeholder:text-slate-400 text-slate-800 dark:text-slate-100"
          />

          {/* Form bottom controls toolbar */}
          <div className="px-4 py-2 bg-slate-50 dark:bg-slate-800/80 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between select-none">
            <div className="flex items-center space-x-3">
              <button
                type="button"
                onClick={() => setFileInputOpened(true)}
                className="flex items-center space-x-1.5 hover:bg-slate-200 dark:hover:bg-slate-800 p-2 rounded-lg text-slate-600 dark:text-slate-300 cursor-pointer text-xs font-semibold transition-colors"
              >
                <Paperclip className="w-4 h-4 text-slate-500 dark:text-slate-400" />
                <span>Attach File</span>
              </button>

              <div className="hidden sm:flex items-center space-x-1.5 bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-100 dark:border-indigo-900 px-2 py-1 rounded-lg text-[10px] font-mono font-bold text-indigo-700 dark:text-indigo-400 select-none">
                <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-ping shrink-0" />
                <span>WS PUSHING ACTIVE</span>
              </div>
            </div>

            <div className="flex items-center space-x-3">
              {isGenerating && (
                <button
                  type="button"
                  onClick={onStopGeneration}
                  className="flex items-center space-x-1.5 hover:bg-red-50 dark:hover:bg-red-950/20 p-2 rounded-lg text-red-600 dark:text-red-400 cursor-pointer text-xs font-semibold border border-red-200/50 dark:border-red-900/50"
                >
                  <Square className="w-3 h-3 fill-red-600 text-red-600 dark:fill-red-400 dark:text-red-400" />
                  <span>Stop Generation</span>
                </button>
              )}

              <button
                type="submit"
                disabled={!inputText.trim() || isGenerating}
                className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:hover:bg-blue-600 text-white font-semibold py-1.5 px-4 rounded-xl text-xs flex items-center space-x-2 cursor-pointer transition-all"
              >
                <span>Send</span>
                <Send className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
