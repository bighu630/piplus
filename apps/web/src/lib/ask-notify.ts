import type { AskQuestionPendingPayload } from '@piplus/shared';

/**
 * ask_question 通知的纯逻辑（无 React / DOM 依赖，便于单测）。
 *
 * 触发条件（用户确认）：提问所在会话 **≠** 当前激活会话，**或** 窗口/标签页失焦 —— 两者取或。
 * 用户正盯着提问卡片时不打扰。
 */
export function shouldNotifyAsk(params: {
  /** 提问所属会话（payload.sessionId）。缺失时无法跳转，也不通知。 */
  sessionId: string | undefined;
  /** 当前激活会话。 */
  activeSessionId: string | null;
  /** 窗口/标签页是否聚焦。 */
  hasFocus: boolean;
}): boolean {
  const { sessionId, activeSessionId, hasFocus } = params;
  if (!sessionId) return false;
  if (!hasFocus) return true;
  return sessionId !== activeSessionId;
}

/**
 * 当前焦点状态。
 * `document.hasFocus()` 为主（切到别的应用时为 false），
 * `visibilityState === 'hidden'` 兜底（切标签页时部分浏览器 hasFocus 仍为 true）。
 */
export function isWindowFocused(): boolean {
  if (typeof document === 'undefined' || typeof document.hasFocus !== 'function') return true;
  if (document.visibilityState === 'hidden') return false;
  return document.hasFocus();
}

/**
 * 通知 / toast 正文：单题显示问题原文；问卷显示题量 + 首题。
 * 空白折叠后截断，避免系统通知里出现换行撑爆布局。
 */
export function askNotificationBody(payload: AskQuestionPendingPayload, maxLength = 120): string {
  const questions = payload.questions ?? [];
  const raw = questions.length > 0
    ? `共 ${questions.length} 个问题待回答：${questions[0]?.question ?? ''}`
    : (payload.question ?? '');
  const normalized = raw.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Agent 正在等待你的回答';
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

/** 标题前缀：`(N 条待回答) PiPlus`。仅作为持久未读指示（不做焦点判断，有 pending 就显示）。 */
const ASK_TITLE_PREFIX_RE = /^\(\d+ 条待回答\)\s*/;

export function withAskTitle(baseTitle: string, pendingCount: number): string {
  return pendingCount > 0 ? `(${pendingCount} 条待回答) ${baseTitle}` : baseTitle;
}

/**
 * 还原标题（去掉本模块加的前缀）。
 * 每次由 `stripAskTitle(document.title)` 现算 base 而不是缓存常量，
 * 避免与应用其它来源的标题（如版本号）互相覆盖。
 */
export function stripAskTitle(title: string): string {
  return title.replace(ASK_TITLE_PREFIX_RE, '');
}
