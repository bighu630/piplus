import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessageDTO } from '@piplus/shared';

/**
 * 乐观用户消息（尚未被 messages 查询确认的本地消息）的生命周期管理。
 *
 * 语义（R6 修复后）：
 * - 会话切换 / running→idle（run 结束）时清空；
 * - 兜底移除只在**非 running** 时计时，并在 messages 刷新（任何 invalidate 的落库结果）时重置计时。
 *   运行中绝不移除：首轮回答可能远超 60s，否则用户刚发的消息会先消失、等 complete 才回来。
 *
 * 「是否已被真实消息确认」由渲染层的 reconcile 判定（文本 + 图片签名），
 * 本 hook 只负责状态本身与过期策略。
 */

/** 非 running 状态下，乐观消息未被真实消息确认时的兜底移除时长。 */
export const OPTIMISTIC_MESSAGE_IDLE_FALLBACK_MS = 60_000;

export interface UseOptimisticUserMessagesParams {
  sessionId: string | null;
  isRunning: boolean;
  /** 会话消息列表（由 react-query 提供）：引用变化即视为发生了一次刷新，重置兜底计时 */
  messages: ChatMessageDTO[];
}

export interface OptimisticUserMessagesApi {
  pendingUserMessages: ChatMessageDTO[];
  addPendingUserMessage: (message: ChatMessageDTO) => void;
  removePendingUserMessage: (id: string) => void;
}

export function useOptimisticUserMessages({
  sessionId,
  isRunning,
  messages,
}: UseOptimisticUserMessagesParams): OptimisticUserMessagesApi {
  const [pendingUserMessages, setPendingUserMessages] = useState<ChatMessageDTO[]>([]);

  const addPendingUserMessage = useCallback((message: ChatMessageDTO) => {
    setPendingUserMessages((prev) => [...prev, message]);
  }, []);

  const removePendingUserMessage = useCallback((id: string) => {
    setPendingUserMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);

  // 切换会话：乐观消息与当前会话绑定，跨会话 reconcile 不匹配，直接清空避免渲染进别的会话
  useEffect(() => {
    setPendingUserMessages((prev) => (prev.length === 0 ? prev : []));
  }, [sessionId]);

  // run 结束（running→idle）：真实消息已落库，立即清理，不等兜底计时
  const prevIsRunningRef = useRef(isRunning);
  useEffect(() => {
    if (prevIsRunningRef.current && !isRunning) {
      setPendingUserMessages([]);
    }
    prevIsRunningRef.current = isRunning;
  }, [isRunning]);

  // 兜底移除：仅在非 running 时计时；messages 刷新（invalidate 落库）时重置计时。
  // 运行中不启动定时器，修复「首轮回答 > 60s 时用户消息被移除」。
  useEffect(() => {
    if (isRunning || pendingUserMessages.length === 0) return;
    const timers = pendingUserMessages.map((pending) =>
      setTimeout(() => {
        setPendingUserMessages((prev) => prev.filter((m) => m.id !== pending.id));
      }, OPTIMISTIC_MESSAGE_IDLE_FALLBACK_MS),
    );
    return () => timers.forEach((timer) => clearTimeout(timer));
  }, [isRunning, pendingUserMessages, messages]);

  return {
    pendingUserMessages,
    addPendingUserMessage,
    removePendingUserMessage,
  };
}
