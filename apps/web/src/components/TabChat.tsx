import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import type { ChangeEvent, ClipboardEvent } from 'react';
import type { ChatImageContentBlockDTO, ChatMessageContentBlockDTO, ChatMessageDTO } from '@piplus/shared';
import type { SessionMessageImageAttachment } from '../lib/api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeHighlight from 'rehype-highlight';
import {
  Copy,
  Check,
  ArrowUp,
  ScrollText,
  LoaderCircle,
  OctagonX,
  Wrench,
  ChevronDown,
  ChevronRight,
  Terminal,
  Archive,
  GitMerge,
  ImagePlus,
  X,
} from 'lucide-react';
import ContextUsageRing from './ContextUsageRing';
import Modal from './Modal';
import Select from './Select';
import { useSessionContextUsage, useSessionCommands } from '../lib/hooks';
import { fuzzyScore } from '../lib/fuzzy';
import { loadSessionDraft, saveSessionDraft } from '../lib/session-drafts';

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
  onSend: (content: string, attachments: SessionMessageImageAttachment[]) => Promise<void>;
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
  currentModelSupportsImages?: boolean | null;
  onModelSelect?: (provider: string, id: string) => void;
  onArchiveSession?: () => void;
  archivePending?: boolean;
  showArchiveButton?: boolean;
  onCompactSession?: () => void;
  compactPending?: boolean;
  onSendPlannerRolePrompt?: () => void;
  plannerRolePromptPending?: boolean;
  showPlannerRolePromptButton?: boolean;
  runtimeErrors?: Array<{runId: string; error: string}>;
  isMobile?: boolean;
}

function extractCodeText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(extractCodeText).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    return extractCodeText((node as any).props.children);
  }
  return '';
}

function isToolCallPending(msgId: string, toolName: string, allMsgs: ChatMessageDTO[]): boolean {
  const msgIndex = allMsgs.findIndex((m) => m.id === msgId);
  if (msgIndex === -1) return false;
  for (let i = msgIndex + 1; i < allMsgs.length; i++) {
    const m = allMsgs[i];
    if ((m.message_kind === 'tool' || m.role === 'tool') && m.tool_name && m.tool_name === toolName) {
      return false;
    }
  }
  return true;
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
  currentModelSupportsImages,
  onModelSelect,
  onArchiveSession,
  archivePending,
  showArchiveButton,
  onCompactSession,
  compactPending,
  onSendPlannerRolePrompt,
  plannerRolePromptPending,
  showPlannerRolePromptButton,
  runtimeErrors,
  isMobile,
}: TabChatProps) {
  const [draft, setDraft] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedToolIds, setExpandedToolIds] = useState<Set<string>>(new Set());
  const [attachments, setAttachments] = useState<SessionMessageImageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<ChatImageContentBlockDTO | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Slash command completion state
  const [showCommands, setShowCommands] = useState(false);
  const [commandFilter, setCommandFilter] = useState('');
  const [selectedCommandIdx, setSelectedCommandIdx] = useState(0);
  const commandsQuery = useSessionCommands(selectedSessionId ?? null);
  const availableCommands = commandsQuery.data ?? [];

  // Filtered and scored command list
  const filteredCommands = (() => {
    if (!commandFilter) return availableCommands;
    const q = commandFilter.toLowerCase();
    return availableCommands
      .map((cmd) => ({ cmd, score: fuzzyScore(q, cmd.name) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((item) => item.cmd);
  })();

  const closeCommands = () => {
    setShowCommands(false);
    setCommandFilter('');
    setSelectedCommandIdx(0);
  };
  const commandJustSelectedRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const prevDisplayMessagesRef = useRef<ChatMessageDTO[]>([]);
  const prevScrollHeightRef = useRef<number | null>(null);
  const lastChangeTypeRef = useRef<'none' | 'prepend' | 'append'>('none');
  const sessionJustSwitchedRef = useRef(false);
  const prevSessionIdRef = useRef<string | null>(null);
  const draftRef = useRef(draft);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const isNearBottomRef = useRef(true);

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  };

  const handleScrollToBottom = () => {
    scrollToBottom('smooth');
    setIsNearBottom(true);
    isNearBottomRef.current = true;
  };

  const canSendImages = currentModelSupportsImages !== false;
  const allowedImageMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

  const imageBlockToDataUrl = (block: ChatImageContentBlockDTO) => {
    if (!block.data_base64 || !block.mime_type) return block.uri;
    return `data:${block.mime_type};base64,${block.data_base64}`;
  };

  const fileToAttachment = (file: File): Promise<SessionMessageImageAttachment> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`读取图片失败：${file.name}`));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      if (!base64) {
        reject(new Error(`读取图片失败：${file.name}`));
        return;
      }
      resolve({
        type: 'image',
        mime_type: file.type,
        data_base64: base64,
        filename: file.name,
      });
    };
    reader.readAsDataURL(file);
  });

  const addImageFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (!files.length) return;
    if (!canSendImages) {
      setAttachmentError('当前模型不支持图片输入，请先切换到支持图片的模型。');
      return;
    }
    const imageFiles = files.filter((file) => allowedImageMimeTypes.has(file.type));
    if (imageFiles.length !== files.length) {
      setAttachmentError('仅支持 PNG、JPEG、WebP、GIF 图片。');
      return;
    }
    if (attachments.length + imageFiles.length > 4) {
      setAttachmentError('最多只能添加 4 张图片。');
      return;
    }
    try {
      const nextAttachments = await Promise.all(imageFiles.map(fileToAttachment));
      setAttachments((prev) => [...prev, ...nextAttachments]);
      setAttachmentError(null);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : '读取图片失败');
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, attachmentIndex) => attachmentIndex !== index));
    setAttachmentError(null);
  };

  const imageBlocks = (msg: ChatMessageDTO): ChatImageContentBlockDTO[] =>
    (msg.content_blocks ?? []).filter((block): block is ChatImageContentBlockDTO => block.type === 'image');

  const textBlocks = (msg: ChatMessageDTO): ChatMessageContentBlockDTO[] =>
    (msg.content_blocks ?? []).filter((block) => block.type === 'text');

  const allMessages = [...messages];
  // Append pending user messages that haven't been confirmed.
  // Reconcile by comparing both text and image block identity to avoid
  // dropping image-only or same-text messages sent close together.
  const imageSignature = (blocks?: ChatMessageContentBlockDTO[]) => JSON.stringify(
    (blocks ?? [])
      .filter((block): block is ChatImageContentBlockDTO => block.type === 'image')
      .map((block) => ({
        filename: block.filename,
        mime_type: block.mime_type,
        data_base64: block.data_base64,
      })),
  );
  for (const pm of pendingUserMessages) {
    const pendingImageSignature = imageSignature(pm.content_blocks);
    const hasConfirmedMatch = allMessages.some((m) =>
      m.role === 'user'
      && m.content_text === pm.content_text
      && imageSignature(m.content_blocks) === pendingImageSignature
      && Math.abs(new Date(m.created_at).getTime() - new Date(pm.created_at).getTime()) < 60_000,
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

  // Track runtime run start index to avoid showing spinners on interrupted tool calls
  const prevRuntimeStatusRef = useRef(runtimeStatus);
  const currentRunStartIdxRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const prev = prevRuntimeStatusRef.current;
    prevRuntimeStatusRef.current = runtimeStatus;

    if (runtimeStatus === 'running' && (prev !== 'running' || currentRunStartIdxRef.current === null)) {
      // New run started — only tool_calls from this point forward can show spinners
      currentRunStartIdxRef.current = messages.length;
    }
  }, [runtimeStatus, messages.length]);

  // 独立标记：session 切换时设 flag，等真实消息渲染后再跳到底部
  useEffect(() => {
    sessionJustSwitchedRef.current = true;
  }, [selectedSessionId]);

  // useLayoutEffect：在浏览器重绘前同步吸附底部，避免抽搐
  useLayoutEffect(() => {
    if (!streamingContent || !isNearBottomRef.current) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    const nearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < container.clientHeight / 3;
    if (nearBottom) {
      container.scrollTop = container.scrollHeight - container.clientHeight;
      setIsNearBottom(true);
      isNearBottomRef.current = true;
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
        setIsNearBottom(true);
        isNearBottomRef.current = true;
        requestAnimationFrame(() => requestAnimationFrame(() => scrollToBottom('auto')));
        return;
      }
    }

    if (streamingContent || lastChangeTypeRef.current === 'prepend' || !isNearBottom) {
      return;
    }

    const userAtBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < container.clientHeight / 3;

    if (userAtBottom) {
      scrollToBottom('smooth');
      setIsNearBottom(true);
    }
  }, [displayMessages, streamingContent, selectedSessionId]);

  const handleSubmit = async () => {
    const content = draft.trim();
    if ((!content && attachments.length === 0) || sending) return;
    const nextAttachments = attachments;
    try {
      await onSend(content, nextAttachments);
      setDraft('');
      setAttachments([]);
      setAttachmentError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/does not support image input/i.test(message)) {
        setAttachmentError('当前模型不支持图片输入，请切换到支持图片的模型。');
        return;
      }
      if (/unsupported image mime type/i.test(message)) {
        setAttachmentError('仅支持 PNG、JPEG、WebP、GIF 图片。');
        return;
      }
      if (/at most 4 images are allowed/i.test(message)) {
        setAttachmentError('最多只能添加 4 张图片。');
        return;
      }
      setAttachmentError(message || '发送失败，请重试。');
    }
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

  // Keep draftRef in sync for cleanup (unmount) and session-switch effects
  useEffect(() => {
    draftRef.current = draft;
  });

  // On session switch: save old draft, load new one, clear attachments
  useEffect(() => {
    // Save current draft to old session before switching
    if (prevSessionIdRef.current && prevSessionIdRef.current !== selectedSessionId) {
      saveSessionDraft(prevSessionIdRef.current, draftRef.current);
    }

    // Load saved draft for the new session
    if (selectedSessionId) {
      const savedDraft = loadSessionDraft(selectedSessionId);
      setDraft(savedDraft);
      // Sync ref immediately (before re-render) so the cleanup effect
      // on StrictMode unmount doesn't overwrite with the stale '' value.
      draftRef.current = savedDraft;
    }

    prevSessionIdRef.current = selectedSessionId;

    // Clear attachments and errors on session switch (existing behavior)
    setAttachments([]);
    setAttachmentError(null);
    setPreviewImage(null);
  }, [selectedSessionId]);

  // Debounce-save draft to localStorage when it changes
  useEffect(() => {
    if (!selectedSessionId) return;
    const timer = setTimeout(() => {
      saveSessionDraft(selectedSessionId, draft);
    }, 200);
    return () => clearTimeout(timer);
  }, [draft, selectedSessionId]);

  // Save draft on unmount (e.g. tab switch) — captures latest via refs
  useEffect(() => {
    return () => {
      const sid = prevSessionIdRef.current;
      if (sid) {
        saveSessionDraft(sid, draftRef.current);
      }
    };
  }, []);

  // 滚动监听：同步更新按钮状态和跟随标记（两者共用同一 clientHeight/3 阈值）
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const checkNearBottom = () => {
      const near = container.scrollHeight - container.scrollTop - container.clientHeight < container.clientHeight / 3;
      setIsNearBottom(near);
      isNearBottomRef.current = near;
    };

    checkNearBottom();
    container.addEventListener('scroll', checkNearBottom, { passive: true });
    return () => container.removeEventListener('scroll', checkNearBottom);
  }, []);

  const contextUsageQuery = useSessionContextUsage(selectedSessionId ?? null);
  const contextPercent = contextUsageQuery.data?.percent ?? null;
  const showCompactButton = contextPercent !== null && contextPercent > 60;

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

            const msgIndex = messages.findIndex((m) => m.id === msg.id);
            const isInCurrentRun = currentRunStartIdxRef.current !== null && msgIndex >= currentRunStartIdxRef.current;
            const isThisToolRunning = isRunning && isInCurrentRun && isToolCallPending(msg.id, toolName, messages);

            let argsStr = '';
            let parsedArgs: Record<string, unknown> | null = null;
            if (msg.tool_args_json) {
              try {
                const parsed: unknown = JSON.parse(msg.tool_args_json);
                argsStr = JSON.stringify(parsed, null, 2);
                if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                  parsedArgs = parsed as Record<string, unknown>;
                }
              } catch {
                argsStr = msg.tool_args_json;
              }
            }
            const spawnSessionRole = toolName === 'spawn_session' && typeof parsedArgs?.role === 'string'
              ? parsedArgs.role
              : null;

            return (
              <div key={msg.id} className="flex justify-start items-start w-full">
                {isThisToolRunning && (
                  <div className="mr-2 pt-2 shrink-0">
                    <LoaderCircle className="w-4 h-4 text-indigo-500 animate-spin" />
                  </div>
                )}
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
                        {spawnSessionRole ? ` (${spawnSessionRole})` : ''}
                      </span>
                    </div>
                    {isExpanded && argsStr && (
                      <div className="border-t border-amber-200 dark:border-amber-800 px-3 py-2">
                        {(toolName === 'spawn_session' || toolName === 'send_message_to_session') && parsedArgs ? (
                          <table className="w-full text-[11px] font-mono leading-relaxed">
                            <tbody>
                              {Object.entries(parsedArgs).map(([key, value]) => (
                                <tr key={key} className="border-b border-amber-100 dark:border-amber-800/50 last:border-b-0">
                                  <td className="text-amber-700 dark:text-amber-400 font-semibold pr-3 py-1 align-top whitespace-nowrap">
                                    {key}
                                  </td>
                                  <td className="text-amber-900 dark:text-amber-200 py-1 break-words">
                                    {typeof value === 'object' && value !== null
                                      ? JSON.stringify(value)
                                      : String(value)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        ) : (
                          <pre className="text-[11px] text-amber-900 dark:text-amber-200 font-mono whitespace-pre-wrap overflow-x-auto leading-relaxed">
                            {argsStr}
                          </pre>
                        )}
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
                  <div className="space-y-2 max-w-full">
                    {imageBlocks(msg).length > 0 && (
                      <div className="flex flex-wrap justify-end gap-2">
                        {imageBlocks(msg).map((block, index) => {
                          const src = imageBlockToDataUrl(block);
                          if (!src) return null;
                          return (
                            <button
                              key={`${msg.id}-image-${index}`}
                              type="button"
                              onClick={() => setPreviewImage(block)}
                              className="overflow-hidden rounded-2xl border border-blue-400/30 bg-blue-500/10 hover:opacity-90 transition cursor-pointer"
                              title={block.filename ?? '预览图片'}
                            >
                              <img src={src} alt={block.filename ?? `attachment-${index + 1}`} className="h-20 w-20 object-cover" />
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {(msg.content_text || textBlocks(msg).length > 0) && (
                      <div className="bg-blue-600 text-white rounded-2xl px-4 py-2.5 text-sm shadow-xs font-sans leading-relaxed break-words overflow-hidden">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm, remarkBreaks]}
                          rehypePlugins={[[rehypeHighlight, { detect: false }]]}
                          components={{
                            pre({ children }) {
                              return <pre className="overflow-x-auto">{children}</pre>;
                            },
                            code({ className, children, ...codeProps }: any) {
                              const match = /language-(\w+)/.exec(className || '');
                              const isInline = !className;
                              if (!isInline) {
                                const language = match ? match[1] : 'code';
                                return (
                                  <div className="my-2 border border-blue-400/40 rounded-xl overflow-hidden bg-blue-700/60 text-white max-w-full">
                                    <div className="bg-blue-800/60 px-3 py-1 flex items-center border-b border-blue-400/30">
                                      <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-blue-200">{language}</span>
                                    </div>
                                    <pre className="p-3 overflow-x-auto text-[11.5px] leading-relaxed text-white/90">
                                      <code className={className}>{children}</code>
                                    </pre>
                                  </div>
                                );
                              }
                              return (
                                <code className="bg-blue-500/60 border border-blue-400/40 text-white px-1.5 py-0.5 rounded font-mono text-[11px]" {...codeProps}>
                                  {children}
                                </code>
                              );
                            },
                            p({ children, ...pProps }) {
                              return <p className="my-1.5 leading-relaxed" {...pProps}>{children}</p>;
                            },
                            ul({ children, ...ulProps }) {
                              return <ul className="list-disc pl-5 my-1.5 space-y-0.5" {...ulProps}>{children}</ul>;
                            },
                            ol({ children, ...olProps }) {
                              return <ol className="list-decimal pl-5 my-1.5 space-y-0.5" {...olProps}>{children}</ol>;
                            },
                            blockquote({ children, ...bqProps }) {
                              return <blockquote className="border-l-3 border-blue-400/60 pl-3 py-1 my-2 opacity-90" {...bqProps}>{children}</blockquote>;
                            },
                            a({ children, href, ...aProps }: any) {
                              return <a href={href} className="underline underline-offset-2 hover:opacity-80" target="_blank" rel="noopener noreferrer" {...aProps}>{children}</a>;
                            },
                            table({ children, ...tableProps }) {
                              return (
                                <div className="overflow-x-auto my-2 rounded-lg border border-blue-400/40">
                                  <table className="min-w-full text-xs border-collapse" {...tableProps}>{children}</table>
                                </div>
                              );
                            },
                            thead({ children, ...theadProps }) {
                              return <thead className="bg-blue-700/60" {...theadProps}>{children}</thead>;
                            },
                            tbody({ children, ...tbodyProps }) {
                              return <tbody className="divide-y divide-blue-400/20" {...tbodyProps}>{children}</tbody>;
                            },
                            tr({ children, ...trProps }) {
                              return <tr className="even:bg-blue-500/20" {...trProps}>{children}</tr>;
                            },
                            th({ children, ...thProps }) {
                              return <th className="px-2.5 py-1.5 text-left font-semibold text-white/90 border-b border-blue-400/40 text-[11px]" {...thProps}>{children}</th>;
                            },
                            td({ children, ...tdProps }) {
                              return <td className="px-2.5 py-1.5 text-white/80 border-b border-blue-400/20 text-[11px]" {...tdProps}>{children}</td>;
                            },
                            h1({ children, ...hProps }) {
                              return <h1 className="text-base font-bold my-2" {...hProps}>{children}</h1>;
                            },
                            h2({ children, ...hProps }) {
                              return <h2 className="text-sm font-bold my-1.5" {...hProps}>{children}</h2>;
                            },
                            h3({ children, ...hProps }) {
                              return <h3 className="text-sm font-semibold my-1.5" {...hProps}>{children}</h3>;
                            },
                            hr() {
                              return <hr className="border-blue-400/40 my-2" />;
                            },
                            img({ src, alt, ...imgProps }: any) {
                              return <img src={src} alt={alt} className="max-w-full rounded-lg my-1.5" {...imgProps} />;
                            },
                          }}
                        >
                          {msg.content_text}
                        </ReactMarkdown>
                      </div>
                    )}
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

        {/* Runtime error (agent loop) */}
        {!isRunning && !streamingContent && runtimeErrors && runtimeErrors.length > 0 && (() => {
          const err = runtimeErrors[runtimeErrors.length - 1];
          const errId = `runtime-error-${err.runId}`;
          const isExpanded = expandedToolIds.has(errId);
          const isLong = err.error.length > 200;
          const toggleExpand = () => {
            setExpandedToolIds((prev) => {
              const next = new Set(prev);
              if (next.has(errId)) next.delete(errId);
              else next.add(errId);
              return next;
            });
          };
          return (
            <div key={errId} className="flex justify-start items-start w-full">
              <div className="flex flex-col items-start max-w-full flex-1 min-w-0">
                <div className="bg-red-50 dark:bg-red-950/30 border border-red-300 dark:border-red-800 rounded-xl overflow-hidden w-full">
                  <div
                    className="px-3 py-2 flex items-center gap-2 cursor-pointer select-none"
                    onClick={isLong ? toggleExpand : undefined}
                  >
                    <OctagonX className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0" />
                    <span className="text-xs font-semibold text-red-800 dark:text-red-300">
                      Agent Loop Error / Agent 循环错误
                    </span>
                    {isLong && (
                      isExpanded
                        ? <ChevronDown className="w-3.5 h-3.5 text-red-400 shrink-0 ml-auto" />
                        : <ChevronRight className="w-3.5 h-3.5 text-red-400 shrink-0 ml-auto" />
                    )}
                  </div>
                  <div className={`border-t border-red-200 dark:border-red-800 px-3 py-2 ${!isExpanded && isLong ? 'max-h-20 overflow-hidden' : ''}`}>
                    <pre className="text-[11px] text-red-900 dark:text-red-200 font-mono whitespace-pre-wrap overflow-x-auto leading-relaxed">
                      {err.error}
                    </pre>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

        <div ref={messagesEndRef} />
        
        {/* Scroll to bottom button */}
        {!isNearBottom && (
          <div className="sticky bottom-6 z-10 flex justify-end pointer-events-none">
            <button
              onClick={handleScrollToBottom}
              className="pointer-events-auto w-11 h-11 rounded-full bg-white dark:bg-slate-700 shadow-lg border border-slate-200 dark:border-slate-600 flex items-center justify-center hover:bg-slate-100 dark:hover:bg-slate-600 transition cursor-pointer"
              aria-label="滚动到底部"
            >
              <ChevronDown className="w-5 h-5 text-slate-600 dark:text-slate-300" />
            </button>
          </div>
        )}
      </div>

      {/* Suggestions */}
      {false && allMessages.length > 0 && !isRunning && (
        <div className="px-6 py-2 flex flex-wrap gap-2 select-none shrink-0 bg-white/40 dark:bg-slate-900/60 border-t border-slate-100 dark:border-slate-800/60">
          <button
            onClick={() => onSend('生成当前会话的 Git Diff', [])}
            className="text-[11px] bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 border border-slate-200/80 dark:border-slate-700 rounded-full px-3 py-1 text-slate-600 dark:text-slate-300 shadow-3xs cursor-pointer transition-colors"
          >
            📊 生成 Git Diff
          </button>
          <button
            onClick={() => onSend('分析当前会话状态并总结', [])}
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
            <div className="relative" style={{ minWidth: 120 }}>
              <Select
                value={currentModelValue ?? ''}
                onChange={(v) => {
                  const [provider, id] = v.split('/');
                  if (provider && id) onModelSelect(provider, id);
                }}
                options={models.map((m) => ({
                  value: `${m.provider}/${m.id}`,
                  label: `${m.provider} / ${m.label}`,
                }))}
                searchable
                dropdownMaxHeight="max-h-72"
                dropdownMinWidth="260px"
                className="w-full"
              />
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
          {showPlannerRolePromptButton && onSendPlannerRolePrompt && (
            <button
              onClick={onSendPlannerRolePrompt}
              className="flex items-center space-x-1 px-2.5 py-1 border border-amber-300 dark:border-amber-700 hover:bg-amber-50 dark:hover:bg-amber-900/30 rounded-xl text-[11px] font-semibold text-amber-700 dark:text-amber-400 transition cursor-pointer disabled:opacity-50"
              disabled={plannerRolePromptPending || sending}
            >
              <Wrench className="w-3 h-3" />
              <span>{plannerRolePromptPending ? '...' : '重新发送提示词'}</span>
            </button>
          )}
          <ContextUsageRing sessionId={selectedSessionId ?? null} />
          {showCompactButton && onCompactSession && (
            <button
              onClick={onCompactSession}
              className="flex items-center space-x-1 px-2.5 py-1 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl text-[11px] font-semibold text-slate-500 dark:text-slate-400 transition cursor-pointer disabled:opacity-50"
              disabled={compactPending}
            >
              <GitMerge className="w-3 h-3" />
              <span>{compactPending ? '...' : '压缩'}</span>
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
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/60 p-2">
                {attachments.map((attachment, index) => (
                  <div key={`${attachment.filename ?? 'attachment'}-${index}`} className="relative">
                    <button
                      type="button"
                      onClick={() => setPreviewImage({
                        type: 'image',
                        mime_type: attachment.mime_type,
                        media_type: attachment.mime_type,
                        filename: attachment.filename ?? null,
                        uri: null,
                        data_base64: attachment.data_base64,
                      })}
                      className="block overflow-hidden rounded-lg border border-slate-300 dark:border-slate-600"
                    >
                      <img
                        src={`data:${attachment.mime_type};base64,${attachment.data_base64}`}
                        alt={attachment.filename ?? `attachment-${index + 1}`}
                        className="h-16 w-16 object-cover"
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeAttachment(index)}
                      className="absolute -right-1.5 -top-1.5 rounded-full bg-slate-900/80 p-1 text-white hover:bg-slate-900 cursor-pointer"
                      title="移除图片"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {/* Slash command dropdown */}
            {showCommands && (
              <div className="relative">
                <div className="absolute bottom-full left-0 right-0 mb-1 z-50 max-h-48 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-lg">
                  {commandsQuery.isLoading ? (
                    <div className="px-3 py-2 text-sm text-slate-400 dark:text-slate-500">加载命令…</div>
                  ) : commandsQuery.isError ? (
                    <div className="px-3 py-2 text-sm text-red-500">命令加载失败</div>
                  ) : filteredCommands.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-slate-400 dark:text-slate-500">无匹配命令</div>
                  ) : (
                    filteredCommands.map((cmd, idx) => (
                    <button
                      key={cmd.name}
                      type="button"
                      className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 transition-colors ${
                        idx === selectedCommandIdx
                          ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                          : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
                      }`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        commandJustSelectedRef.current = true;
                        setDraft(`/${cmd.name} `);
                        closeCommands();
                        requestAnimationFrame(() => {
                          const ta = textareaRef.current;
                          if (ta) {
                            ta.focus();
                            ta.selectionStart = ta.selectionEnd = ta.value.length;
                          }
                        });
                      }}
                    >
                      <span className="font-mono font-semibold text-blue-600 dark:text-blue-400 shrink-0">/{cmd.name}</span>
                      {cmd.description && (
                        <span className="truncate text-xs text-slate-400 dark:text-slate-500">{cmd.description}</span>
                      )}
                      <span className={`ml-auto shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium ${
                        cmd.source === 'extension' ? 'bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-400' :
                        cmd.source === 'prompt' ? 'bg-green-100 dark:bg-green-900/40 text-green-600 dark:text-green-400' :
                        'bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400'
                      }`}>
                        {cmd.source}
                      </span>
                    </button>
                  ))
                  )}
                </div>
              </div>
            )}
            <textarea
              className="w-full min-h-[68px] resize-none px-3 py-2 text-sm border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-100 placeholder:text-slate-400 transition"
              disabled={isRunning || sending}
              ref={textareaRef}
              onChange={(e) => {
                const value = e.target.value;
                setDraft(value);
                // Skip slash detection if command was just selected
                if (commandJustSelectedRef.current) {
                  commandJustSelectedRef.current = false;
                  return;
                }
                // Detect slash command: cursor at start or value starts with /
                const textarea = e.target;
                const cursorPos = textarea.selectionStart;
                const textBeforeCursor = value.slice(0, cursorPos);
                // Only show commands when / is the first character and no newlines in current line
                if (textBeforeCursor.startsWith('/') && !/\n/.test(textBeforeCursor)) {
                  const filter = textBeforeCursor.slice(1);
                  setCommandFilter(filter);
                  setShowCommands(true);
                  setSelectedCommandIdx(0);
                } else {
                  closeCommands();
                }
              }}
              onPaste={async (e: ClipboardEvent<HTMLTextAreaElement>) => {
                const files = Array.from(e.clipboardData.files ?? []);
                if (!files.some((file) => allowedImageMimeTypes.has(file.type))) return;
                e.preventDefault();
                await addImageFiles(files.filter((file) => allowedImageMimeTypes.has(file.type)));
              }}
              onKeyDown={(e) => {
                // Command dropdown keyboard navigation
                if (showCommands && filteredCommands.length > 0) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setSelectedCommandIdx((prev) => Math.min(prev + 1, filteredCommands.length - 1));
                    return;
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setSelectedCommandIdx((prev) => Math.max(prev - 1, 0));
                    return;
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    closeCommands();
                    return;
                  }
                  if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                    e.preventDefault();
                    const cmd = filteredCommands[selectedCommandIdx];
                    if (cmd) {
                      commandJustSelectedRef.current = true;
                      setDraft(`/${cmd.name} `);
                      closeCommands();
                      // Focus back and move cursor to end
                      requestAnimationFrame(() => {
                        const ta = textareaRef.current;
                        if (ta) {
                          ta.focus();
                          ta.selectionStart = ta.selectionEnd = ta.value.length;
                        }
                      });
                    }
                    return;
                  }
                }

                if (e.key !== 'Enter') return;

                if (sendShortcutMode === 'mod_enter') {
                  // Ctrl/Cmd+Enter 发送，Enter 换行
                  if (e.metaKey || e.ctrlKey) {
                    e.preventDefault();
                    void handleSubmit();
                    return;
                  }
                  // 回车（无修饰键）→ 换行
                } else {
                  // Enter 发送，Ctrl/Cmd+Enter 换行（默认）
                  if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                    e.preventDefault();
                    void handleSubmit();
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
            <div className="flex items-center gap-2.5 px-1 flex-wrap">
              {/* WS connection indicator */}
              <div className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-emerald-500' : 'bg-red-400'}`} />
                <span className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">
                  {wsConnected ? 'WS' : 'WS 离线'}
                </span>
              </div>
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  multiple
                  className="hidden"
                  onChange={async (e: ChangeEvent<HTMLInputElement>) => {
                    const files = e.target.files;
                    if (files) await addImageFiles(files);
                    e.target.value = '';
                  }}
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isRunning || !canSendImages || attachments.length >= 4}
                    className="flex items-center space-x-1.5 px-3 py-1.5 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl text-xs font-semibold text-slate-500 dark:text-slate-400 transition cursor-pointer disabled:opacity-50"
                    title={isRunning ? '对话进行中，暂时不能添加图片' : canSendImages ? '添加图片' : '当前模型不支持图片输入'}
                  >
                    <ImagePlus className="w-3.5 h-3.5" />
                    <span>图片</span>
                  </button>
                  {(attachmentError || currentModelSupportsImages === false) && (
                    <span className="text-[10px] text-red-500 dark:text-red-400 font-medium whitespace-nowrap">
                      {attachmentError ?? '当前模型不支持图片输入'}
                    </span>
                  )}
                </div>
              </>
              {!isRunning && (
                <span className="text-[10px] text-slate-400 dark:text-slate-500 ml-auto">
                  {isMobile
                    ? '支持粘贴图片，最多 4 张'
                    : sendShortcutMode === 'mod_enter'
                      ? 'Ctrl/Cmd+Enter 发送 · 支持粘贴图片，最多 4 张'
                      : 'Enter 发送 · Ctrl/Cmd+Enter 换行 · 支持粘贴图片，最多 4 张'}
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
                disabled={isRunning || sending || (draft.trim().length === 0 && attachments.length === 0)}
                onClick={() => { void handleSubmit(); }}
              >
                <span>{sending ? '发送中…' : '发送'}</span>
                <ArrowUp className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <Modal
        isOpen={Boolean(previewImage)}
        onClose={() => setPreviewImage(null)}
        title={previewImage?.filename ?? '图片预览'}
        maxWidthClassName="max-w-4xl"
      >
        {previewImage && imageBlockToDataUrl(previewImage) && (
          <div className="flex items-center justify-center">
            <img
              src={imageBlockToDataUrl(previewImage)!}
              alt={previewImage.filename ?? 'preview'}
              className="max-h-[70vh] w-auto rounded-xl border border-slate-200 dark:border-slate-700"
            />
          </div>
        )}
      </Modal>
    </div>
  );
}
