import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import type { ChatMessageDTO } from '@piplus/shared';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import {
  Send,
  Square,
  Copy,
  Check,
  Sparkles,
  ArrowUp,
  ScrollText,
  LoaderCircle,
  OctagonX,
  Wrench,
  ChevronDown,
  ChevronRight,
  Terminal,
  Archive,
} from 'lucide-react';

interface ModelOption {
  provider: string;
  id: string;
  label: string;
}

interface TabChatProps {
  messages: ChatMessageDTO[];
  pendingUserMessages: ChatMessageDTO[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onSend: (content: string) => void;
  onStop: () => void;
  sending: boolean;
  runtimeStatus: string;
  streamNote: string;
  streamingContent: string;
  sessionTitle?: string;
  wsConnected?: boolean;
  selectedSessionId?: string | null;
  sendShortcutMode?: 'enter' | 'mod_enter';
  models?: ModelOption[];
  currentModelValue?: string;
  onModelSelect?: (provider: string, id: string) => void;
  onArchiveSession?: () => void;
  archivePending?: boolean;
  showArchiveButton?: boolean;
}

function extractCodeText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(extractCodeText).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    return extractCodeText((node as any).props.children);
  }
  return '';
}

function sanitizeStreamingContent(content: string): string {
  const lastFenceIdx = content.lastIndexOf('```');
  if (lastFenceIdx === -1) return content;
  let count = 0;
  let idx = 0;
  while (true) {
    const pos = content.indexOf('```', idx);
    if (pos === -1) break;
    count++;
    idx = pos + 3;
  }
  if (count % 2 === 1) {
    return content.slice(0, lastFenceIdx).trimEnd();
  }
  return content;
}

export default function TabChat({
  messages,
  pendingUserMessages,
  hasMore,
  loadingMore,
  onLoadMore,
  onSend,
  onStop,
  sending,
  runtimeStatus,
  streamNote,
  streamingContent,
  sessionTitle,
  wsConnected,
  selectedSessionId,
  sendShortcutMode,
  models,
  currentModelValue,
  onModelSelect,
  onArchiveSession,
  archivePending,
  showArchiveButton,
}: TabChatProps) {
  const [draft, setDraft] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedToolIds, setExpandedToolIds] = useState<Set<string>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const prevDisplayMessagesRef = useRef<ChatMessageDTO[]>([]);
  const prevScrollHeightRef = useRef<number | null>(null);
  const lastChangeTypeRef = useRef<'none' | 'prepend' | 'append'>('none');
  const sessionJustSwitchedRef = useRef(false);

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  };

  const allMessages = [...messages];
  // Append pending user messages that haven't been confirmed.
  // The optimistic message id differs from the persisted backend id,
  // so dedupe by latest user message content instead of id only.
  for (const pm of pendingUserMessages) {
    const hasConfirmedMatch = allMessages.some((m) =>
      m.role === 'user' &&
      m.content_text === pm.content_text &&
      Math.abs(new Date(m.created_at).getTime() - new Date(pm.created_at).getTime()) < 60_000,
    );
    const hasPendingMatch = allMessages.some((m) => m.id === pm.id);
    if (!hasConfirmedMatch && !hasPendingMatch) {
      allMessages.push(pm);
    }
  }

  const displayMessages = allMessages.length > 0
    ? allMessages
    : [
        {
          id: 'empty_placeholder',
          role: 'assistant' as const,
          message_kind: 'normal' as const,
          source_session_id: null,
          content_text: '当前会话暂无消息。发送第一条消息开始对话。',
          created_at: new Date().toISOString(),
        },
      ];

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const prevMessages = prevDisplayMessagesRef.current;
    const currentMessages = displayMessages;

    const prevFirstId = prevMessages[0]?.id;
    const prevLastId = prevMessages[prevMessages.length - 1]?.id;
    const currentFirstId = currentMessages[0]?.id;
    const currentLastId = currentMessages[currentMessages.length - 1]?.id;

    const prepended =
      prevMessages.length > 0 &&
      currentMessages.length > prevMessages.length &&
      prevFirstId !== currentFirstId &&
      prevLastId === currentLastId;

    const appended =
      currentMessages.length > prevMessages.length ||
      (prevLastId !== currentLastId && currentLastId !== undefined);

    lastChangeTypeRef.current = prepended ? 'prepend' : appended ? 'append' : 'none';

    if (prepended && prevScrollHeightRef.current !== null) {
      const heightDelta = container.scrollHeight - prevScrollHeightRef.current;
      container.scrollTop += heightDelta;
    }

    prevDisplayMessagesRef.current = currentMessages;
    prevScrollHeightRef.current = container.scrollHeight;
  }, [displayMessages]);

  // Auto-load more when scrolling to the top (sentinel becomes visible)
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore || !onLoadMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && hasMore && !loadingMore) {
            onLoadMore();
          }
        }
      },
      {
        root: scrollContainerRef.current,
        rootMargin: '100px 0px 0px 0px',
        threshold: 0,
      },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, onLoadMore]);

  // 独立标记：session 切换时设 flag，等真实消息渲染后再跳到底部
  useEffect(() => {
    sessionJustSwitchedRef.current = true;
  }, [selectedSessionId]);

  // useLayoutEffect：在浏览器重绘前同步吸附底部，避免抽搐
  useLayoutEffect(() => {
    if (!streamingContent) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    const isNearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < 150;
    if (isNearBottom) {
      container.scrollTop = container.scrollHeight - container.clientHeight;
    }
  }, [streamingContent]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    // 刚刚切换 session → 等真实消息加载后立刻跳到底部
    if (sessionJustSwitchedRef.current && displayMessages.length > 0) {
      const isPlaceholder = displayMessages.length === 1 && displayMessages[0].id === 'empty_placeholder';
      if (!isPlaceholder) {
        sessionJustSwitchedRef.current = false;
        requestAnimationFrame(() => requestAnimationFrame(() => scrollToBottom('auto')));
        return;
      }
    }

    if (streamingContent || lastChangeTypeRef.current === 'prepend') {
      return;
    }

    const isNearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < 150;

    if (lastChangeTypeRef.current === 'append' || isNearBottom) {
      scrollToBottom('smooth');
    }
  }, [displayMessages, streamingContent, selectedSessionId]);

  const handleSubmit = () => {
    const content = draft.trim();
    if (!content || sending) return;
    setDraft('');
    onSend(content);
  };

  const handleCopyCode = async (text: string, id: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      setCopiedId(null);
    }
  };

  const isRunning = runtimeStatus === 'running';

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-100/40 dark:bg-slate-900/10 relative">
      {/* Messages */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
        {/* Sentinel for IntersectionObserver auto-load */}
        <div ref={sentinelRef} className="h-0.5" />

        {hasMore && (
          <div className="flex justify-center">
            <button
              className="flex items-center space-x-1.5 px-3 py-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition cursor-pointer disabled:opacity-50"
              disabled={loadingMore}
              onClick={onLoadMore}
            >
              <ScrollText className="w-3.5 h-3.5" />
              <span>{loadingMore ? '加载中…' : '加载更早消息'}</span>
            </button>
          </div>
        )}

        {displayMessages.map((msg) => {
          const isUser = msg.role === 'user';
          const isToolCall = msg.message_kind === 'tool_call';
          const isTool = msg.message_kind === 'tool' || msg.role === 'tool';

          // Tool call message: collapsible card
          if (isToolCall) {
            const toolName = msg.tool_name || 'unknown';
            const isExpanded = expandedToolIds.has(msg.id);
            const toggleExpand = () => {
              setExpandedToolIds((prev) => {
                const next = new Set(prev);
                if (next.has(msg.id)) next.delete(msg.id);
                else next.add(msg.id);
                return next;
              });
            };

            let argsStr = '';
            if (msg.tool_args_json) {
              try {
                argsStr = JSON.stringify(JSON.parse(msg.tool_args_json), null, 2);
              } catch {
                argsStr = msg.tool_args_json;
              }
            }

            return (
              <div key={msg.id} className="flex justify-start items-start w-full">
                <div className="flex flex-col items-start max-w-full flex-1">
                  <div
                    className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-xl overflow-hidden cursor-pointer select-none transition-colors hover:bg-amber-100/80 dark:hover:bg-amber-900/40"
                    onClick={toggleExpand}
                  >
                    <div className="px-3 py-2 flex items-center gap-2">
                      {isExpanded ? (
                        <ChevronDown className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
                      )}
                      <Wrench className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
                      <span className="text-xs font-semibold text-amber-800 dark:text-amber-300 font-mono">
                        {toolName}
                      </span>
                    </div>
                    {isExpanded && argsStr && (
                      <div className="border-t border-amber-200 dark:border-amber-800 px-3 py-2">
                        <pre className="text-[11px] text-amber-900 dark:text-amber-200 font-mono whitespace-pre-wrap overflow-x-auto leading-relaxed">
                          {argsStr}
                        </pre>
                      </div>
                    )}
                  </div>
                  <span className="text-[10px] text-slate-400 dark:text-slate-500 mt-1 px-1 font-mono">
                    {new Date(msg.created_at).toLocaleTimeString()}
                  </span>
                </div>
              </div>
            );
          }

          // Tool result message: compact result card
          if (isTool) {
            const toolName = msg.tool_name || 'unknown';
            const isError = /^error/i.test(msg.content_text?.trim() ?? '');
            const summary = msg.content_text
              ? msg.content_text.slice(0, 200) + (msg.content_text.length > 200 ? '…' : '')
              : '(empty result)';

            const colorScheme = isError
              ? {
                  bg: 'bg-red-50 dark:bg-red-950/30',
                  border: 'border-red-200 dark:border-red-800',
                  borderT: 'border-red-200 dark:border-red-800',
                  icon: 'text-red-600 dark:text-red-400',
                  label: 'text-red-800 dark:text-red-300',
                  text: 'text-red-900 dark:text-red-200',
                  suffix: 'text-red-600/60 dark:text-red-400/60',
                }
              : {
                  bg: 'bg-emerald-50 dark:bg-emerald-950/30',
                  border: 'border-emerald-200 dark:border-emerald-800',
                  borderT: 'border-emerald-200 dark:border-emerald-800',
                  icon: 'text-emerald-600 dark:text-emerald-400',
                  label: 'text-emerald-800 dark:text-emerald-300',
                  text: 'text-emerald-900 dark:text-emerald-200',
                  suffix: 'text-emerald-600/60 dark:text-emerald-400/60',
                };

            return (
              <div key={msg.id} className="flex justify-start items-start w-full">
                <div className="flex flex-col items-start max-w-full flex-1">
                  <div className={`${colorScheme.bg} ${colorScheme.border} rounded-xl overflow-hidden`}>
                    <div className="px-3 py-2 flex items-center gap-2">
                      <Terminal className={`w-3.5 h-3.5 ${colorScheme.icon} shrink-0`} />
                      <span className={`text-xs font-semibold ${colorScheme.label} font-mono`}>
                        {toolName}
                      </span>
                      <span className={`text-[10px] ${colorScheme.suffix} ml-1`}>
                        {isError ? '错误' : '结果'}
                      </span>
                    </div>
                    {msg.content_text && (
                      <div className={`border-t ${colorScheme.borderT} px-3 py-2`}>
                        <div className={`text-[11px] ${colorScheme.text} font-mono whitespace-pre-wrap leading-relaxed max-h-32 overflow-y-auto`}>
                          {summary}
                        </div>
                      </div>
                    )}
                  </div>
                  <span className="text-[10px] text-slate-400 dark:text-slate-500 mt-1 px-1 font-mono">
                    {new Date(msg.created_at).toLocaleTimeString()}
                  </span>
                </div>
              </div>
            );
          }

          return (
            <div key={msg.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'} items-start w-full min-w-0`}>
              <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} min-w-0 ${isUser ? 'max-w-[85%]' : 'max-w-full flex-1'}`}>
                {isUser ? (
                  <div className="bg-blue-600 text-white rounded-2xl px-4 py-2.5 text-sm shadow-xs font-sans leading-relaxed">
                    {msg.content_text}
                  </div>
                ) : (
                  <div className="text-slate-800 dark:text-slate-200 w-full pl-0">
                    <div className="markdown-body">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        rehypePlugins={[[rehypeHighlight, { detect: false }]]}
                        components={{
                          pre({ children }) {
                            return <pre className="code-block">{children}</pre>;
                          },
                          code({ className, children, ...props }: any) {
                            const match = /language-(\w+)/.exec(className || '');
                            const codeText = extractCodeText(children).replace(/\n$/, '');
                            const isInline = !className;

                            if (!isInline) {
                              const language = match ? match[1] : 'code';
                              const blockId = `${msg.id}-${language}-${codeText}`;
                              return (
                                <div className="my-3 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-slate-50 dark:bg-slate-900 relative font-mono text-xs shadow-3xs max-w-full">
                                  <div className="bg-slate-100/80 dark:bg-slate-800 px-4 py-1.5 flex items-center justify-between text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800 select-none">
                                    <span className="text-[10px] font-mono font-bold uppercase tracking-wider">{language}</span>
                                    <button
                                      type="button"
                                      onClick={() => handleCopyCode(codeText, blockId)}
                                      className="flex items-center space-x-1.5 hover:bg-slate-200 dark:hover:bg-slate-800 px-2.5 py-1 rounded text-[11px] text-slate-600 dark:text-slate-300 font-sans cursor-pointer transition-colors"
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
                              <code className="bg-slate-100 dark:bg-slate-800 border border-slate-150 dark:border-slate-700 text-slate-800 dark:text-slate-200 px-1.5 py-0.5 rounded font-mono text-[11px] font-semibold" {...props}>
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
                                <table className="min-w-full text-xs border-collapse" {...props}>
                                  {children}
                                </table>
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
                        {msg.content_text}
                      </ReactMarkdown>
                    </div>
                  </div>
                )}
                <span className="text-[10px] text-slate-400 dark:text-slate-500 mt-2 px-1 font-mono">
                  {new Date(msg.created_at).toLocaleTimeString()}
                </span>
              </div>
            </div>
          );
        })}

        {/* Streaming content */}
        {streamingContent && (
          <div className="flex justify-start items-start w-full min-w-0">
            <div className="flex flex-col items-start max-w-full flex-1 min-w-0">
              <div className="text-slate-800 dark:text-slate-200 w-full pl-0">
                <div className="markdown-body">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[[rehypeHighlight, { detect: false }]]}
                    components={{
                      pre({ children }) {
                        return <pre className="code-block">{children}</pre>;
                      },
                      code({ className, children, ...codeProps }: any) {
                        const match = /language-(\w+)/.exec(className || '');
                        const codeText = extractCodeText(children).replace(/\n$/, '');
                        const isInline = !className;

                        if (!isInline) {
                          const language = match ? match[1] : 'code';
                          const blockId = `stream-${language}-${codeText}`;
                          return (
                            <div className="my-3 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-slate-50 dark:bg-slate-900 relative font-mono text-xs shadow-3xs max-w-full">
                              <div className="bg-slate-100/80 dark:bg-slate-800 px-4 py-1.5 flex items-center justify-between text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800 select-none">
                                <span className="text-[10px] font-mono font-bold uppercase tracking-wider">{language}</span>
                                <button
                                  type="button"
                                  onClick={() => handleCopyCode(codeText, blockId)}
                                  className="flex items-center space-x-1.5 hover:bg-slate-200 dark:hover:bg-slate-800 px-2.5 py-1 rounded text-[11px] text-slate-600 dark:text-slate-300 font-sans cursor-pointer transition-colors"
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
                          <code className="bg-slate-100 dark:bg-slate-800 border border-slate-150 dark:border-slate-700 text-slate-800 dark:text-slate-200 px-1.5 py-0.5 rounded font-mono text-[11px] font-semibold" {...codeProps}>
                            {children}
                          </code>
                        );
                      },
                      p({ children, ...pProps }) {
                        return <p className="text-slate-700 dark:text-slate-300 leading-relaxed my-2 text-[13.5px]" {...pProps}>{children}</p>;
                      },
                      ul({ children, ...ulProps }) {
                        return <ul className="list-disc pl-5 my-2 text-xs text-slate-700 dark:text-slate-300 space-y-1" {...ulProps}>{children}</ul>;
                      },
                      ol({ children, ...olProps }) {
                        return <ol className="list-decimal pl-5 my-2 text-xs text-slate-700 dark:text-slate-300 space-y-1" {...olProps}>{children}</ol>;
                      },
                      blockquote({ children, ...bqProps }) {
                        return <blockquote className="border-l-4 border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 pl-3.5 py-1.5 my-3 italic text-slate-600 dark:text-slate-400 rounded-r-lg" {...bqProps}>{children}</blockquote>;
                      },
                      table({ children, ...tableProps }) {
                        return (
                          <div className="overflow-x-auto my-3 rounded-lg border border-slate-200 dark:border-slate-700">
                            <table className="min-w-full text-xs border-collapse" {...tableProps}>
                              {children}
                            </table>
                          </div>
                        );
                      },
                      thead({ children, ...theadProps }) {
                        return <thead className="bg-slate-50 dark:bg-slate-800" {...theadProps}>{children}</thead>;
                      },
                      tbody({ children, ...tbodyProps }) {
                        return <tbody className="divide-y divide-slate-200 dark:divide-slate-700" {...tbodyProps}>{children}</tbody>;
                      },
                      tr({ children, ...trProps }) {
                        return <tr className="even:bg-slate-50/50 dark:even:bg-slate-800/50" {...trProps}>{children}</tr>;
                      },
                      th({ children, ...thProps }) {
                        return <th className="px-3 py-2 text-left font-semibold text-slate-700 dark:text-slate-200 border-b border-slate-200 dark:border-slate-700 text-[12px]" {...thProps}>{children}</th>;
                      },
                      td({ children, ...tdProps }) {
                        return <td className="px-3 py-2 text-slate-600 dark:text-slate-300 border-b border-slate-100 dark:border-slate-800 text-[12px]" {...tdProps}>{children}</td>;
                      },
                    }}
                  >
                    {sanitizeStreamingContent(streamingContent)}
                  </ReactMarkdown>
                </div>
              </div>
              <span className="text-[10px] text-blue-500 mt-2 px-1 font-mono animate-pulse">
                streaming…
              </span>
            </div>
          </div>
        )}

        {/* Typing indicator */}
        {isRunning && !streamingContent && (
          <div className="flex items-start w-full">
            <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700/80 rounded-2xl p-4 shadow-2xs flex items-center space-x-2 text-xs text-slate-500 dark:text-slate-400 font-sans">
              <div className="flex space-x-1">
                <span className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
              <span className="italic pl-1 text-slate-600 dark:text-slate-300 font-medium">
                正在生成回复…
              </span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Suggestions */}
      {false && allMessages.length > 0 && !isRunning && (
        <div className="px-6 py-2 flex flex-wrap gap-2 select-none shrink-0 bg-white/40 dark:bg-slate-900/60 border-t border-slate-100 dark:border-slate-800/60">
          <button
            onClick={() => onSend('生成当前会话的 Git Diff')}
            className="text-[11px] bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 border border-slate-200/80 dark:border-slate-700 rounded-full px-3 py-1 text-slate-600 dark:text-slate-300 shadow-3xs cursor-pointer transition-colors"
          >
            📊 生成 Git Diff
          </button>
          <button
            onClick={() => onSend('分析当前会话状态并总结')}
            className="text-[11px] bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 border border-slate-200/80 dark:border-slate-700 rounded-full px-3 py-1 text-slate-600 dark:text-slate-300 shadow-3xs cursor-pointer transition-colors"
          >
            🧩 分析会话
          </button>
        </div>
      )}

      {/* Input area */}
      {/* Model selector & archive bar */}
      <div className="shrink-0 px-4 md:px-5 bg-slate-50 dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800">
        <div className="mx-auto max-w-[900px] flex items-center gap-3 py-2">
          {models && models.length > 0 && onModelSelect && (
            <div className="relative">
              <select
                value={currentModelValue ?? ''}
                onChange={(e) => {
                  const [provider, id] = e.target.value.split('/');
                  if (provider && id) onModelSelect(provider, id);
                }}
                disabled={runtimeStatus === 'running'}
                className="appearance-none bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-xl px-2.5 py-1 pr-7 text-[11px] font-semibold text-slate-600 dark:text-slate-300 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer disabled:opacity-50"
              >
                {models.map((m) => (
                  <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                    {m.provider} / {m.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="w-3 h-3 absolute right-2 top-1.5 pointer-events-none text-slate-400" />
            </div>
          )}
          {showArchiveButton && onArchiveSession && (
            <button
              onClick={onArchiveSession}
              className="flex items-center space-x-1 px-2.5 py-1 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl text-[11px] font-semibold text-slate-500 dark:text-slate-400 transition cursor-pointer disabled:opacity-50"
              disabled={archivePending}
            >
              <Archive className="w-3 h-3" />
              <span>{archivePending ? '...' : 'Archive'}</span>
            </button>
          )}
          <div className="flex-1" />
          {streamNote && (
            <span className="text-[11px] text-blue-600 dark:text-blue-400 font-medium">
              {streamNote}
            </span>
          )}
        </div>
      </div>

      {/* Input area */}
      <div className="shrink-0 px-4 py-2 md:px-5 bg-slate-50 dark:bg-slate-900">
        <div className="mx-auto max-w-[900px]">
          <div className="flex flex-col gap-2">
            <textarea
              className="w-full min-h-[68px] resize-none px-3 py-2 text-sm border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-100 placeholder:text-slate-400 transition"
              disabled={isRunning || sending}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;

                if (sendShortcutMode === 'mod_enter') {
                  // Ctrl/Cmd+Enter 发送，Enter 换行
                  if (e.metaKey || e.ctrlKey) {
                    e.preventDefault();
                    handleSubmit();
                    return;
                  }
                  // 回车（无修饰键）→ 换行
                } else {
                  // Enter 发送，Ctrl/Cmd+Enter 换行（默认）
                  if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                    e.preventDefault();
                    handleSubmit();
                    return;
                  }
                  // Shift+Enter / Ctrl+Enter → 换行
                }

                // 在光标处插入换行（跨浏览器可靠方案）
                e.preventDefault();
                const textarea = e.target as HTMLTextAreaElement;
                const start = textarea.selectionStart;
                const end = textarea.selectionEnd;
                setDraft((prev) => prev.slice(0, start) + '\n' + prev.slice(end));
                requestAnimationFrame(() => {
                  textarea.selectionStart = textarea.selectionEnd = start + 1;
                });
              }}
              placeholder="向当前会话发送消息…"
              value={draft}
            />
            <div className="flex items-center gap-2.5 px-1">
              {/* WS connection indicator */}
              <div className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-emerald-500' : 'bg-red-400'}`} />
                <span className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">
                  {wsConnected ? 'WS' : 'WS 离线'}
                </span>
              </div>
              {!isRunning && (
                <span className="text-[10px] text-slate-400 dark:text-slate-500 ml-auto">
                  {sendShortcutMode === 'mod_enter' ? 'Ctrl/Cmd+Enter 发送' : 'Enter 发送 · Ctrl/Cmd+Enter 换行'}
                </span>
              )}
              {isRunning && (
                <button
                  className="flex items-center space-x-1.5 px-3 py-1.5 ml-auto bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-xl text-red-600 dark:text-red-400 font-semibold hover:bg-red-100 dark:hover:bg-red-900/50 text-xs transition cursor-pointer"
                  onClick={onStop}
                >
                  <OctagonX className="w-3.5 h-3.5" />
                  <span>停止</span>
                </button>
              )}
              <button
                className="flex items-center space-x-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl text-xs transition cursor-pointer disabled:opacity-50"
                disabled={isRunning || sending || draft.trim().length === 0}
                onClick={handleSubmit}
              >
                <span>{sending ? '发送中…' : '发送'}</span>
                <ArrowUp className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
