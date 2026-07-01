import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionFileContentResponseDTO, SessionFileTreeNodeDTO, SessionFileTreeResponseDTO } from '@piplus/shared';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import hljs from 'highlight.js';
import { Check, ChevronRight, Copy, Edit3, FileCode2, FileText, Folder, FolderOpen, PanelLeft, RefreshCw, Save, X } from 'lucide-react';
import MermaidBlock from './MermaidBlock';

interface TabFilesProps {
  treeResponse: SessionFileTreeResponseDTO | null;
  treeLoading: boolean;
  treeError?: string | null;
  contentResponse: SessionFileContentResponseDTO | null;
  contentLoading: boolean;
  contentError?: string | null;
  onRefresh: () => void;
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
  onSaveContent?: (path: string, content: string) => Promise<void>;
  saving?: boolean;
}

function isMarkdownFile(filePath: string | null): boolean {
  if (!filePath) return false;
  return /\.(md|markdown)$/i.test(filePath);
}

function getLanguageFromPath(filePath: string | null): string {
  if (!filePath) return 'text';
  const extension = filePath.split('.').pop()?.toLowerCase();
  switch (extension) {
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'json':
      return 'json';
    case 'css':
    case 'scss':
    case 'sass':
    case 'less':
      return 'css';
    case 'html':
    case 'htm':
      return 'html';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'md':
      return 'markdown';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'bash';
    case 'py':
      return 'python';
    case 'rs':
      return 'rust';
    case 'go':
      return 'go';
    case 'java':
      return 'java';
    default:
      return extension || 'text';
  }
}

function FileTreeNode({
  node,
  depth,
  expanded,
  onToggle,
  selectedPath,
  onSelectPath,
}: {
  node: SessionFileTreeNodeDTO;
  depth: number;
  expanded: Record<string, boolean>;
  onToggle: (path: string) => void;
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
}) {
  const isDirectory = node.kind === 'directory';
  const isOpen = expanded[node.path] ?? depth < 1;
  const isSelected = selectedPath === node.path;

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          if (isDirectory) {
            onToggle(node.path);
            return;
          }
          onSelectPath(node.path);
        }}
        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-xs transition cursor-pointer ${
          isSelected
            ? 'bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300'
            : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
        }`}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
      >
        {isDirectory ? (
          <>
            <ChevronRight className={`w-3.5 h-3.5 shrink-0 transition ${isOpen ? 'rotate-90' : ''}`} />
            {isOpen ? <FolderOpen className="w-4 h-4 shrink-0 text-amber-500" /> : <Folder className="w-4 h-4 shrink-0 text-amber-500" />}
          </>
        ) : (
          <>
            <span className="w-3.5 h-3.5 shrink-0" />
            <FileText className="w-4 h-4 shrink-0 text-slate-400" />
          </>
        )}
        <span className="truncate">{node.name}</span>
      </button>

      {isDirectory && isOpen && node.children?.length ? (
        <div className="mt-0.5 space-y-0.5">
          {node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              selectedPath={selectedPath}
              onSelectPath={onSelectPath}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function extractCodeText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(extractCodeText).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    return extractCodeText((node as any).props.children);
  }
  return '';
}

function RichMarkdown({ content }: { content: string }) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const doCopy = (id: string, text: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
    } catch { /* ignore */ }
    setCopiedId(id);
    setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
  };

  return (
    <div className="markdown-body p-4">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false }]]}
        components={{
          pre({ children }) {
            return <pre className="code-block">{children}</pre>;
          },
          code({ className, children }: any) {
            const match = /language-([\w-]+)/.exec(className || '');
            const isInline = !className;

            if (!isInline) {
              const language = match ? match[1] : 'code';
              const codeText = extractCodeText(children);
              const blockId = `blk-${language}-${codeText.slice(0, 60)}`;
              if (language.toLowerCase() === 'mermaid') {
                return <MermaidBlock chart={codeText} />;
              }
              return (
                <div className="my-3 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-slate-50 dark:bg-slate-900 relative font-mono text-xs shadow-3xs max-w-full">
                  <div className="bg-slate-100/80 dark:bg-slate-800 px-4 py-1.5 flex items-center justify-between text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800 select-none">
                    <span className="text-[10px] font-mono font-bold uppercase tracking-wider">{language}</span>
                    <button
                      type="button"
                      onClick={() => doCopy(blockId, codeText)}
                      className="flex items-center space-x-1.5 hover:bg-slate-200 dark:hover:bg-slate-700 px-2.5 py-1 rounded text-[11px] text-slate-600 dark:text-slate-300 font-sans cursor-pointer transition-colors"
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
                  <pre className="p-4 overflow-x-auto text-[11.5px] leading-relaxed text-slate-800 dark:text-slate-200 bg-white dark:bg-slate-950">
                    <code className={className}>{children}</code>
                  </pre>
                </div>
              );
            }

            return (
              <code className="bg-slate-100 dark:bg-slate-800 border border-slate-150 dark:border-slate-700 text-slate-800 dark:text-slate-200 px-1.5 py-0.5 rounded font-mono text-[11px] font-semibold">
                {children}
              </code>
            );
          },
          p({ children, ...props }) {
            return <p className="text-slate-700 dark:text-slate-300 leading-relaxed my-2 text-[13.5px]" {...props}>{children}</p>;
          },
          ul({ children, ...props }) {
            return <ul className="list-disc pl-5 my-2 text-xs text-slate-700 dark:text-slate-300 space-y-1" {...props}>{children}</ul>;
          },
          ol({ children, ...props }) {
            return <ol className="list-decimal pl-5 my-2 text-xs text-slate-700 dark:text-slate-300 space-y-1" {...props}>{children}</ol>;
          },
          blockquote({ children, ...props }) {
            return <blockquote className="border-l-4 border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 pl-3.5 py-1.5 my-3 italic text-slate-600 dark:text-slate-400 rounded-r-lg" {...props}>{children}</blockquote>;
          },
          table({ children, ...props }) {
            return (
              <div className="overflow-x-auto my-3 rounded-lg border border-slate-200 dark:border-slate-700">
                <table className="min-w-full text-xs border-collapse" {...props}>{children}</table>
              </div>
            );
          },
          thead({ children, ...props }) {
            return <thead className="bg-slate-50 dark:bg-slate-800" {...props}>{children}</thead>;
          },
          tbody({ children, ...props }) {
            return <tbody className="divide-y divide-slate-200 dark:divide-slate-700" {...props}>{children}</tbody>;
          },
          tr({ children, ...props }) {
            return <tr className="even:bg-slate-50/50 dark:even:bg-slate-800/50" {...props}>{children}</tr>;
          },
          th({ children, ...props }) {
            return <th className="px-3 py-2 text-left font-semibold text-slate-700 dark:text-slate-200 border-b border-slate-200 dark:border-slate-700 text-[12px]" {...props}>{children}</th>;
          },
          td({ children, ...props }) {
            return <td className="px-3 py-2 text-slate-600 dark:text-slate-300 border-b border-slate-100 dark:border-slate-800 text-[12px]" {...props}>{children}</td>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function CodePreview({ filePath, content }: { filePath: string | null; content: string }) {
  const language = getLanguageFromPath(filePath);
  const highlighted = useMemo(() => {
    try {
      const result = hljs.highlight(content, { language: language || 'plaintext' });
      return result.value;
    } catch {
      const fallback = hljs.highlightAuto(content);
      return fallback.value;
    }
  }, [content, language]);

  return (
    <pre className="h-full overflow-auto p-4 text-xs leading-6 bg-white dark:bg-slate-950">
      <code
        className={`language-${language} hljs`}
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    </pre>
  );
}

export default function TabFiles({
  treeResponse,
  treeLoading,
  treeError,
  contentResponse,
  contentLoading,
  contentError,
  onRefresh,
  selectedPath,
  onSelectPath,
  onSaveContent,
  saving,
}: TabFilesProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [refreshSpinning, setRefreshSpinning] = useState(false);
  const [isTreePanelCollapsed, setIsTreePanelCollapsed] = useState(false);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [draftContent, setDraftContent] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  
  // Reset editing when selected file changes
  useEffect(() => {
    setEditingPath(null);
    setDraftContent('');
    setEditError(null);
  }, [selectedPath]);

  const firstFilePath = useMemo(() => {
    const visit = (nodes: SessionFileTreeNodeDTO[]): string | null => {
      for (const node of nodes) {
        if (node.kind === 'file') return node.path;
        if (node.children?.length) {
          const nested = visit(node.children);
          if (nested) return nested;
        }
      }
      return null;
    };
    return visit(treeResponse?.tree ?? []);
  }, [treeResponse]);

  useEffect(() => {
    if (!selectedPath && firstFilePath) {
      onSelectPath(firstFilePath);
    }
  }, [selectedPath, firstFilePath, onSelectPath]);

  const toggleExpanded = (pathValue: string) => {
    setExpanded((prev) => ({ ...prev, [pathValue]: !(prev[pathValue] ?? true) }));
  };

  return (
    <div className="flex-1 flex h-full overflow-hidden bg-slate-50/60 dark:bg-slate-900/10">
      {!isTreePanelCollapsed && (
        <aside className="w-[320px] shrink-0 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col">
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-bold text-slate-700 dark:text-slate-200">
                <FileCode2 className="w-4 h-4 text-blue-500" />
                <span>Files</span>
              </div>
              <div className="text-[10px] font-mono text-slate-400 truncate mt-0.5">
                {treeResponse?.root_path ?? '加载中…'}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => {
                  setRefreshSpinning(true);
                  setTimeout(() => setRefreshSpinning(false), 600);
                  onRefresh();
                }}
                className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 cursor-pointer"
                title="刷新文件树"
                aria-label="刷新文件树"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${treeLoading || refreshSpinning ? 'animate-spin' : ''}`} />
              </button>
              <button
                type="button"
                onClick={() => setIsTreePanelCollapsed(true)}
                className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 cursor-pointer"
                title="收起文件树"
                aria-label="收起文件树"
              >
                <PanelLeft className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-2">
            {treeLoading ? (
              <div className="h-full flex items-center justify-center text-xs text-slate-400">文件树加载中…</div>
            ) : treeError ? (
              <div className="h-full flex items-center justify-center text-xs text-red-500 px-4 text-center">{treeError}</div>
            ) : !treeResponse || treeResponse.tree.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-slate-400">当前项目暂无可预览文件</div>
            ) : (
              <div className="space-y-0.5">
                {treeResponse.tree.map((node) => (
                  <FileTreeNode
                    key={node.path}
                    node={node}
                    depth={0}
                    expanded={expanded}
                    onToggle={toggleExpanded}
                    selectedPath={selectedPath}
                    onSelectPath={onSelectPath}
                  />
                ))}
              </div>
            )}
          </div>
        </aside>
      )}

      <section className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {isTreePanelCollapsed && (
              <button
                type="button"
                onClick={() => setIsTreePanelCollapsed(false)}
                className="shrink-0 p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 cursor-pointer"
                title="展开文件树"
                aria-label="展开文件树"
              >
                <PanelLeft className="w-3.5 h-3.5" />
              </button>
            )}
            <div className="text-sm font-semibold text-slate-700 dark:text-slate-200 truncate">
              {selectedPath ?? '请选择文件'}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {editingPath !== null ? (
              <>
                <span className="text-xs text-slate-400">编辑模式</span>
                <button
                  type="button"
                  onClick={async () => {
                    if (!selectedPath) return;
                    setEditError(null);
                    try {
                      await onSaveContent?.(editingPath!, draftContent);
                      setEditingPath(null);
                      setDraftContent('');
                    } catch (err) {
                      setEditError(err instanceof Error ? err.message : '保存失败');
                    }
                  }}
                  disabled={saving}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 cursor-pointer transition"
                >
                  <Save className="w-3.5 h-3.5" />
                  保存
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingPath(null);
                    setDraftContent('');
                    setEditError(null);
                  }}
                  disabled={saving}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 disabled:opacity-50 cursor-pointer transition"
                >
                  <X className="w-3.5 h-3.5" />
                  取消
                </button>
              </>
            ) : selectedPath && contentResponse && !contentLoading && !contentError && !contentResponse.truncated ? (
              <button
                type="button"
                onClick={() => {
                  setDraftContent(contentResponse.content);
                  setEditingPath(selectedPath);
                }}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 cursor-pointer transition"
              >
                <Edit3 className="w-3.5 h-3.5" />
                编辑
              </button>
            ) : null}
          </div>
          <div className="text-[11px] text-slate-400 shrink-0">
            {isMarkdownFile(selectedPath) ? 'Markdown 预览' : '代码预览'}
          </div>
        </div>

        <div className="flex-1 overflow-auto p-5">
          {contentLoading ? (
            <div className="h-full flex items-center justify-center text-xs text-slate-400">文件内容加载中…</div>
          ) : contentError ? (
            <div className="h-full flex items-center justify-center text-xs text-red-500 px-4 text-center">{contentError}</div>
          ) : !selectedPath ? (
            <div className="h-full flex items-center justify-center text-xs text-slate-400">请选择左侧文件进行预览</div>
          ) : !contentResponse ? (
            <div className="h-full flex items-center justify-center text-xs text-slate-400">暂无内容</div>
          ) : (
            <div className="h-full rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
              <div className="px-4 py-2 border-b border-slate-200 dark:border-slate-800 text-[11px] text-slate-400 flex items-center justify-between gap-3">
                <span className="truncate">{isMarkdownFile(selectedPath) ? 'Markdown 渲染' : getLanguageFromPath(selectedPath)}</span>
                {contentResponse.truncated ? <span>已截断（最多 1MB）</span> : null}
              </div>
              <div className="h-[calc(100%-41px)] overflow-auto">
                {editingPath !== null ? (
                  <textarea
                    value={draftContent}
                    onChange={(e) => setDraftContent(e.target.value)}
                    className="w-full h-full p-4 text-xs leading-6 font-mono resize-none focus:outline-none bg-white dark:bg-slate-950 text-slate-800 dark:text-slate-200 border-0"
                    spellCheck={false}
                  />
                ) : (
                  isMarkdownFile(selectedPath) ? (
                    <RichMarkdown content={contentResponse.content} />
                  ) : (
                    <CodePreview filePath={selectedPath} content={contentResponse.content} />
                  )
                )}
              </div>
              {editError && (
                <div className="px-4 py-2 border-t border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/20 text-xs text-red-600 dark:text-red-400">
                  保存失败: {editError}
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
