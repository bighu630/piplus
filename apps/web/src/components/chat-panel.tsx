'use client';

import { ArrowUp, LoaderCircle, OctagonX, ScrollText } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ChatMessageDTO } from '@piplus/shared';
import { ScrollArea } from './ui/scroll-area';
import { motion } from 'framer-motion';

type Props = {
  canLoadMore?: boolean;
  disabled?: boolean;
  loadingMore?: boolean;
  messages?: ChatMessageDTO[];
  onArchive?: () => void | Promise<void>;
  onLoadMore?: () => void | Promise<void>;
  onSend?: (content: string) => void | Promise<void>;
  onStop?: () => void | Promise<void>;
  sending?: boolean;
  stopDisabled?: boolean;
  stopArmed?: boolean;
  streamNote?: string;
  sessionTitle?: string;
  archiving?: boolean;
};

export function ChatPanel({
  canLoadMore = false,
  disabled = false,
  loadingMore = false,
  messages = [],
  onArchive,
  onLoadMore,
  onSend,
  onStop,
  sending = false,
  stopDisabled = true,
  stopArmed = false,
  streamNote,
  sessionTitle,
  archiving = false,
}: Props) {
  const [draft, setDraft] = useState('');

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

  return (
    <div className="flex h-full min-h-[68vh] flex-col">
      <div className="border-b border-white/8 px-5 py-4 md:px-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="workspace-eyebrow">Conversation</p>
            <h3 className="mt-2 text-xl font-semibold tracking-[-0.03em] text-[var(--text)]">{sessionTitle ? `Chat · ${sessionTitle}` : 'Chat'}</h3>
          </div>
          {streamNote ? (
            <span className="chip chip-stream">
              <LoaderCircle size={12} strokeWidth={2} className="animate-spin" />
              {streamNote}
            </span>
          ) : null}
        </div>
      </div>

      <ScrollArea className="flex-1" viewportClassName="px-5 py-5 md:px-6">
        <div className="mx-auto flex min-h-full w-full max-w-[960px] flex-col justify-end gap-4">
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

      <div className="border-t border-white/8 bg-[rgba(255,255,255,0.02)] px-5 py-4 md:px-6">
        <div className={`mx-auto max-w-[960px] rounded-[22px] border p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition-colors duration-200 ${
          stopArmed ? 'border-[#f87171]/40 bg-[rgba(248,113,113,0.06)]' : 'border-white/8 bg-[var(--surface-soft)]'
        }`}>
          <div className="flex items-center justify-between gap-3">
            <label className="workspace-eyebrow">Message</label>
            <span className="text-xs text-[var(--text-dim)]">Ctrl / Cmd + Enter</span>
          </div>
          <div className="mt-3 flex flex-col gap-3">
            <textarea
              className={`chat-input min-h-[108px] w-full resize-none ${stopArmed ? 'placeholder:text-[#f87171]/60' : ''}`}
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
            <div className="flex items-center justify-end gap-3">
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
              <button className="ghost-button ghost-button-sm ghost-button-icon" disabled={disabled || archiving} onClick={() => void onArchive?.()} type="button">
                <ScrollText size={14} strokeWidth={2.2} />
                <span>{archiving ? '归档中…' : '归档'}</span>
              </button>
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

function Bubble({ message }: { message: ChatMessageDTO }) {
  const isUser = message.role === 'user';
  const isWriteback = message.message_kind === 'writeback';

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
    >
      <article className={`message-bubble ${isUser ? 'message-user' : 'message-assistant'}`}>
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-[var(--text-dim)]">
          <span>{isUser ? 'user' : 'assistant'}</span>
          {isWriteback ? <span className="chip chip-inline">writeback</span> : null}
          {!isUser && message.source_session_id ? <span className="chip chip-inline">from {message.source_session_id}</span> : null}
        </div>
        <div className="whitespace-pre-wrap break-words text-[14px] leading-7 text-[var(--text)]">{message.content_text}</div>
      </article>
    </motion.div>
  );
}
