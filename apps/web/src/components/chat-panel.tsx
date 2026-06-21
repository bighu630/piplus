'use client';

import { ArrowUp, LoaderCircle, OctagonX, ScrollText } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import type { ChatMessageDTO } from '@piplus/shared';
import { ScrollArea } from './ui/scroll-area';
import { motion } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

type ModelItem = {
  provider: string;
  id: string;
  label: string;
};

type Props = {
  canLoadMore?: boolean;
  disabled?: boolean;
  loadingMore?: boolean;
  messages?: ChatMessageDTO[];
  models?: ModelItem[];
  onLoadMore?: () => void | Promise<void>;
  onModelSelect?: (provider: string, id: string) => void | Promise<void>;
  onSend?: (content: string) => void | Promise<void>;
  onStop?: () => void | Promise<void>;
  sending?: boolean;
  stopDisabled?: boolean;
  stopArmed?: boolean;
  streamNote?: string;
  sessionTitle?: string;
  modelLabel?: string;
  modelDisabled?: boolean;
};

export function ChatPanel({
  canLoadMore = false,
  disabled = false,
  loadingMore = false,
  messages = [],
  models = [],
  onLoadMore,
  onSend,
  onStop,
  onModelSelect,
  sending = false,
  stopDisabled = true,
  stopArmed = false,
  streamNote,
  sessionTitle,
  modelLabel,
  modelDisabled = false,
}: Props) {
  const [draft, setDraft] = useState('');
  const [modelOpen, setModelOpen] = useState(false);
  const messagesViewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (disabled) setDraft('');
  }, [disabled]);

  const visibleMessages = useMemo<ChatMessageDTO[]>(
    () =>
      messages.length > 0
        ? messages
        : [
            {
              id: 'fallback_1',
              role: 'assistant',
              message_kind: 'normal',
              source_session_id: null,
              content_text: disabled
                ? '先在左侧选择一个 session，随后这里会展示该 session 的真实聊天记录。'
                : '当前 session 暂时还没有消息。你可以直接开始对话。',
              created_at: new Date().toISOString(),
            } satisfies ChatMessageDTO,
          ],
    [disabled, messages],
  );

  async function submit() {
    const content = draft.trim();
    if (!content || disabled || !onSend) return;
    setDraft('');
    await onSend(content);
  }

  const isStopping = streamNote === 'stopping';

  useEffect(() => {
    const viewport = messagesViewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [sessionTitle, visibleMessages.length]);

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto,minmax(0,1fr),auto]">
      <div className="px-5 py-3 md:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-xl font-semibold tracking-[-0.03em] text-[var(--text)]">{sessionTitle ?? 'Chat'}</h3>
          </div>
          <div className="flex items-center gap-2">
            {modelLabel ? (
              <div className="relative">
                <button
                  className={`ghost-button ghost-button-sm ${modelDisabled ? 'opacity-50 pointer-events-none' : ''}`}
                  disabled={modelDisabled}
                  onClick={() => !modelDisabled && setModelOpen(!modelOpen)}
                  onBlur={() => setTimeout(() => setModelOpen(false), 150)}
                  type="button"
                >
                  {modelLabel}
                </button>
                {modelOpen && models.length > 0 ? (
                  <div className="absolute right-0 top-full z-50 mt-2 min-w-[220px] rounded-[18px] border border-[var(--line)] bg-[linear-gradient(180deg,rgba(24,31,42,0.94),rgba(16,20,27,0.9))] p-1.5 shadow-[var(--shadow-floating)] backdrop-blur-xl">
                    {models.map((m) => (
                      <button
                        key={`${m.provider}/${m.id}`}
                        className="w-full whitespace-nowrap rounded-xl px-3 py-2 text-left text-sm text-[var(--text)] transition-colors hover:bg-white/10"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          onModelSelect?.(m.provider, m.id);
                          setModelOpen(false);
                        }}
                        type="button"
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            {streamNote ? (
              <span className="chip chip-stream">
                <LoaderCircle size={12} strokeWidth={2} className="animate-spin" />
                {streamNote}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0 max-h-[calc(100%-72px)]" viewportClassName="px-4 py-4 pb-5 md:px-6 md:pb-5" viewportRef={messagesViewportRef}>
        <div className="mx-auto flex w-full max-w-[900px] flex-col justify-end gap-5">
          {canLoadMore ? (
            <div className="flex justify-center">
              <button className="ghost-button ghost-button-sm ghost-button-icon" disabled={loadingMore} onClick={() => void onLoadMore?.()} type="button">
                <ScrollText size={14} strokeWidth={2} />
                <span>{loadingMore ? '加载中…' : '加载更早消息'}</span>
              </button>
            </div>
          ) : null}
          {visibleMessages.map((message) => (
            <Bubble key={message.id} message={message} />
          ))}
        </div>
      </ScrollArea>

      <div className="shrink-0 px-4 py-3 md:px-5">
        <div className={`mx-auto max-w-[900px] transition-colors duration-200 ${
          stopArmed ? 'bg-[rgba(248,113,113,0.04)]' : ''
        }`}>
          <div className="flex items-center justify-end gap-3 px-1 pb-2">
            <span className="text-xs text-[var(--text-dim)]">Ctrl / Cmd + Enter</span>
          </div>
          <div className="flex flex-col gap-2.5">
            <textarea
              className={`chat-input min-h-[68px] w-full resize-none ${stopArmed ? 'placeholder:text-[#f87171]/60' : ''}`}
              disabled={disabled || sending}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder={disabled ? '请先选择一个 session' : '向当前 session 发送消息'}
              value={draft}
            />
            <div className="flex items-center justify-end gap-2.5 px-1">
              {isStopping ? (
                <span className="flex items-center gap-1.5 rounded-[14px] bg-[rgba(248,113,113,0.08)] px-3 py-1.5 text-xs font-medium text-[#f87171]">
                  <LoaderCircle size={12} strokeWidth={2.2} className="animate-spin" />
                  正在停止…
                </span>
              ) : (
                <button
                  className={`ghost-button ghost-button-sm ghost-button-icon ${stopArmed ? 'bg-[rgba(248,113,113,0.12)] text-[#f87171] ring-1 ring-[#f87171]/30' : ''}`}
                  disabled={disabled || stopDisabled}
                  onClick={() => void onStop?.()}
                  type="button"
                >
                  <OctagonX size={14} strokeWidth={2.2} />
                  <span>{stopArmed ? '按 Esc 执行停止' : '停止'}</span>
                </button>
              )}
              <button
                className="primary-button primary-button-icon"
                disabled={disabled || sending || draft.trim().length === 0}
                onClick={() => void submit()}
                type="button"
              >
                <span>{sending ? '发送中…' : '发送'}</span>
                <ArrowUp size={15} strokeWidth={2.2} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 对于流式内容，移除尾部未闭合的 ``` 代码围栏，
 * 防止 LLM 写到一半时整个后续内容被渲染为代码块。
 */
function sanitizeStreamingContent(content: string): string {
  // 只在有 ``` 时才做检查，避免额外的开销
  const lastFenceIdx = content.lastIndexOf('```');
  if (lastFenceIdx === -1) return content;

  // 统计完整的 ``` 出现次数
  let count = 0;
  let idx = 0;
  while (true) {
    const pos = content.indexOf('```', idx);
    if (pos === -1) break;
    count++;
    idx = pos + 3;
  }

  // 如果 ``` 数量为奇数，说明尾部未闭合，去掉最后一个 ```
  if (count % 2 === 1) {
    return content.slice(0, lastFenceIdx).trimEnd();
  }
  return content;
}

const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
  const safeContent = sanitizeStreamingContent(content);

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false }]]}
        components={{
          pre({ children }) {
            return <pre className="code-block">{children}</pre>;
          },
          code({ className, children, ...props }: ComponentProps<'code'> & { className?: string }) {
            const isInline = !className;
            if (isInline) {
              return (
                <code className="inline-code" {...props}>
                  {children}
                </code>
              );
            }
            const lang = className?.replace('language-', '') ?? '';
            return (
              <div className="code-block-wrap">
                {lang ? <div className="code-block-lang">{lang}</div> : null}
                <code className={className} {...props}>
                  {children}
                </code>
              </div>
            );
          },
          a({ href, children }) {
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" className="markdown-link">
                {children}
              </a>
            );
          },
          table({ children }) {
            return (
              <div className="markdown-table-wrap">
                <table className="markdown-table">{children}</table>
              </div>
            );
          },
        }}
      >
        {safeContent}
      </ReactMarkdown>
    </div>
  );
});

function Bubble({ message }: { message: ChatMessageDTO }) {
  const isUser = message.role === 'user';
  const isWriteback = message.message_kind === 'writeback';

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={`flex ${isUser ? 'justify-end pl-12' : 'justify-start pr-12'}`}
    >
      {isUser ? (
        <div className="max-w-[78%] rounded-[24px] bg-[linear-gradient(180deg,#5f72ea,#4f63da)] px-[22px] py-[14px] text-[15px] leading-7 text-white shadow-[0_10px_26px_rgba(79,99,218,0.18)]">
          {isWriteback ? (
            <span className="mb-1 block text-[10px] uppercase tracking-wider text-[var(--text-dim)]">writeback</span>
          ) : null}
          <div className="whitespace-pre-wrap break-words">{message.content_text}</div>
        </div>
      ) : (
        <div className="min-w-0 pl-2">
          {isWriteback ? (
            <span className="mb-1 block text-[10px] uppercase tracking-wider text-[var(--text-dim)]">writeback</span>
          ) : null}
          <MarkdownContent content={message.content_text} />
        </div>
      )}
    </motion.div>
  );
}
