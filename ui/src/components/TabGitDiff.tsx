import React, { useState } from "react";
import { Session } from "../types";
import { 
  FileCode, 
  Copy, 
  Check, 
  GitBranch, 
  Sparkles, 
  Download,
  Folder,
  ChevronDown,
  ChevronRight,
  Info
} from "lucide-react";

interface TabGitDiffProps {
  activeSession: Session;
  isGenerating: boolean;
  onGenerateDiff: () => void;
}

interface DiffLine {
  type: "add" | "delete" | "meta" | "header" | "normal";
  text: string;
  originalIndex: number;
}

interface DiffFile {
  filename: string;
  lines: DiffLine[];
}

export default function TabGitDiff({
  activeSession,
  isGenerating,
  onGenerateDiff
}: TabGitDiffProps) {
  const [copied, setCopied] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>({});

  const handleCopyText = () => {
    if (activeSession.gitDiffText) {
      navigator.clipboard.writeText(activeSession.gitDiffText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const downloadPatch = () => {
    if (!activeSession.gitDiffText) return;
    const blob = new Blob([activeSession.gitDiffText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${activeSession.name.toLowerCase().replace(/\s+/g, "-")}.patch`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const toggleCollapsed = (filename: string) => {
    setCollapsedFiles(prev => ({ ...prev, [filename]: !prev[filename] }));
  };

  const defaultMockDiff = `diff --git a/src/App.tsx b/src/App.tsx
index d37f7a2..fc345cd 100644
--- a/src/App.tsx
+++ b/src/App.tsx
@@ -5,6 +5,10 @@ export default function App() {
-  return <div></div>;
+  return (
+    <div className="min-h-screen bg-slate-100 flex">
+      <Sidebar />
+      <MainContent />
+    </div>
+  );
 }`;

  const diffToDisplay = activeSession.gitDiffText || defaultMockDiff;

  // Parser: Split unified diff into groups of files
  const parseDiff = (text: string): DiffFile[] => {
    const lines = text.split("\n");
    const parsedFiles: DiffFile[] = [];
    let currentFile: DiffFile | null = null;

    lines.forEach((line, index) => {
      // Check if line indicates starting a new file
      if (line.startsWith("diff --git ")) {
        const match = line.match(/b\/(\S+)/);
        const filename = match ? match[1] : line.replace("diff --git ", "");
        currentFile = {
          filename,
          lines: []
        };
        parsedFiles.push(currentFile);
      }

      if (!currentFile) {
        // Fallback for text before first formal file tag
        currentFile = {
          filename: "General Changes",
          lines: []
        };
        parsedFiles.push(currentFile);
      }

      let type: "add" | "delete" | "meta" | "header" | "normal" = "normal";
      if (line.startsWith("+") && !line.startsWith("+++")) {
        type = "add";
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        type = "delete";
      } else if (line.startsWith("@@")) {
        type = "meta";
      } else if (
        line.startsWith("diff --git ") || 
        line.startsWith("index ") || 
        line.startsWith("--- ") || 
        line.startsWith("+++ ")
      ) {
        type = "header";
      }

      currentFile.lines.push({
        type,
        text,
        originalIndex: index + 1
      });
    });

    return parsedFiles;
  };

  const parsedFiles = parseDiff(diffToDisplay);

  // Render individual lines based on parsed metadata with clear beautiful highlight states
  const renderLineRow = (line: string, type: "add" | "delete" | "meta" | "header" | "normal", lineNum: number) => {
    let rowClass = "text-slate-600 dark:text-slate-300 hover:bg-slate-100/30 dark:hover:bg-slate-800/30";
    let textClass = "font-mono";
    let sign = " ";

    if (type === "add") {
      rowClass = "bg-emerald-50/70 dark:bg-emerald-950/20 border-l-[3px] border-emerald-500 font-semibold text-emerald-800 dark:text-emerald-300";
      sign = "+";
    } else if (type === "delete") {
      rowClass = "bg-rose-50/70 dark:bg-rose-950/20 border-l-[3px] border-rose-500 font-semibold text-rose-800 dark:text-rose-300";
      sign = "-";
    } else if (type === "meta") {
      rowClass = "bg-blue-50/40 dark:bg-blue-950/20 text-blue-600 dark:text-blue-400 py-1 border-y border-blue-100/40 dark:border-blue-950/50 font-semibold";
      sign = " ";
    } else if (type === "header") {
      // Don't render redundant Git headers because we present beautiful file cards
      return null;
    }

    // Clean leading code marker if duplicated or redundant
    let displayText = line;
    if (type === "add" && line.startsWith("+")) {
      displayText = line.substring(1);
    } else if (type === "delete" && line.startsWith("-")) {
      displayText = line.substring(1);
    }

    return (
      <div key={lineNum} className={`px-4 py-0.5 text-xs flex items-center ${rowClass} transition-colors whitespace-pre`}>
        <span className="w-10 sticky left-0 shrink-0 text-slate-400 dark:text-slate-500 select-none font-mono text-[10px] text-right pr-4 border-r border-slate-200/40 dark:border-slate-800 h-full">
          {lineNum}
        </span>
        <span className="w-6 shrink-0 text-center select-none font-mono font-bold text-xs opacity-70">
          {sign}
        </span>
        <span className={`${textClass} break-all pl-1.5`}>{displayText}</span>
      </div>
    );
  };

  // Helper parser for lines so they reflect original texts correctly
  const renderParsedFileLines = (fileLines: DiffLine[]) => {
    return fileLines.map((l) => {
      // Check each line's actual text
      const actualText = l.text.split("\n")[l.originalIndex - 1] || "";
      return renderLineRow(actualText, l.type, l.originalIndex);
    });
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-50/60 dark:bg-slate-900/10 overflow-hidden">
      
      {/* Top Header Controls bar */}
      <div className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-6 py-3 shrink-0 flex flex-wrap items-center justify-between gap-4 select-none">
        <div className="flex items-center space-x-2">
          <div className="p-1.5 bg-blue-50 dark:bg-slate-800 text-blue-700 dark:text-blue-400 rounded-lg">
            <GitBranch className="w-4 h-4" />
          </div>
          <div>
            <span className="font-bold text-slate-700 dark:text-slate-200 text-sm font-sans tracking-tight">Active Context Diff Patch</span>
            <span className="text-[10px] font-mono text-slate-400 block mt-0.5">
              Beautiful file-by-file visual representation of workspace changes
            </span>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={onGenerateDiff}
            disabled={isGenerating}
            className="flex items-center space-x-1.5 px-3 py-1.5 bg-indigo-50 border border-indigo-200/50 rounded-xl text-indigo-600 font-semibold hover:bg-indigo-100/70 disabled:opacity-50 text-xs transition"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>Generate Active Diff</span>
          </button>

          {activeSession.gitDiffText && (
            <>
              <button
                onClick={handleCopyText}
                className="flex items-center space-x-1 px-2.5 py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-xl text-xs font-medium cursor-pointer transition border border-transparent dark:border-slate-700/60"
                title="Copy Full Patch"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? "Copied" : "Copy"}</span>
              </button>

              <button
                onClick={downloadPatch}
                className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-800 dark:hover:text-slate-100 text-slate-500 dark:text-slate-400 rounded-lg cursor-pointer transition"
                title="Download Patch file"
              >
                <Download className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Main Diff visual panel */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        <div className="max-w-5xl mx-auto space-y-6">
          
          {/* Informational Banner */}
          <div className="flex items-start space-x-3 bg-blue-50/50 dark:bg-indigo-950/20 border border-blue-100 dark:border-indigo-900/60 p-4 rounded-xl text-xs text-blue-800 dark:text-indigo-305 leading-relaxed font-sans">
            <Info className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
            <div>
              <span className="font-bold">Visual Code Patching:</span> Below you see diff blocks generated using live conversational contexts. Added lines are highlighted in green, and removed lines are in red. You can collapse or expand files individually.
            </div>
          </div>

          {/* Grouped file-by-file patch items */}
          {parsedFiles.map((fileObj, idx) => {
            const isCollapsed = collapsedFiles[fileObj.filename] || false;
            // Clean filename text to look highly professional
            const cleanName = fileObj.filename.trim() || "Workspace Configuration changes";
            
            // Check if there are any non-header lines to present
            const functionalLines = fileObj.lines.filter(l => l.type !== "header");
            if (functionalLines.length === 0) return null;

            return (
              <div 
                key={idx} 
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-2xs"
              >
                {/* File badge header row */}
                <div 
                  onClick={() => toggleCollapsed(fileObj.filename)}
                  className="bg-slate-50 dark:bg-slate-800 px-4 py-3 flex items-center justify-between cursor-pointer border-b border-slate-200 dark:border-slate-800 select-none hover:bg-slate-100/50 dark:hover:bg-slate-800 transition-colors"
                >
                  <div className="flex items-center space-x-2.5 min-w-0">
                    {isCollapsed ? (
                      <ChevronRight className="w-4 h-4 text-slate-400 dark:text-slate-500 shrink-0" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-slate-400 dark:text-slate-500 shrink-0" />
                    )}
                    <FileCode className="w-4 h-4 text-blue-500 shrink-0" />
                    <span className="font-mono text-xs font-bold text-slate-800 dark:text-slate-200 truncate">
                      {cleanName}
                    </span>
                  </div>

                  <span className="text-[10px] font-mono px-2 py-0.5 bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400 font-bold rounded">
                    {functionalLines.length} lines affected
                  </span>
                </div>

                {/* Code viewport container */}
                {!isCollapsed && (
                  <div className="bg-white dark:bg-slate-950 border-t border-transparent text-slate-700 dark:text-slate-300 py-3 overflow-x-auto">
                    <div className="min-w-fit flex flex-col font-mono text-xs">
                      {renderParsedFileLines(fileObj.lines)}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

        </div>
      </div>

    </div>
  );
}

