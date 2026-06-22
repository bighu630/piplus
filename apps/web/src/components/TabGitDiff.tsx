import React, { useState, useMemo } from 'react';
import {
  FileCode,
  Copy,
  Check,
  GitBranch,
  RefreshCw,
  Download,
  ChevronDown,
  ChevronRight,
  Info,
} from 'lucide-react';

interface TabGitDiffProps {
  diff: string | null;
  isLoading: boolean;
  onRefresh: () => void;
}

interface DiffLine {
  type: 'add' | 'delete' | 'meta' | 'header' | 'normal';
  text: string;
  lineNum: number;
}

interface DiffFile {
  filename: string;
  lines: DiffLine[];
}

export default function TabGitDiff({ diff, isLoading, onRefresh }: TabGitDiffProps) {
  const [copied, setCopied] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>({});

  const handleCopyText = () => {
    if (diff) {
      navigator.clipboard.writeText(diff);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const downloadPatch = () => {
    if (!diff) return;
    const blob = new Blob([diff], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'changes.patch';
    a.click();
    URL.revokeObjectURL(url);
  };

  const toggleCollapsed = (filename: string) => {
    setCollapsedFiles((prev) => ({ ...prev, [filename]: !prev[filename] }));
  };

  const parsedFiles = useMemo((): DiffFile[] => {
    if (!diff) return [];
    const lines = diff.split('\n');
    const files: DiffFile[] = [];
    let current: DiffFile | null = null;

    lines.forEach((line, index) => {
      if (line.startsWith('diff --git ')) {
        const match = line.match(/b\/(\S+)/);
        const filename = match ? match[1] : line.replace('diff --git ', '');
        current = { filename, lines: [] };
        files.push(current);
      }

      if (!current) {
        current = { filename: '变更', lines: [] };
        files.push(current);
      }

      let type: DiffLine['type'] = 'normal';
      if (line.startsWith('+') && !line.startsWith('+++')) {
        type = 'add';
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        type = 'delete';
      } else if (line.startsWith('@@')) {
        type = 'meta';
      } else if (
        line.startsWith('diff --git ') ||
        line.startsWith('index ') ||
        line.startsWith('--- ') ||
        line.startsWith('+++ ')
      ) {
        type = 'header';
      }

      current.lines.push({ type, text: line, lineNum: index + 1 });
    });

    return files;
  }, [diff]);

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-50/60 dark:bg-slate-900/10 overflow-hidden">
      {/* Top controls */}
      <div className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-6 py-3 shrink-0 flex flex-wrap items-center justify-between gap-4 select-none">
        <div className="flex items-center space-x-2">
          <div className="p-1.5 bg-blue-50 dark:bg-slate-800 text-blue-700 dark:text-blue-400 rounded-lg">
            <GitBranch className="w-4 h-4" />
          </div>
          <div>
            <span className="font-bold text-slate-700 dark:text-slate-200 text-sm font-sans tracking-tight">
              工作区变更
            </span>
            <span className="text-[10px] font-mono text-slate-400 block mt-0.5">
              当前会话的 Git Diff
            </span>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={onRefresh}
            disabled={isLoading}
            className="flex items-center space-x-1.5 px-3 py-1.5 bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200/50 dark:border-indigo-900 rounded-xl text-indigo-600 dark:text-indigo-400 font-semibold hover:bg-indigo-100/70 dark:hover:bg-indigo-900 disabled:opacity-50 text-xs transition cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>{isLoading ? '加载中…' : '刷新 Diff'}</span>
          </button>

          {diff && (
            <>
              <button
                onClick={handleCopyText}
                className="flex items-center space-x-1 px-2.5 py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-xl text-xs font-medium cursor-pointer transition border border-transparent dark:border-slate-700/60"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? '已复制' : '复制'}</span>
              </button>

              <button
                onClick={downloadPatch}
                className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-800 dark:hover:text-slate-100 text-slate-500 dark:text-slate-400 rounded-lg cursor-pointer transition"
                title="下载 Patch"
              >
                <Download className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Diff content */}
      <div className="flex-1 overflow-y-auto p-6">
        {!diff ? (
          <div className="h-full flex flex-col items-center justify-center text-center space-y-3">
            <GitBranch className="w-10 h-10 text-slate-300 dark:text-slate-600" />
            <p className="text-sm text-slate-400 dark:text-slate-500">暂无变更</p>
            <p className="text-xs text-slate-400 dark:text-slate-500">点击"刷新 Diff"获取当前会话的工作区差异</p>
          </div>
        ) : (
          <div className="max-w-5xl mx-auto space-y-6">
            <div className="flex items-start space-x-3 bg-blue-50/50 dark:bg-indigo-950/20 border border-blue-100 dark:border-indigo-900/60 p-4 rounded-xl text-xs text-blue-800 dark:text-indigo-300 leading-relaxed font-sans">
              <Info className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-bold">Git Diff：</span>新增行以绿色高亮，删除行以红色高亮。可点击文件名展开/收起每个文件的变更。
              </div>
            </div>

            {parsedFiles.map((fileObj, idx) => {
              const isCollapsed = collapsedFiles[fileObj.filename] || false;
              const functionalLines = fileObj.lines.filter((l) => l.type !== 'header');
              if (functionalLines.length === 0) return null;

              return (
                <div
                  key={idx}
                  className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-2xs"
                >
                  <button
                    onClick={() => toggleCollapsed(fileObj.filename)}
                    className="w-full flex items-center justify-between px-4 py-2.5 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800 cursor-pointer"
                  >
                    <div className="flex items-center space-x-2">
                      <FileCode className="w-4 h-4 text-blue-500" />
                      <span className="text-xs font-mono font-semibold text-slate-700 dark:text-slate-200">
                        {fileObj.filename}
                      </span>
                    </div>
                    {isCollapsed ? (
                      <ChevronRight className="w-4 h-4 text-slate-400" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-slate-400" />
                    )}
                  </button>

                  {!isCollapsed && (
                    <div className="overflow-x-auto font-mono text-xs">
                      {fileObj.lines.map((l) => {
                        if (l.type === 'header') return null;

                        let rowClass = 'text-slate-600 dark:text-slate-300';
                        let sign = ' ';

                        if (l.type === 'add') {
                          rowClass = 'bg-emerald-50/70 dark:bg-emerald-950/20 text-emerald-800 dark:text-emerald-300';
                          sign = '+';
                        } else if (l.type === 'delete') {
                          rowClass = 'bg-rose-50/70 dark:bg-rose-950/20 text-rose-800 dark:text-rose-300';
                          sign = '-';
                        } else if (l.type === 'meta') {
                          rowClass = 'bg-blue-50/40 dark:bg-blue-950/20 text-blue-600 dark:text-blue-400 font-semibold';
                        }

                        let displayText = l.text;
                        if (l.type === 'add' && l.text.startsWith('+')) {
                          displayText = l.text.substring(1);
                        } else if (l.type === 'delete' && l.text.startsWith('-')) {
                          displayText = l.text.substring(1);
                        }

                        return (
                          <div
                            key={l.lineNum}
                            className={`flex items-center px-3 py-0.5 ${rowClass} transition-colors`}
                          >
                            <span className="w-12 shrink-0 text-slate-400 dark:text-slate-500 select-none text-[10px] text-right pr-3 border-r border-slate-200/40 dark:border-slate-800">
                              {l.lineNum}
                            </span>
                            <span className="w-5 shrink-0 text-center select-none font-bold text-xs opacity-70">
                              {sign}
                            </span>
                            <span className="pl-1.5 whitespace-pre break-all">{displayText}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
