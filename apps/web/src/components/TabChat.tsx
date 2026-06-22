import React, { useState, useRef, useEffect } from 'react';
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
} from 'lucide-react';

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
}: TabChatProps) {
  const [draft, setDraft] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  const handleSubmit = () => {
    const content = draft.trim();
    if (!content || sending) return;
    setDraft('');
    onSend(content);
  };

  const handleCopyCode = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const isRunning = runtimeStatus === 'running';
  const allMessages = [...messages];
  // Append pending user messages that haven't been confirmed
  for (const pm of pendingUserMessages) {
    if (!allMessages.find((m) => m.id === pm.id)) {
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

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-100/40 dark:bg-slate-900/10 relative">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
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
          return (
            <div key={msg.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'} items-start w-full`}>
              <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} ${isUser ? 'max-w-[85%]' : 'max-w-full flex-1'}`}>
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
                            const codeText = String(children).replace(/\n$/, '');
                            const isInline = !className;

                            if (!isInline) {
                              const language = match ? match[1] : 'code';
                              const blockId = Math.random().toString(36).substr(2, 9);
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
                                    <code className="font-mono">{codeText}</code>
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
          <div className="flex justify-start items-start w-full">
            <div className="flex flex-col items-start max-w-full flex-1">
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
                        const codeText = String(children).replace(/\n$/, '');
                        const isInline = !className;

                        if (!isInline) {
                          const language = match ? match[1] : 'code';
                          const blockId = Math.random().toString(36).substr(2, 9);
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
                                <code className="font-mono">{codeText}</code>
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
      <div className="shrink-0 px-4 py-3 md:px-5 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800">
        <div className="mx-auto max-w-[900px]">
          <div className="flex flex-col gap-2.5">
            <textarea
              className="w-full min-h-[68px] resize-none px-3 py-2 text-sm border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-100 placeholder:text-slate-400 transition"
              disabled={isRunning || sending}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleSubmit();
                }
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
                <span className="text-[10px] text-slate-400 dark:text-slate-500 ml-auto">Ctrl / Cmd + Enter 发送</span>
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
