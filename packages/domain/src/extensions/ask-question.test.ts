import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// 超时时长按次解析（createPending 时读 PIPLUS_ASK_QUESTION_TIMEOUT_MS），
// beforeEach 设置即可生效，无模块加载时序依赖
import { answerQuestion, executeAskQuestion, pendingQuestions } from './ask-question';

const ORIGINAL_TIMEOUT = process.env.PIPLUS_ASK_QUESTION_TIMEOUT_MS;

beforeEach(() => {
  process.env.PIPLUS_ASK_QUESTION_TIMEOUT_MS = '50';
});

afterEach(() => {
  if (ORIGINAL_TIMEOUT === undefined) delete process.env.PIPLUS_ASK_QUESTION_TIMEOUT_MS;
  else process.env.PIPLUS_ASK_QUESTION_TIMEOUT_MS = ORIGINAL_TIMEOUT;
  // 清理未回填的 pending（超时已自动释放，这里兜底）
  for (const id of [...pendingQuestions.keys()]) {
    answerQuestion(id, null);
  }
});

describe('executeAskQuestion', () => {
  test('单题正常回答：answer 解析并返回 details', async () => {
    const promise = executeAskQuestion({ question: 'Q?', options: ['A', 'B'] }, { sessionId: 'sess_ok' });
    const questionId = [...pendingQuestions.keys()].find((id) => pendingQuestions.get(id)?.sessionId === 'sess_ok');
    expect(questionId).toBeTruthy();
    expect(answerQuestion(questionId!, 'A')).toEqual({ ok: true });

    const result = await promise;
    expect(result.content[0].text).toBe('用户选择：A');
    expect(result.details).toMatchObject({ question: 'Q?', options: ['A', 'B'], answer: 'A', multiSelect: false });
  });

  test('单题超时：details 含 cancelled:true（前端按“已取消”渲染）', async () => {
    const result = await executeAskQuestion({ question: 'Q?', options: ['A', 'B'] }, { sessionId: 'sess_timeout' });

    expect(result.content[0].text).toBe('用户未回答');
    // 修复点：#7 单题超时 details 补 cancelled: true（与问卷超时的 cancelled 对齐）
    expect(result.details).toMatchObject({
      question: 'Q?',
      options: ['A', 'B'],
      answer: null,
      multiSelect: false,
      cancelled: true,
    });
  });

  test('问卷超时：details 每题为未回答且 cancelled:true', async () => {
    const result = await executeAskQuestion(
      {
        questions: [
          { question: 'Q1', options: ['A', 'B'] },
          { question: 'Q2', options: ['X', 'Y'] },
        ],
      },
      { sessionId: 'sess_q_timeout' },
    );

    expect(result.content[0].text).toBe('用户未回答');
    const details = result.details as { cancelled?: boolean; questions: Array<{ answer: unknown }> };
    expect(details.cancelled).toBe(true);
    expect(details.questions).toHaveLength(2);
    expect(details.questions.every((q) => q.answer === null)).toBe(true);
  });

  test('单题取消：answer:null + cancelled:true 回填 → 用户取消', async () => {
    const promise = executeAskQuestion({ question: 'Q?', options: ['A', 'B'] }, { sessionId: 'sess_cancel' });
    const questionId = [...pendingQuestions.keys()].find((id) => pendingQuestions.get(id)?.sessionId === 'sess_cancel');
    expect(answerQuestion(questionId!, { answer: null, cancelled: true })).toEqual({ ok: true });

    const result = await promise;
    expect(result.content[0].text).toBe('用户取消了选择。');
    // 修复点：#7 单题取消 details 补 cancelled: true（与超时/问卷取消对齐，前端渲染 amber 取消样式）
    expect(result.details).toMatchObject({ answer: null, multiSelect: false, cancelled: true });
  });

  test('多选提交空数组：answer:null + cancelled:true → 用户取消', async () => {
    const promise = executeAskQuestion(
      { question: '多选?', options: ['A', 'B', 'C'], multiSelect: true },
      { sessionId: 'sess_multi_empty' },
    );
    const questionId = [...pendingQuestions.keys()].find((id) => pendingQuestions.get(id)?.sessionId === 'sess_multi_empty');
    expect(answerQuestion(questionId!, [])).toEqual({ ok: true });

    const result = await promise;
    expect(result.content[0].text).toBe('用户取消了选择。');
    expect(result.details).toMatchObject({ answer: null, multiSelect: true, cancelled: true });
  });

  test('单选提交空字符串：answer:null + cancelled:true → 用户取消', async () => {
    const promise = executeAskQuestion({ question: 'Q?', options: ['A', 'B'] }, { sessionId: 'sess_empty_str' });
    const questionId = [...pendingQuestions.keys()].find((id) => pendingQuestions.get(id)?.sessionId === 'sess_empty_str');
    expect(answerQuestion(questionId!, '')).toEqual({ ok: true });

    const result = await promise;
    expect(result.content[0].text).toBe('用户取消了选择。');
    expect(result.details).toMatchObject({ answer: null, multiSelect: false, cancelled: true });
  });

  test('多选：answers 数组回填', async () => {
    const promise = executeAskQuestion(
      { question: '多选?', options: ['A', 'B', 'C'], multiSelect: true },
      { sessionId: 'sess_multi' },
    );
    const questionId = [...pendingQuestions.keys()].find((id) => pendingQuestions.get(id)?.sessionId === 'sess_multi');
    expect(answerQuestion(questionId!, ['A', 'C'])).toEqual({ ok: true });

    const result = await promise;
    expect(result.details).toMatchObject({ answer: ['A', 'C'], multiSelect: true });
  });

  test('缺参数（无 question/options/questions）→ 抛错', async () => {
    await expect(executeAskQuestion({}, { sessionId: 'sess_bad' })).rejects.toThrow('ask_question 需要提供');
  });
});