import { describe, expect, test } from 'bun:test';
import {
  WS_EVENT_ASK_QUESTION_PENDING,
  isAskQuestionPending,
  isClientMessage,
  type AskQuestionPendingPayload,
} from './ws';

describe('ws.ts ask_question 类型与守卫', () => {
  test('常量与事件名一致', () => {
    expect(WS_EVENT_ASK_QUESTION_PENDING).toBe('ask_question_pending');
  });

  test('isAskQuestionPending 识别 ask_question_pending 服务端事件', () => {
    const pending: AskQuestionPendingPayload = {
      questionId: 'q1',
      sessionId: 'sess1',
      question: 'Q?',
      options: ['A', 'B'],
      multiSelect: false,
    };
    const event = {
      kind: 'event',
      type: WS_EVENT_ASK_QUESTION_PENDING,
      timestamp: 't',
      scope: { session_id: 'sess1' },
      payload: pending,
    };
    expect(isAskQuestionPending(event)).toBe(true);
    expect(isAskQuestionPending({ ...event, type: 'other' })).toBe(false);
    expect(isAskQuestionPending({ ...event, kind: 'client' })).toBe(false);
    expect(isAskQuestionPending(null)).toBe(false);
    expect(isAskQuestionPending('x')).toBe(false);
  });

  test('isAskQuestionPending 识别问卷 payload', () => {
    const event = {
      kind: 'event',
      type: WS_EVENT_ASK_QUESTION_PENDING,
      timestamp: 't',
      payload: {
        questionId: 'qn',
        questions: [{ question: 'q1', options: ['a', 'b'] }],
      },
    };
    expect(isAskQuestionPending(event)).toBe(true);
  });

  test('isClientMessage 保持原有识别（未因新增事件回归）', () => {
    expect(isClientMessage({ kind: 'client', type: 'hello', payload: { user_agent: 'x' } })).toBe(true);
    expect(isClientMessage({ kind: 'client', type: 'subscribe_session', payload: { session_id: 's' } })).toBe(true);
    expect(isClientMessage({ kind: 'event', type: WS_EVENT_ASK_QUESTION_PENDING, payload: {} })).toBe(false);
  });
});
