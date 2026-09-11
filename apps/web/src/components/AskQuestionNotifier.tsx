import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CircleHelp, X } from 'lucide-react';
import type { AskQuestionPendingPayload, ProjectDTO } from '@piplus/shared';
import { useWebSocket } from '../lib/ws-provider';
import { createSystemNotification, systemNotificationsEnabled } from '../lib/notification';
import {
  askNotificationBody,
  isWindowFocused,
  shouldNotifyAsk,
  stripAskTitle,
  withAskTitle,
} from '../lib/ask-notify';
import { findSessionNode } from '../lib/tree-utils';

/** toast 自动消失时长 / 同屏最多条数（超出丢弃最旧的，避免刷屏）。 */
const TOAST_TTL_MS = 10_000;
const MAX_TOASTS = 3;
const FALLBACK_TITLE = 'PiPlus';

type AskToastItem = {
  questionId: string;
  sessionId: string;
  title: string;
  body: string;
};

export type AskQuestionNotifierProps = {
  /** 当前激活会话（App 的 selectedSessionId）。 */
  activeSessionId: string | null;
  /** 点击通知/浮层时跳转到提问所在会话（App 的 handleSelectSession 包装）。 */
  onNavigateSession: (sessionId: string) => void;
};

/**
 * ask_question 通知器：把 `ask_question_pending`（由 ws-provider 全局分发，
 * 含非活跃会话与补偿拉取）转成用户可见的提醒。
 *
 * 四条提示通道（用户确认的组合）：
 * 1. 系统通知（OS 弹窗）—— 复用「系统通知」总开关与浏览器权限，点击聚焦窗口 + 跳转会话
 * 2. 应用内 toast —— 无需权限，点击同样跳转
 * 3. 侧边栏琥珀标记 —— 由 Sidebar 消费 askingPendingMap（本组件不负责渲染）
 * 4. 标签页标题前缀 —— `(N 条待回答) PiPlus`，pending 清空后自动还原
 *
 * 触发条件：会话 ≠ 当前激活会话，或窗口失焦（两者取或）；同一 questionId 只通知一次。
 */
export default function AskQuestionNotifier({ activeSessionId, onNavigateSession }: AskQuestionNotifierProps) {
  const { subscribeToAskQuestionPending, askingPendingMap } = useWebSocket();
  const queryClient = useQueryClient();
  const [toasts, setToasts] = useState<AskToastItem[]>([]);
  const notifiedRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // 订阅回调只注册一次，用 ref 读取最新 props，避免闭包读到旧的 activeSessionId / 回调
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const onNavigateRef = useRef(onNavigateSession);
  onNavigateRef.current = onNavigateSession;

  const sessionTitle = useCallback((sessionId: string): string => {
    try {
      const treeData = queryClient.getQueryData<{ projects?: ProjectDTO[] }>(['tree']);
      const node = treeData?.projects ? findSessionNode(treeData.projects, sessionId) : null;
      return node?.title || '会话';
    } catch {
      return '会话';
    }
  }, [queryClient]);

  const dismissToast = useCallback((questionId: string) => {
    setToasts((prev) => prev.filter((t) => t.questionId !== questionId));
    const timer = timersRef.current.get(questionId);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(questionId);
    }
  }, []);

  const handlePending = useCallback((payload: AskQuestionPendingPayload) => {
    const questionId = payload?.questionId;
    const sessionId = payload?.sessionId;
    // 无 questionId 无法去重、无 sessionId 无法跳转：直接忽略
    if (!questionId || !sessionId) return;
    if (notifiedRef.current.has(questionId)) return;
    notifiedRef.current.add(questionId);
    if (!shouldNotifyAsk({
      sessionId,
      activeSessionId: activeSessionIdRef.current,
      hasFocus: isWindowFocused(),
    })) return;

    const title = sessionTitle(sessionId);
    const body = askNotificationBody(payload);

    if (systemNotificationsEnabled()) {
      const notification = createSystemNotification(`PiPlus：${title} 等待回答`, {
        body,
        tag: `ask-${questionId}`, // 同一提问重复到达时由系统合并，不堆叠
      });
      if (notification) {
        notification.onclick = () => {
          window.focus();
          onNavigateRef.current(sessionId);
          notification.close();
        };
      }
    }

    setToasts((prev) => [
      ...prev.filter((t) => t.questionId !== questionId),
      { questionId, sessionId, title, body },
    ].slice(-MAX_TOASTS));
    timersRef.current.set(questionId, setTimeout(() => dismissToast(questionId), TOAST_TTL_MS));
  }, [dismissToast, sessionTitle]);

  useEffect(() => subscribeToAskQuestionPending(handlePending), [subscribeToAskQuestionPending, handlePending]);

  // 卸载时清理 toast 定时器，避免定时器在组件销毁后 setState
  useEffect(() => () => {
    timersRef.current.forEach((timer) => clearTimeout(timer));
    timersRef.current.clear();
  }, []);

  // 标题前缀：有 pending 就显示（持久未读指示），全部答完后还原。
  // 注意：pendingCount 变化时不清标题，避免多实例/多次渲染互相抹除；
  // 卸载（登出）时还原，避免遗留「(N 条待回答)」到登录页。
  const pendingCount = Object.keys(askingPendingMap ?? {}).length;
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const next = withAskTitle(stripAskTitle(document.title) || FALLBACK_TITLE, pendingCount);
    if (document.title !== next) document.title = next;
  }, [pendingCount]);

  useEffect(() => () => {
    if (typeof document !== 'undefined') document.title = stripAskTitle(document.title);
  }, []);

  const handleToastClick = useCallback((item: AskToastItem) => {
    if (typeof window !== 'undefined') window.focus();
    onNavigateRef.current(item.sessionId);
    dismissToast(item.questionId);
  }, [dismissToast]);

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-[70] flex w-[min(320px,calc(100vw-2rem))] flex-col gap-2 pointer-events-none"
      role="status"
      aria-live="polite"
    >
      {toasts.map((item) => (
        <div
          key={item.questionId}
          role="button"
          tabIndex={0}
          onClick={() => handleToastClick(item)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleToastClick(item);
            }
          }}
          className="pointer-events-auto flex cursor-pointer items-start gap-2 rounded-xl border border-amber-200 bg-white px-3 py-2.5 shadow-lg transition-colors hover:border-amber-300 dark:border-amber-900 dark:bg-slate-900 dark:hover:border-amber-700"
        >
          <CircleHelp className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold text-slate-800 dark:text-slate-100">
              {item.title} 等待回答
            </p>
            <p className="mt-0.5 line-clamp-2 break-words text-[11px] text-slate-500 dark:text-slate-400">
              {item.body}
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭通知"
            onClick={(e) => {
              e.stopPropagation();
              dismissToast(item.questionId);
            }}
            className="shrink-0 cursor-pointer text-slate-400 transition-colors hover:text-slate-600 dark:hover:text-slate-200"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
