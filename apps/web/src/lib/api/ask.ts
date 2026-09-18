import { request } from './client';

export function getAskPending(sessionId: string) {
  return request<{ pending: Array<{ questionId: string; sessionId: string; question?: string; options?: string[]; multiSelect?: boolean; label?: string; questions?: Array<{ question: string; options: string[]; multiSelect?: boolean; label?: string }> }> }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/ask-pending`);
}

/**
 * 全局待回答 ask_question（跨会话，仅当前用户创建的会话）。
 * 用于挂载 / WS 重连 / 窗口重新聚焦时补偿断线期间错过的 ask_question_pending 实时事件。
 * 形状与单会话接口一致：WS 事件携带的 AskQuestionPendingPayload 数组。
 */
export function getAllAskPending() {
  return request<{ pending: Array<{ questionId: string; sessionId: string; question?: string; options?: string[]; multiSelect?: boolean; label?: string; questions?: Array<{ question: string; options: string[]; multiSelect?: boolean; label?: string }> }> }>('/api/v1/ask-pending');
}

/**
 * 回填 ask_question 的待回答问题（单选/多选/自己输入/问卷/取消）。
 * body 与后端 answerQuestion 约定一致：{ questionId, answer | answers, wasCustom?, customAnswers?, cancelled? }。
 */
export function answerAskQuestion(
  sessionId: string,
  body: {
    questionId: string;
    answer?: string | string[] | null;
    answers?: unknown[];
    wasCustom?: boolean;
    customAnswers?: string[];
    cancelled?: boolean;
  },
) {
  return request<{ ok: boolean }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/ask-answer`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
