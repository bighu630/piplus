import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import {
  FileCode,
  Copy,
  Check,
  GitBranch,
  RefreshCw,
  Download,
  ChevronRight,
  ChevronDown,
  Info,
  GitPullRequest,
  GitCommitVertical,
  ArrowUpCircle,
  X,
  FileText,
  Folder,
  FolderOpen,
} from 'lucide-react';

interface GitActionResult {
  session_id: string;
  cwd: string;
  result: 'ok' | 'error';
  stdout?: string;
  stderr?: string;
}

interface TabGitDiffProps {
  diff: string | null;
  isLoading: boolean;
  onRefresh: () => void;
  onPull: () => Promise<GitActionResult>;
  onPush: () => Promise<GitActionResult>;
  onCommit: (message: string) => Promise<GitActionResult>;
  onAddGitignore: (filePath: string) => Promise<unknown>;
  isPulling: boolean;
  isPushing: boolean;
  isCommitting: boolean;
  isAddingGitignore: boolean;
  currentBranch: string | null;
  branches: Array<{ name: string; is_current: boolean }> | null;
  onCheckout: (branch: string) => Promise<GitActionResult>;
  isCheckingOut: boolean;
  cwd: string | null;
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

interface FileTreeNode {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  children: FileTreeNode[];
}

type GitOp = 'pull' | 'push' | 'commit' | 'checkout';

function buildFileTree(files: string[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  for (const filepath of files) {
    const parts = filepath.split('/');
    let level = root;
    let accumulatedPath = '';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      accumulatedPath = accumulatedPath ? `${accumulatedPath}/${part}` : part;
      const isLast = i === parts.length - 1;

      let existing = level.find((n) => n.name === part);
      if (!existing) {
        existing = {
          name: part,
          path: accumulatedPath,
          kind: isLast ? 'file' : 'directory',
          children: [],
        };
        level.push(existing);
      }

      if (isLast) {
        existing.kind = 'file';
      }

      level = existing.children;
    }
  }

  function sortTree(nodes: FileTreeNode[]): FileTreeNode[] {
    return nodes
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map((node) => ({ ...node, children: sortTree(node.children) }));
  }

  return sortTree(root);
}

function DiffFileTree({
  nodes,
  depth,
  expanded,
  onToggle,
  selectedPath,
  onSelect,
  onAddGitignore,
  isAddingGitignore,
}: {
  nodes: FileTreeNode[];
  depth: number;
  expanded: Record<string, boolean>;
  onToggle: (path: string) => void;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onAddGitignore: (filePath: string) => void;
  isAddingGitignore: boolean;
}) {
  return (
    <>
      {nodes.map((node) => {
        const isDirectory = node.kind === 'directory';
        const isOpen = expanded[node.path] ?? true;
        const isSelected = selectedPath === node.path;

        return (
          <div key={node.path}>
            <div
              className={`group flex items-center gap-1 rounded-lg text-left text-xs transition cursor-pointer ${
                isSelected
                  ? 'bg-blue-50 dark:bg-blue-950/30'
                  : 'hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              <button
                type="button"
                onClick={() => {
                  if (isDirectory) {
                    onToggle(node.path);
                  } else {
                    onSelect(node.path);
                  }
                }}
                className="flex items-center gap-1.5 flex-1 min-w-0 px-1.5 py-1"
                style={{ paddingLeft: `${depth * 12 + 6}px` }}
              >
                {isDirectory ? (
                  <ChevronRight className={`w-3 h-3 shrink-0 transition ${isOpen ? 'rotate-90' : ''}`} />
                ) : (
                  <span className="w-3 h-3 shrink-0" />
                )}
                {isDirectory ? (
                  isOpen ? (
                    <FolderOpen className="w-3.5 h-3.5 shrink-0 text-amber-500" />
                  ) : (
                    <Folder className="w-3.5 h-3.5 shrink-0 text-amber-500" />
                  )
                ) : (
                  <FileText className="w-3.5 h-3.5 shrink-0 text-slate-400" />
                )}
                <span
                  className={`truncate ${
                    isSelected
                      ? 'text-blue-700 dark:text-blue-300'
                      : 'text-slate-600 dark:text-slate-300'
                  }`}
                >
                  {node.name}
                </span>
              </button>

              {/* Gitignore button - hidden until hover */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onAddGitignore(node.path);
                }}
                disabled={isAddingGitignore}
                title={`Add ${node.path} to .gitignore`}
                className="shrink-0 mr-1 opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 cursor-pointer disabled:opacity-30"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>

            {isDirectory && isOpen && node.children.length > 0 && (
              <div className="mt-0.5">
                <DiffFileTree
                  nodes={node.children}
                  depth={depth + 1}
                  expanded={expanded}
                  onToggle={onToggle}
                  selectedPath={selectedPath}
                  onSelect={onSelect}
                  onAddGitignore={onAddGitignore}
                  isAddingGitignore={isAddingGitignore}
                />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

export default function TabGitDiff({
  diff,
  isLoading,
  onRefresh,
  onPull,
  onPush,
  onCommit,
  onAddGitignore,
  isPulling,
  isPushing,
  isCommitting,
  isAddingGitignore,
  currentBranch,
  branches,
  onCheckout,
  isCheckingOut,
  cwd,
}: TabGitDiffProps) {
  const [copied, setCopied] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>({});
  const [showCommitInput, setShowCommitInput] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [opFeedback, setOpFeedback] = useState<{ op: GitOp; result: 'ok' | 'error'; message: string } | null>(null);
  const [treeExpanded, setTreeExpanded] = useState<Record<string, boolean>>({});
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
  const branchSelectorRef = useRef<HTMLDivElement>(null);
  const fileRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Close branch dropdown on outside click
  useEffect(() => {
    if (!branchDropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (branchSelectorRef.current && !branchSelectorRef.current.contains(e.target as Node)) {
        setBranchDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [branchDropdownOpen]);

  const clearFeedback = useCallback(() => {
    setOpFeedback(null);
  }, []);

  const handlePull = useCallback(async () => {
    try {
      const res = await onPull();
      setOpFeedback({
        op: 'pull',
        result: res.result,
        message: res.result === 'ok' ? (res.stdout || 'Pull 成功') : (res.stderr || 'Pull 失败'),
      });
    } catch {
      setOpFeedback({ op: 'pull', result: 'error', message: 'Pull 失败' });
    }
    setTimeout(clearFeedback, 6000);
  }, [onPull, clearFeedback]);

  const handlePush = useCallback(async () => {
    try {
      const res = await onPush();
      setOpFeedback({
        op: 'push',
        result: res.result,
        message: res.result === 'ok' ? (res.stdout || 'Push 成功') : (res.stderr || 'Push 失败'),
      });
    } catch {
      setOpFeedback({ op: 'push', result: 'error', message: 'Push 失败' });
    }
    setTimeout(clearFeedback, 6000);
  }, [onPush, clearFeedback]);

  const handleCommit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!commitMessage.trim()) return;
      try {
        const res = await onCommit(commitMessage.trim());
        setOpFeedback({
          op: 'commit',
          result: res.result,
          message: res.result === 'ok' ? (res.stdout || 'Commit 成功') : (res.stderr || 'Commit 失败'),
        });
        if (res.result === 'ok') {
          setCommitMessage('');
          setShowCommitInput(false);
        }
      } catch {
        setOpFeedback({ op: 'commit', result: 'error', message: 'Commit 失败' });
      }
      setTimeout(clearFeedback, 6000);
    },
    [commitMessage, onCommit, clearFeedback],
  );

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

  const fileTree = useMemo(() => {
    const filenames = parsedFiles
      .filter((f) => f.lines.some((l) => l.type !== 'header'))
      .map((f) => f.filename);
    return buildFileTree(filenames);
  }, [parsedFiles]);

  // Reset selection when diff changes
  useEffect(() => {
    setSelectedFilePath(null);
    fileRefs.current = new Map();
  }, [diff]);

  const handleFileSelect = useCallback((path: string) => {
    setSelectedFilePath(path);
    const el = fileRefs.current.get(path);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  const toggleTreeExpanded = useCallback((path: string) => {
    setTreeExpanded((prev) => ({ ...prev, [path]: !(prev[path] ?? true) }));
  }, []);

  const toggleCollapsed = useCallback((filename: string) => {
    setCollapsedFiles((prev) => ({ ...prev, [filename]: !prev[filename] }));
  }, []);

  const anyBusy = isPulling || isPushing || isCommitting || isLoading || isCheckingOut;

  const functionalFiles = useMemo(
    () => parsedFiles.filter((f) => f.lines.some((l) => l.type !== 'header')),
    [parsedFiles],
  );

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-50/60 dark:bg-slate-900/10 overflow-hidden">
      {/* Top controls */}
      <div className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-6 py-3 shrink-0 flex items-center justify-between gap-4 select-none">
        <div className="flex items-center space-x-3 shrink-0">
          {/* Branch selector dropdown */}
          <div className="relative" ref={branchSelectorRef}>
            <button
              type="button"
              onClick={() => setBranchDropdownOpen(!branchDropdownOpen)}
              disabled={isCheckingOut}
              className="flex items-center space-x-1.5 px-3 py-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs font-mono font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition cursor-pointer disabled:opacity-50"
            >
              <GitBranch className="w-3.5 h-3.5 text-blue-500" />
              <span>{currentBranch || '—'}</span>
              <ChevronDown className={`w-3 h-3 transition ${branchDropdownOpen ? 'rotate-180' : ''}`} />
            </button>

            {branchDropdownOpen && (
              <div className="absolute left-0 top-full mt-1 z-20 w-56 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-lg overflow-hidden">
                  <div className="px-3 py-2 text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider border-b border-slate-100 dark:border-slate-700">
                    分支 ({branches?.length ?? 0})
                  </div>
                  <div className="max-h-60 overflow-y-auto">
                    {branches?.map((b) => (
                      <button
                        key={b.name}
                        type="button"
                        onClick={async () => {
                          if (!b.is_current) {
                            setBranchDropdownOpen(false);
                            try {
                              const res = await onCheckout(b.name);
                              setOpFeedback({
                                op: 'checkout',
                                result: res.result,
                                message: res.result === 'ok'
                                  ? `已切换到分支 "${b.name}"`
                                  : (res.stderr || `切换到 "${b.name}" 失败`),
                              });
                            } catch {
                              setOpFeedback({
                                op: 'checkout',
                                result: 'error',
                                message: `切换到 "${b.name}" 失败`,
                              });
                            }
                            setTimeout(clearFeedback, 6000);
                          } else {
                            setBranchDropdownOpen(false);
                          }
                        }}
                        disabled={b.is_current || isCheckingOut}
                        className={`w-full flex items-center space-x-2 px-3 py-2 text-xs text-left transition cursor-pointer ${
                          b.is_current
                            ? 'bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300 font-semibold'
                            : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50'
                        } disabled:opacity-50`}
                      >
                        <GitBranch className="w-3.5 h-3.5 shrink-0" />
                        <span className="truncate">{b.name}</span>
                        {b.is_current && <span className="ml-auto text-[10px] text-blue-500">当前</span>}
                      </button>
                    ))}
                    {!branches && (
                      <div className="px-3 py-4 text-xs text-slate-400 text-center">加载中…</div>
                    )}
                    {branches && branches.length === 0 && (
                      <div className="px-3 py-4 text-xs text-slate-400 text-center">无分支</div>
                    )}
                  </div>
                </div>
            )}
          </div>

          <div className="w-px h-6 bg-slate-200 dark:bg-slate-700" />

          <div className="min-w-0">
            <span className="font-bold text-slate-700 dark:text-slate-200 text-sm font-sans tracking-tight">
              变更
            </span>
            <span
              className="text-[10px] font-mono text-slate-400 block mt-0.5 truncate max-w-[320px]"
              title={cwd ?? undefined}
            >
              {cwd || '—'}
            </span>
          </div>
        </div>

        <div className="flex items-center space-x-2 flex-wrap gap-y-2">
          <button
            onClick={onRefresh}
            disabled={isLoading}
            className="flex items-center space-x-1.5 px-3 py-1.5 bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200/50 dark:border-indigo-900 rounded-xl text-indigo-600 dark:text-indigo-400 font-semibold hover:bg-indigo-100/70 dark:hover:bg-indigo-900 disabled:opacity-50 text-xs transition cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>{isLoading ? '加载中…' : '刷新'}</span>
          </button>

          <button
            onClick={handlePull}
            disabled={anyBusy}
            className="flex items-center space-x-1.5 px-3 py-1.5 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200/50 dark:border-emerald-900 rounded-xl text-emerald-600 dark:text-emerald-400 font-semibold hover:bg-emerald-100/70 dark:hover:bg-emerald-900 disabled:opacity-50 text-xs transition cursor-pointer"
          >
            <ArrowUpCircle className={`w-3.5 h-3.5 ${isPulling ? 'animate-spin' : ''}`} />
            <span>{isPulling ? 'Pulling…' : 'Pull'}</span>
          </button>

          <button
            onClick={handlePush}
            disabled={anyBusy}
            className="flex items-center space-x-1.5 px-3 py-1.5 bg-amber-50 dark:bg-amber-950/30 border border-amber-200/50 dark:border-amber-900 rounded-xl text-amber-600 dark:text-amber-400 font-semibold hover:bg-amber-100/70 dark:hover:bg-amber-900 disabled:opacity-50 text-xs transition cursor-pointer"
          >
            <GitPullRequest className={`w-3.5 h-3.5 ${isPushing ? 'animate-spin' : ''}`} />
            <span>{isPushing ? 'Pushing…' : 'Push'}</span>
          </button>

          <button
            onClick={() => {
              setShowCommitInput(true);
              setCommitMessage('');
            }}
            disabled={anyBusy}
            className="flex items-center space-x-1.5 px-3 py-1.5 bg-violet-50 dark:bg-violet-950/30 border border-violet-200/50 dark:border-violet-900 rounded-xl text-violet-600 dark:text-violet-400 font-semibold hover:bg-violet-100/70 dark:hover:bg-violet-900 disabled:opacity-50 text-xs transition cursor-pointer"
          >
            <GitCommitVertical className={`w-3.5 h-3.5 ${isCommitting ? 'animate-spin' : ''}`} />
            <span>{isCommitting ? 'Committing…' : 'Commit'}</span>
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

      {/* Feedback toast */}
      {opFeedback && (
        <div
          className={`mx-6 mt-3 px-4 py-2 rounded-xl text-xs font-medium flex items-center justify-between ${
            opFeedback.result === 'ok'
              ? 'bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 text-emerald-700 dark:text-emerald-300'
              : 'bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300'
          }`}
        >
          <span className="truncate">{opFeedback.message}</span>
          <button onClick={clearFeedback} className="ml-2 shrink-0 hover:opacity-70 cursor-pointer">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Inline commit input */}
      {showCommitInput && (
        <div className="mx-6 mt-3 bg-white dark:bg-slate-900 border border-violet-200 dark:border-violet-900 rounded-xl p-4">
          <form onSubmit={handleCommit} className="flex flex-col space-y-3">
            <div className="flex items-center space-x-2">
              <GitCommitVertical className="w-4 h-4 text-violet-500" />
              <span className="text-xs font-bold text-slate-700 dark:text-slate-200">提交 Commit</span>
            </div>
            <input
              autoFocus
              type="text"
              placeholder="请输入 commit message…"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              disabled={isCommitting}
              className="w-full px-3 py-2 text-xs border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:border-violet-400 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-100 placeholder:text-slate-400 disabled:opacity-50"
            />
            <div className="flex space-x-2 justify-end">
              <button
                type="button"
                onClick={() => {
                  setShowCommitInput(false);
                  setCommitMessage('');
                }}
                disabled={isCommitting}
                className="px-3 py-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition cursor-pointer disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={!commitMessage.trim() || isCommitting}
                className="px-4 py-1.5 text-xs font-semibold bg-violet-600 text-white hover:bg-violet-700 rounded-lg shadow-2xs transition cursor-pointer disabled:opacity-50"
              >
                {isCommitting ? '提交中…' : '确认提交'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Diff content area */}
      <div className="flex-1 flex overflow-hidden">
        {/* No diff state */}
        {!diff ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center space-y-3">
            <GitBranch className="w-10 h-10 text-slate-300 dark:text-slate-600" />
            <p className="text-sm text-slate-400 dark:text-slate-500">暂无变更</p>
            <p className="text-xs text-slate-400 dark:text-slate-500">点击"刷新"获取当前会话的工作区差异</p>
          </div>
        ) : (
          <>
            {/* Left sidebar - file tree */}
            <aside className="w-[300px] shrink-0 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col">
              <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800">
                <div className="flex items-center gap-2 text-sm font-bold text-slate-700 dark:text-slate-200">
                  <FileCode className="w-4 h-4 text-blue-500" />
                  <span>变更文件</span>
                </div>
                <div className="text-[10px] font-mono text-slate-400 mt-0.5">
                  {functionalFiles.length} 个文件
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
                {fileTree.length === 0 ? (
                  <div className="text-xs text-slate-400 p-2">无变更文件</div>
                ) : (
                  <DiffFileTree
                    nodes={fileTree}
                    depth={0}
                    expanded={treeExpanded}
                    onToggle={toggleTreeExpanded}
                    selectedPath={selectedFilePath}
                    onSelect={handleFileSelect}
                    onAddGitignore={(filePath) => { onAddGitignore(filePath); }}
                    isAddingGitignore={isAddingGitignore}
                  />
                )}
              </div>
            </aside>

            {/* Right diff viewer */}
            <div className="flex-1 overflow-y-auto p-6">
              <div className="max-w-5xl mx-auto space-y-6">
                <div className="flex items-start space-x-3 bg-blue-50/50 dark:bg-indigo-950/20 border border-blue-100 dark:border-indigo-900/60 p-4 rounded-xl text-xs text-blue-800 dark:text-indigo-300 leading-relaxed font-sans">
                  <Info className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold">Git Diff：</span>新增行以绿色高亮，删除行以红色高亮。可点击文件名展开/收起每个文件的变更。左侧目录可快速跳转。
                  </div>
                </div>

                {functionalFiles.map((fileObj) => {
                  const isCollapsed = collapsedFiles[fileObj.filename] || false;

                  return (
                    <div
                      key={fileObj.filename}
                      ref={(el) => {
                        if (el) fileRefs.current.set(fileObj.filename, el);
                      }}
                      className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-2xs scroll-mt-4"
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
                          <ChevronRight className="w-4 h-4 text-slate-400 rotate-90" />
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
            </div>
          </>
        )}
      </div>
    </div>
  );
}
