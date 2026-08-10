import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import type { ChatImageContentBlockDTO, ChatMessageContentBlockDTO, ChatMessageDTO } from '@piplus/shared';
import type { SessionMessageImageAttachment } from '../lib/api';
import {
  Copy,
  Check,
  ScrollText,
  LoaderCircle,
  OctagonX,
  Wrench,
  ChevronDown,
  ChevronRight,
  Terminal,
  Archive,
  GitMerge,
} from 'lucide-react';
import DiffViewer from './DiffViewer';
import MarkdownRenderer from './MarkdownRenderer';
import ContextUsageRing from './ContextUsageRing';
import Lightbox from 'yet-another-react-lightbox';
import 'yet-another-react-lightbox/styles.css';
import Zoom from 'yet-another-react-lightbox/plugins/zoom';
import Download from 'yet-another-react-lightbox/plugins/download';
import Select from './Select';
import { useSessionContextUsage } from '../lib/hooks';
import { THINKING_LEVEL_LABELS, THINKING_LEVEL_DISPLAY_LABELS } from '../lib/thinking-levels';
import ChatInput from './ChatInput';
import { useChatStream, useWebSocket } from '../lib/ws-provider';

// 距容器底部多少像素内视为"在底部"（跟随吸底与按钮显示共用）
const FOLLOW_THRESHOLD = 100;

interface ModelOption {
  provider: string;
  id: string;
  label: string;
}

interface TabChatProps {
  messages: ChatMessageDTO[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onSend: (content: string, attachments: SessionMessageImageAttachment[]) => Promise<void>;
  onStop: () => void;
  sending: boolean;
  runtimeStatus: string;
  selectedSessionId?: string | null;
  sendShortcutMode?: 'enter' | 'mod_enter';
  models?: ModelOption[];
  currentModelValue?: string;
  currentModelSupportsImages?: boolean | null;
  visionRelayEnabled?: boolean;
  onModelSelect?: (provider: string, id: string) => void;
  onArchiveSession?: () => void;
  archivePending?: boolean;
  showArchiveButton?: boolean;
  onCompactSession?: () => void;
  compactPending?: boolean;
  onSendPlannerRolePrompt?: () => void;
  plannerRolePromptPending?: boolean;
  showPlannerRolePromptButton?: boolean;
  thinkingLevelValue?: string | null;
  thinkingLevelOptions?: string[];
  onThinkingLevelSelect?: (level: string) => void;
  isMobile?: boolean;
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

/** Extract file path and edit content from write/edit tool call args */
function parseWriteEditArgs(
  toolName: string,
  parsedArgs: Record<string, unknown>,
): { path?: string; oldText?: string; newText: string } | null {
  if (toolName === 'write') {
    const path = typeof parsedArgs.path === 'string' ? parsedArgs.path : undefined;
    const content = typeof parsedArgs.content === 'string' ? parsedArgs.content : '';
    return { path, newText: content };
  }

  if (toolName === 'edit') {
    const path = typeof parsedArgs.path === 'string' ? parsedArgs.path : undefined;
    const edits = parsedArgs.edits;
    if (Array.isArray(edits) && edits.length > 0) {
      // Combine all edits into one diff view
      const oldParts: string[] = [];
      const newParts: string[] = [];
      for (const edit of edits) {
        if (edit && typeof edit === 'object') {
          const e = edit as Record<string, unknown>;
          if (typeof e.oldText === 'string') oldParts.push(e.oldText);
          if (typeof e.newText === 'string') newParts.push(e.newText);
        }
      }
      if (newParts.length > 0) {
        return {
          path,
          oldText: oldParts.join('\n'),
          newText: newParts.join('\n'),
        };
      }
    }
    // Fallback: direct oldText/newText in args
    if (typeof parsedArgs.oldText === 'string' && typeof parsedArgs.newText === 'string') {
      return {
        path,
        oldText: parsedArgs.oldText,
        newText: parsedArgs.newText,
      };
    }
    return null;
  }

  return null;
}

/** Inline component for write/edit diff view inside tool call cards */
function DiffViewerInline({
  toolName,
  parsedArgs,
  argsStr,
}: {
  toolName: string;
  parsedArgs: Record<string, unknown>;
  argsStr: string;
}) {
  const parsed = React.useMemo(
    () => parseWriteEditArgs(toolName, parsedArgs),
    [toolName, parsedArgs],
  );

  if (!parsed) {
    return (
      <div className="px-3 py-2">
        <pre className="text-[11px] text-amber-900 dark:text-amber-200 font-mono whitespace-pre-wrap overflow-x-auto leading-relaxed">
          {argsStr}
        </pre>
      </div>
    );
  }

  return (
    <DiffViewer
      oldText={parsed.oldText}
      newText={parsed.newText}
      filename={parsed.path}
      viewType={toolName === 'write' ? 'write' : 'edit'}
    />
  );
}

function TabChat({
  messages,
  hasMore,
  loadingMore,
  onLoadMore,
  onSend,
  onStop,
  sending,
  runtimeStatus,
  selectedSessionId,
  sendShortcutMode,
  models,
  currentModelValue,
  currentModelSupportsImages,
  visionRelayEnabled,
  onModelSelect,
  onArchiveSession,
  archivePending,
  showArchiveButton,
  onCompactSession,
  compactPending,
  onSendPlannerRolePrompt,
  plannerRolePromptPending,
  showPlannerRolePromptButton,
  thinkingLevelValue,
  thinkingLevelOptions,
  onThinkingLevelSelect,
  isMobile,
}: TabChatProps) {
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [expandedToolIds, setExpandedToolIds] = useState<Set<string>>(new Set());
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const prevSessionIdRef = useRef<string | null | undefined>(selectedSessionId);
  const prevScrollHeightRef = useRef<number | null>(null);
  const [pendingUserMessages, setPendingUserMessages] = useState<ChatMessageDTO[]>([]);
  const { connected: wsConnected, clearStreamRuntimeErrors } = useWebSocket();
  // 流式快照统一由 ws-provider 按 sessionId 管理（80ms 节流），本组件只消费
  const { phase, streamingContent, streamNote, runtimeErrors } = useChatStream(selectedSessionId ?? null);

  const [isNearBottom, setIsNearBottom] = useState(true);
  const isNearBottomRef = useRef(true);

  const handleScrollToBottom = () => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    setIsNearBottom(true);
    isNearBottomRef.current = true;
  };

  const imageBlockToDataUrl = (block: ChatImageContentBlockDTO) => {
    if (!block.data_base64 || !block.mime_type) return block.uri;
    return `data:${block.mime_type};base64,${block.data_base64}`;
  };

  const imageBlocks = (msg: ChatMessageDTO): ChatImageContentBlockDTO[] =>
    (msg.content_blocks ?? []).filter((block): block is ChatImageContentBlockDTO => block.type === 'image');

  const textBlocks = (msg: ChatMessageDTO): ChatMessageContentBlockDTO[] =>
    (msg.content_blocks ?? []).filter((block) => block.type === 'text');

  // 将刚完成的 streaming 内容作为占位消息加入，避免 query 刷新前的闪白
  // 由快照推导：仅 complete 阶段保留内容，展示到被真实消息确认或下一轮流开始
  const pendingAssistantContent = phase === 'complete' && streamingContent ? streamingContent : null;
  // 用 useMemo 判断当前 pending 内容是否已被真实消息确认
  const pendingAssistantConfirmed = useMemo(() => {
    if (!pendingAssistantContent) return false;
    return messages.some((m) =>
      m.role === 'assistant' && m.content_text === pendingAssistantContent,
    );
  }, [messages, pendingAssistantContent]);

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
      && (m.content_text ?? '') === (pm.content_text ?? '')
      && imageSignature(m.content_blocks) === pendingImageSignature
      && Math.abs(new Date(m.created_at).getTime() - new Date(pm.created_at).getTime()) < 300_000,
    );
    const hasPendingMatch = allMessages.some((m) => m.id === pm.id);
    if (!hasConfirmedMatch && !hasPendingMatch) {
      allMessages.push(pm);
    }
  }

  if (pendingAssistantContent && !pendingAssistantConfirmed) {
    allMessages.push({
      id: `stream-pending-${Date.now()}`,
      role: 'assistant',
      message_kind: 'normal',
      source_session_id: null,
      content_text: pendingAssistantContent,
      created_at: new Date().toISOString(),
    });
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

  // 会话内全部图片构成画廊（谷歌相册式）：左右切换浏览本会话所有图片，点击定位到对应 index
  const sessionImageSlides = useMemo(() => {
    const slides: Array<{ src: string; filename: string }> = [];
    for (const msg of displayMessages) {
      for (const block of msg.content_blocks ?? []) {
        if (block.type !== 'image') continue;
        const src = imageBlockToDataUrl(block);
        if (!src) continue;
        slides.push({ src, filename: block.filename ?? `image-${slides.length + 1}.png` });
      }
    }
    return slides;
  }, [displayMessages]);

  const openImagePreview = useCallback((block: ChatImageContentBlockDTO) => {
    const src = imageBlockToDataUrl(block);
    if (!src) return;
    const idx = sessionImageSlides.findIndex((s) => s.src === src);
    setLightboxIndex(idx >= 0 ? idx : 0);
    setLightboxOpen(true);
  }, [sessionImageSlides]);

  // 触顶加载判定：首消息 id 变化即视为 prepend（排除底部流式增长误判）
  const prevFirstMsgIdRef = useRef<string | undefined>(displayMessages[0]?.id);

  // 单一滚动协调：会话切换跳底 / 触顶加载补偿 / 底部跟随（统一瞬时 scrollTo，无 smooth 动画竞争）
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const sessionSwitched = prevSessionIdRef.current !== selectedSessionId;
    prevSessionIdRef.current = selectedSessionId;

    if (sessionSwitched) {
      // 会话切换：真实消息渲染后（layout effect 时机）直接跳底，无需 rAF
      container.scrollTop = container.scrollHeight;
      setIsNearBottom(true);
      isNearBottomRef.current = true;
      prevScrollHeightRef.current = container.scrollHeight;
      prevFirstMsgIdRef.current = displayMessages[0]?.id;
      return;
    }

    const firstId = displayMessages[0]?.id;
    const prepended = prevFirstMsgIdRef.current !== firstId;
    prevFirstMsgIdRef.current = firstId;

    const prevHeight = prevScrollHeightRef.current;
    prevScrollHeightRef.current = container.scrollHeight;

    const heightDelta = prevHeight === null ? 0 : container.scrollHeight - prevHeight;

    // 触顶加载更早消息（首消息 id 变化且高度增长）：补偿 scrollTop 保持阅读位置
    if (prepended && heightDelta > 0 && !isNearBottomRef.current) {
      container.scrollTop += heightDelta;
      return;
    }

    // 底部跟随：用户停留在底部附近时，任何内容变化（流式 delta/append/乐观消息）都瞬时吸底
    if (isNearBottomRef.current) {
      container.scrollTop = container.scrollHeight;
      setIsNearBottom(true);
    }
  }, [displayMessages, streamingContent, selectedSessionId]);

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

  // 运行结束（running→idle）时清空暂存用户消息；流式快照由 ws-provider 自行重置
  const prevRuntimeStatus = useRef(runtimeStatus);
  useEffect(() => {
    if (runtimeStatus === 'idle' && prevRuntimeStatus.current === 'running') {
      setPendingUserMessages([]);
    }
    prevRuntimeStatus.current = runtimeStatus;
  }, [runtimeStatus]);


  // 流式订阅已迁移至 useChatStream：ws-provider 按 sessionId 累积快照（含切会话自动切换），
  // 不再需要本地订阅 effect 与切会话清空逻辑

  // Internal send handler that manages pending user messages
  const handleSendInternal = useCallback(async (content: string, attachments: SessionMessageImageAttachment[]) => {
    // 发送新消息时清除旧运行时错误（基线行为，迁移到 provider 快照后经 context 方法恢复）
    clearStreamRuntimeErrors(selectedSessionId ?? null);
    const optimisticId = `optimistic_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const imageBlocks: ChatImageContentBlockDTO[] = attachments.map((attachment) => ({
      type: 'image',
      mime_type: attachment.mime_type,
      media_type: attachment.mime_type,
      filename: attachment.filename ?? null,
      uri: null,
      data_base64: attachment.data_base64,
    }));
    const optimisticMessage: ChatMessageDTO = {
      id: optimisticId,
      role: 'user',
      message_kind: 'normal',
      source_session_id: null,
      content_text: content,
      content_blocks: [
        ...(content ? [{ type: 'text' as const, text: content }] : []),
        ...imageBlocks,
      ],
      created_at: new Date().toISOString(),
    };
    setPendingUserMessages((prev) => [...prev, optimisticMessage]);
    // 发送消息后强制开启底部跟随：乐观消息插入渲染后由滚动协调 effect 吸底，
    // 无论用户之前在哪个位置都能看到新消息与回复
    isNearBottomRef.current = true;
    setIsNearBottom(true);
    try {
      await onSend(content, attachments);
      // 成功后不移除：等待 messages query 轮询拉到真实消息后由 reconcile 确认，
      // 避免 POST 返回与 refetch 完成之间的窗口期用户消息闪白（60s 兜底见下方 effect）
    } catch (err) {
      setPendingUserMessages((prev) => prev.filter((m) => m.id !== optimisticId));
      throw err;
    }
  }, [onSend, clearStreamRuntimeErrors, selectedSessionId]);

  // 兜底：乐观消息 60s 未被真实消息确认则强制移除（正常由 refetch/1.5s 轮询确认）
  useEffect(() => {
    if (pendingUserMessages.length === 0) return;
    const timers = pendingUserMessages.map((pm) =>
      setTimeout(() => {
        setPendingUserMessages((prev) => prev.filter((m) => m.id !== pm.id));
      }, 60_000),
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [pendingUserMessages]);

  // 切换会话时清空乐观消息（跨会话 reconcile 不匹配，避免 A 的乐观消息渲染进 B）
  useEffect(() => {
    setPendingUserMessages([]);
  }, [selectedSessionId]);

  // 通用复制逻辑：navigator.clipboard 优先，fallback textarea + execCommand
  const copyText = async (text: string) => {
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
  };

  // 单条消息复制：成功显示 Check 图标 2 秒后恢复
  const handleCopyMessage = async (msgId: string, text: string) => {
    try {
      await copyText(text);
      setCopiedMessageId(msgId);
      setTimeout(() => setCopiedMessageId(null), 2000);
    } catch {
      setCopiedMessageId(null);
    }
  };

  // 滚动监听：同步更新按钮状态和跟随标记（两者共用同一 FOLLOW_THRESHOLD 阈值）
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const checkNearBottom = () => {
      const near = container.scrollHeight - container.scrollTop - container.clientHeight < FOLLOW_THRESHOLD;
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

  // 兜底：如果最后一条消息是工具调用且 session 运行中，末尾连续的 tool_call 一定需要转圈
  const trailingToolCallIds = useMemo(() => {
    if (!isRunning) return new Set<string>();
    const last = displayMessages[displayMessages.length - 1];
    if (!last || last.message_kind !== 'tool_call') return new Set<string>();
    const ids = new Set<string>();
    for (let i = displayMessages.length - 1; i >= 0; i--) {
      if (displayMessages[i].message_kind === 'tool_call') {
        ids.add(displayMessages[i].id);
      } else {
        break;
      }
    }
    return ids;
  }, [isRunning, displayMessages]);

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-100/40 dark:bg-slate-900/10 relative overflow-x-hidden">
      {/* Messages */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden px-6 py-4 space-y-6">
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
          const isErrorKind = msg.message_kind === 'error';

          // Error message (vision relay failure etc.): red notice card
          if (isErrorKind) {
            return (
              <div key={msg.id} className="flex justify-start items-start w-full min-w-0">
                <div className="flex flex-col items-start max-w-full flex-1 min-w-0">
                  <div className="w-full rounded-xl border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30 p-3 space-y-1">
                    <div className="flex items-center gap-1.5 text-xs font-bold text-red-700 dark:text-red-400">
                      <OctagonX className="w-3.5 h-3.5" />
                      系统提示
                    </div>
                    <div className="text-xs text-red-700 dark:text-red-400 whitespace-pre-wrap">
                      {msg.content_text}
                    </div>
                  </div>
                  <span className="text-[10px] text-slate-400 dark:text-slate-500 mt-1 px-1 font-mono">
                    {new Date(msg.created_at).toLocaleTimeString()}
                  </span>
                </div>
              </div>
            );
          }

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
            const isThisToolRunning = (isRunning && isInCurrentRun && isToolCallPending(msg.id, toolName, messages)) || trailingToolCallIds.has(msg.id);

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
              <div key={msg.id} className="flex justify-start items-start w-full min-w-0">
                {isThisToolRunning && (
                  <div className="mr-2 pt-2 shrink-0">
                    <LoaderCircle className="w-4 h-4 text-indigo-500 animate-spin" />
                  </div>
                )}
                <div className="flex flex-col items-start max-w-full flex-1 min-w-0">
                  <div
                    className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-xl overflow-hidden transition-colors hover:bg-amber-100/80 dark:hover:bg-amber-900/40"
                  >
                    <div className="px-3 py-2 flex items-center gap-2 cursor-pointer select-none" onClick={toggleExpand}>
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
                      <div className="border-t border-amber-200 dark:border-amber-800">
                        {(toolName === 'write' || toolName === 'edit') && parsedArgs ? (
                          <DiffViewerInline
                            toolName={toolName}
                            parsedArgs={parsedArgs}
                            argsStr={argsStr}
                          />
                        ) : (toolName === 'spawn_session' || toolName === 'send_message_to_session') && parsedArgs ? (
                          <div className="px-3 py-2">
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
                          </div>
                        ) : (
                          <div className="px-3 py-2">
                            <pre className="text-[11px] text-amber-900 dark:text-amber-200 font-mono whitespace-pre-wrap overflow-x-auto leading-relaxed">
                              {argsStr}
                            </pre>
                          </div>
                        )
                      }
                    </div>
                  )
                  }
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

            // spawn_session / writeback_to_parent 结果中提取 summary 字段用于 Markdown 渲染
            let spawnSummary: string | null = null;
            let spawnStatus: string | null = null;
            if ((toolName === 'spawn_session' || toolName === 'send_message_to_session') && msg.content_text && !isError) {
              try {
                const parsed = JSON.parse(msg.content_text);
                if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
                  spawnSummary = parsed.summary.trim();
                  spawnStatus = typeof parsed.status === 'string' ? parsed.status : null;
                }
              } catch {
                // 不是 JSON，保持 compact 渲染
              }
            }

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
              : spawnSummary
                ? {
                    bg: 'bg-indigo-50 dark:bg-indigo-950/30',
                    border: 'border-indigo-200 dark:border-indigo-800',
                    borderT: 'border-indigo-200 dark:border-indigo-800',
                    icon: 'text-indigo-600 dark:text-indigo-400',
                    label: 'text-indigo-800 dark:text-indigo-300',
                    text: 'text-indigo-900 dark:text-indigo-200',
                    suffix: 'text-indigo-600/60 dark:text-indigo-400/60',
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
              <div key={msg.id} className="flex justify-start items-start w-full min-w-0 group">
                <div className="flex flex-col items-start max-w-full flex-1 min-w-0">
                  <div className={`${colorScheme.bg} ${colorScheme.border} rounded-xl overflow-hidden`}>
                    <div className="px-3 py-2 flex items-center gap-2">
                      <Terminal className={`w-3.5 h-3.5 ${colorScheme.icon} shrink-0`} />
                      <span className={`text-xs font-semibold ${colorScheme.label} font-mono`}>
                        {toolName}
                      </span>
                      {spawnSummary && spawnStatus && (
                        <span className={`text-[10px] ${colorScheme.suffix} ml-1`}>
                          {spawnStatus === 'completed' ? '完成' : spawnStatus}
                        </span>
                      )}
                      {!spawnSummary && (
                        <span className={`text-[10px] ${colorScheme.suffix} ml-1`}>
                          {isError ? '错误' : '结果'}
                        </span>
                      )}
                    </div>
                    {spawnSummary ? (
                      <div className={`border-t ${colorScheme.borderT} px-4 py-3`}>
                        <div className="text-slate-800 dark:text-slate-200 w-full">
                          <MarkdownRenderer content={spawnSummary} variant="compact" />
                        </div>
                      </div>
                    ) : msg.content_text ? (
                      <div className={`border-t ${colorScheme.borderT} px-3 py-2`}>
                        <div className={`text-[11px] ${colorScheme.text} font-mono whitespace-pre-wrap leading-relaxed max-h-32 overflow-y-auto`}>
                          {summary}
                        </div>
                      </div>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2 mt-1 px-1">
                    {msg.content_text ? (
                      <button
                        type="button"
                        onClick={() => handleCopyMessage(msg.id, msg.content_text)}
                        className="md:opacity-0 md:group-hover:opacity-100 transition flex items-center gap-1 text-[10px] text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 font-mono cursor-pointer"
                        title="复制消息"
                      >
                        {copiedMessageId === msg.id ? (
                          <>
                            <Check className="w-3 h-3 text-green-600" />
                            <span className="text-green-600 font-medium">已复制</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3 h-3" />
                            <span>复制</span>
                          </>
                        )}
                      </button>
                    ) : null}
                    <span className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">
                      {new Date(msg.created_at).toLocaleTimeString()}
                    </span>
                  </div>
                </div>
              </div>
            );
          }

          return (
            <div key={msg.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'} items-start w-full min-w-0 group`}>
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
                              onClick={() => openImagePreview(block)}
                              className="overflow-hidden rounded-2xl border border-blue-400/30 bg-blue-500/10 hover:opacity-90 transition cursor-pointer"
                              title={block.filename ?? '预览图片'}
                            >
                              <img src={src} alt={block.filename ?? `attachment-${index + 1}`} className="h-20 w-20 object-cover" loading="lazy" />
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {(msg.content_text || textBlocks(msg).length > 0) && (
                      <div className="bg-blue-600 text-white rounded-2xl px-4 py-2.5 text-sm shadow-xs font-sans leading-relaxed break-words overflow-hidden">
                        <MarkdownRenderer content={msg.content_text ?? ''} variant="user" />
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-slate-800 dark:text-slate-200 w-full pl-0">
                    {msg.content_text?.includes('</think>') ? (
                      <blockquote className="border-l-4 border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 pl-3.5 py-3 my-2 text-slate-600 dark:text-slate-400 rounded-r-lg text-[13px] leading-relaxed whitespace-pre-wrap">
                        {msg.content_text.replace(/<\/?think>|<\/?thinking>/gi, '').trim()}
                      </blockquote>
                    ) : (
                      <MarkdownRenderer content={msg.content_text ?? ''} variant="assistant" blockIdPrefix={msg.id} />
                    )}
                </div>
              )}
                <div className="flex items-center gap-2 mt-2 px-1">
                  {msg.content_text ? (
                    <button
                      type="button"
                      onClick={() => handleCopyMessage(msg.id, msg.content_text)}
                      className="md:opacity-0 md:group-hover:opacity-100 transition flex items-center gap-1 text-[10px] text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 font-mono cursor-pointer"
                      title="复制消息"
                    >
                      {copiedMessageId === msg.id ? (
                        <>
                          <Check className="w-3 h-3 text-green-600" />
                          <span className="text-green-600 font-medium">已复制</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          <span>复制</span>
                        </>
                      )}
                    </button>
                  ) : null}
                  <span className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">
                    {new Date(msg.created_at).toLocaleTimeString()}
                  </span>
                </div>
              </div>
            </div>
          );
        })}

        {/* Streaming content（仅 streaming 阶段渲染，complete 后由占位消息接管，避免重复渲染） */}
        {phase === 'streaming' && streamingContent && (
          <div className="flex justify-start items-start w-full min-w-0">
            <div className="flex flex-col items-start max-w-full flex-1 min-w-0">
              <div className="text-slate-800 dark:text-slate-200 w-full pl-0">
                <MarkdownRenderer content={sanitizeStreamingContent(streamingContent)} variant="assistant" blockIdPrefix="stream" />
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
          {thinkingLevelOptions && thinkingLevelOptions.length > 0 && onThinkingLevelSelect && (
            <div className="relative shrink-0">
              <Select
                value={thinkingLevelValue ?? ''}
                onChange={onThinkingLevelSelect}
                options={thinkingLevelOptions.map((level) => ({
                  value: level,
                  label: THINKING_LEVEL_LABELS[level] ?? level,
                }))}
                getDisplayValue={(opt) => THINKING_LEVEL_DISPLAY_LABELS[opt.value] ?? opt.label}
                placeholder="思考层级"
                dropdownMaxHeight="max-h-56"
                dropdownMinWidth="100px"
                className="w-full"
                searchable={false}
              />
            </div>
          )}
          {showArchiveButton && onArchiveSession && (
            <button
              onClick={() => onArchiveSession?.()}
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

      <ChatInput
        onSend={handleSendInternal}
        onStop={onStop}
        sending={sending}
        isRunning={isRunning}
        sendShortcutMode={sendShortcutMode}
        currentModelSupportsImages={currentModelSupportsImages}
        visionRelayEnabled={visionRelayEnabled}
        wsConnected={wsConnected}
        selectedSessionId={selectedSessionId ?? null}
        isMobile={isMobile}
        onPreviewImage={openImagePreview}
      />

      {/* 图片预览：谷歌相册式 lightbox（暗色蒙版 + 居中图片 + 右上角关闭 + 底部工具栏），
          左右箭头在会话全部图片间切换；缩放/拖拽由 Zoom 插件提供，下载由 Download 插件提供（保留原始文件名） */}
      <Lightbox
        open={lightboxOpen}
        close={() => setLightboxOpen(false)}
        index={lightboxIndex}
        slides={sessionImageSlides.map((slide) => ({
          src: slide.src,
          download: { url: slide.src, filename: slide.filename },
        }))}
        plugins={[Zoom, Download]}
      />
    </div>
  );
}

export default React.memo(TabChat);
