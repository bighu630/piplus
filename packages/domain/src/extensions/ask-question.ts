import type { PiToolDef } from '@piplus/pi-client';
// 轻量导入 pi-client 的 pending 集合（无循环：ask-pending 不依赖 domain）
import { markAskPending as piMarkAskPending, unmarkAskPending as piUnmarkAskPending } from '@piplus/pi-client/ask-pending';

// ===== 类型定义，details 形状参考原扩展 curl.log =====

export interface AskQuestionDetails {
  question: string;
  options: string[];
  answer: string | string[] | null;
  multiSelect: boolean;
  wasCustom?: boolean;
  customAnswers?: string[];
  /** 超时/取消时置 true（与问卷 details.cancelled 对齐）。 */
  cancelled?: boolean;
}

export interface QuestionnaireDetails {
  questions: Array<AskQuestionDetails & { label?: string }>;
  cancelled?: boolean;
}

export interface AskQuestionInput {
  question: string;
  options: string[];
  multiSelect?: boolean;
  label?: string;
}

export interface AskQuestionResult {
  answers: string[];
  wasCustom?: boolean;
  customAnswers?: string[];
}

type QuestionnaireAnswer = AskQuestionResult & { completed: boolean };

export type AskQuestionPendingPayload = {
  questionId: string;
  sessionId: string;
  question?: string;
  options?: string[];
  multiSelect?: boolean;
  label?: string;
  questions?: AskQuestionInput[];
};

/**
 * pending promise 的 resolve 值。
 * 单题：{ answer: string | string[] | null, wasCustom?, customAnswers?, cancelled? }
 * 问卷：{ answers: 逐题答案数组, cancelled? }
 * 超时统一：{ cancelled: true, timeout: true }（answer/answers 为 null）
 */
export interface PendingResolveValue {
  answer?: string | string[] | null;
  answers?: unknown;
  wasCustom?: boolean;
  customAnswers?: string[];
  cancelled?: boolean;
  timeout?: boolean;
}

type PendingEntry = {
  sessionId: string;
  questionId: string;
  params: Record<string, unknown>;
  resolve: (value: PendingResolveValue) => void;
  reject: (reason?: unknown) => void;
  promise: Promise<PendingResolveValue>;
};

function setAskPending(sessionId: string) {
  try { piMarkAskPending(sessionId); } catch {}
}
function clearAskPending(sessionId: string) {
  const hasOther = Array.from(pendingQuestions.values()).some((e) => e.sessionId === sessionId);
  if (hasOther) return;
  try { piUnmarkAskPending(sessionId); } catch {}
}

// ===== 工具：normalizeOptions =====

export const normalizeOptions = (options: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const option of options) {
    const label = option.replace(/[\r\n\t]+/g, ' ').trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    result.push(label);
  }
  return result.slice(0, 8);
};

const formatList = (values: string[]): string => values.join('、');

// ===== pending 存储与监听 =====

export const pendingQuestions = new Map<string, PendingEntry>();

const pendingListeners = new Set<(payload: AskQuestionPendingPayload) => void>();

export function onAskQuestionPending(
  listener: (payload: AskQuestionPendingPayload) => void,
): () => void {
  pendingListeners.add(listener);
  return () => {
    pendingListeners.delete(listener);
  };
}

function notifyPending(payload: AskQuestionPendingPayload): void {
  for (const cb of pendingListeners) {
    try {
      cb(payload);
    } catch {
      // 单个监听器异常不影响其他监听器
    }
  }
}

// ===== 内部：问卷 details 构造，与原扩展一致 =====

const questionnaireDetails = (
  questions: AskQuestionInput[],
  answers: Array<QuestionnaireAnswer | undefined>,
): QuestionnaireDetails => ({
  questions: questions.map((question, index) => {
    const answer = answers[index];
    const options = normalizeOptions(question.options);
    const multiSelect = question.multiSelect === true;
    return {
      question: question.question,
      label: question.label,
      options,
      answer: answer?.completed ? (multiSelect ? answer.answers : (answer.answers[0] ?? '')) : null,
      multiSelect,
      wasCustom: answer?.wasCustom,
      customAnswers: answer?.customAnswers,
    };
  }),
});

function generateQuestionId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `ask_${crypto.randomUUID()}`;
    }
  } catch {
    // fall through
  }
  return `ask_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function isQuestionnaireParams(params: Record<string, unknown>): boolean {
  return Array.isArray(params.questions) && (params.questions as unknown[]).length > 0;
}

/**
 * 历史遗留：超时时长解析函数保留供测试兼容，但提问本身不再超时
 * （用户可在任意时间回答；session runtime 回收后重新激活仍可回答）。
 * 若未来需要恢复超时，可在此基础上重新启用。
 */
function resolveTimeoutMs(): number {
  const raw =
    typeof process !== 'undefined' ? process.env.PIPLUS_ASK_QUESTION_TIMEOUT_MS?.trim() : undefined;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 5 * 60 * 1000;
}
// 兼容导出（旧测试曾导入）
export { resolveTimeoutMs };

function cleanLabel(label: unknown): string | undefined {
  if (typeof label !== 'string') return undefined;
  const cleaned = label.replace(/[\r\n\t]+/g, ' ').trim();
  return cleaned || undefined;
}

// ===== createPending / answerQuestion =====

export function createPending(
  sessionId: string,
  params: Record<string, unknown>,
): { questionId: string; promise: Promise<PendingResolveValue> } {
  const questionId = generateQuestionId();

  let resolve!: (value: PendingResolveValue) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<PendingResolveValue>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const entry: PendingEntry = {
    sessionId,
    questionId,
    params,
    resolve,
    reject,
    promise,
  };
  pendingQuestions.set(questionId, entry);
  setAskPending(sessionId);

  // 通知监听器推送 WS 事件（单题或问卷）
  const payload: AskQuestionPendingPayload = { questionId, sessionId };
  if (isQuestionnaireParams(params)) {
    payload.questions = ((params.questions as unknown[]) ?? []).map((raw) => {
      const q = (raw ?? {}) as Record<string, unknown>;
      return {
        question: String(q.question ?? ''),
        options: Array.isArray(q.options) ? normalizeOptions((q.options as unknown[]).map(String)) : [],
        multiSelect: q.multiSelect === true,
        label: cleanLabel(q.label),
      } as AskQuestionInput;
    });
  } else {
    if (typeof params.question === 'string') payload.question = params.question;
    if (Array.isArray(params.options)) {
      payload.options = normalizeOptions((params.options as unknown[]).map(String));
    }
    payload.multiSelect = params.multiSelect === true;
    payload.label = cleanLabel(params.label);
  }
  notifyPending(payload);

  return { questionId, promise };
}

/**
 * 回填答案并 resolve 对应 pending promise。
 * 兼容调用形状：
 * - answerQuestion(id, 'A')
 * - answerQuestion(id, ['A', 'B'])
 * - answerQuestion(id, null) — 取消
 * - answerQuestion(id, { answer: 'A', wasCustom: true })
 * - answerQuestion(id, { answers: [...] })
 * - answerQuestion(id, { answer: null, cancelled: true })
 */
export function answerQuestion(
  questionId: string,
  answer: unknown,
  opts?: { wasCustom?: boolean; customAnswers?: string[]; cancelled?: boolean },
): { ok: boolean; error?: string } {
  const entry = pendingQuestions.get(questionId);
  if (!entry) {
    return { ok: false, error: 'not_found' };
  }
  pendingQuestions.delete(questionId);
  clearAskPending(entry.sessionId);

  let resolved: PendingResolveValue;

  // 已包装对象：{ answer | answers | cancelled | timeout | wasCustom | customAnswers }
  if (
    answer !== null &&
    typeof answer === 'object' &&
    !Array.isArray(answer) &&
    (('answer' in answer) || ('answers' in answer) || ('cancelled' in answer) ||
      ('timeout' in answer) || ('wasCustom' in answer) || ('customAnswers' in answer))
  ) {
    resolved = { ...(answer as PendingResolveValue) };
    // 排除误带入的 timeout 标记（主动回填不是超时）
    if (resolved.timeout && !resolved.cancelled) delete resolved.timeout;
  } else {
    // 裸值：string | string[] | null
    resolved = {};
    if (Array.isArray(answer)) {
      // 问卷：逐题答案数组；单题多选：选中的 string[]
      if (isQuestionnaireParams(entry.params)) {
        resolved.answers = answer;
      } else {
        resolved.answer = answer.map(String);
      }
    } else if (typeof answer === 'string') {
      resolved.answer = answer;
    } else {
      // null / undefined → 取消
      resolved.answer = null;
      resolved.cancelled = true;
    }
  }

  if (opts) {
    if (opts.wasCustom !== undefined) resolved.wasCustom = opts.wasCustom;
    if (opts.customAnswers !== undefined) resolved.customAnswers = opts.customAnswers;
    if (opts.cancelled !== undefined) resolved.cancelled = opts.cancelled;
  }

  entry.resolve(resolved);
  return { ok: true };
}

// ===== buildAskQuestionToolDef =====

export function buildAskQuestionToolDef(): PiToolDef {
  return {
    name: 'ask_question',
    description:
      '向用户提一个或多个问题，让用户从选项中选择、复选多项或自己输入。多个问题可逐题导航并在最后统一提交。需要用户决策、确认或补充信息时使用。',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '要展示给用户的问题。与 options 一起用于单个问题。',
        },
        options: {
          type: 'array',
          items: { type: 'string', description: '给用户选择的简短选项。建议 2-6 个。' },
          description: '单个问题的选项。工具会自动追加“自己输入”选项。',
          minItems: 1,
          maxItems: 8,
        },
        multiSelect: {
          type: 'boolean',
          description: '单个问题是否允许多选。',
        },
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: '要展示给用户的问题。' },
              options: {
                type: 'array',
                items: { type: 'string', description: '给用户选择的简短选项。建议 2-6 个。' },
                description: '可供用户选择的选项。工具会自动追加“自己输入”选项。',
                minItems: 1,
                maxItems: 8,
              },
              multiSelect: {
                type: 'boolean',
                description: '是否允许多选。true 时界面显示复选框，用户可勾选多项后提交。',
              },
              label: {
                type: 'string',
                description: '导航标签中的简短名称；未提供时显示为“问题 1”等。',
              },
            },
            required: ['question', 'options'],
          },
          description: '一次展示的多个问题。多个问题会显示导航标签和最终提交页。',
          minItems: 1,
          maxItems: 8,
        },
      },
      required: [],
    },
  };
}

// ===== 内部：结果解析辅助 =====

function asStringArray(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    const mapped = value.map((v) => (typeof v === 'string' ? v.trim() : String(v ?? '').trim())).filter(Boolean);
    return mapped;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : null;
  }
  return null;
}

function isCancelledResult(result: PendingResolveValue | null | undefined): boolean {
  if (!result) return true;
  if (result.cancelled === true) return true;
  if (result.answer === null) return true;
  if (result.answer === undefined && result.answers === undefined) return true;
  if (result.answers === null) return true;
  return false;
}

// ===== executeAskQuestion =====

export async function executeAskQuestion(
  params: Record<string, unknown>,
  ctx: { sessionId: string },
): Promise<{ content: Array<{ type: 'text'; text: string }>; details: unknown }> {
  const sessionId = ctx?.sessionId ?? 'unknown';

  // ===== 问卷模式：questions 数组 =====
  if (isQuestionnaireParams(params)) {
    const questions: AskQuestionInput[] = ((params.questions as unknown[]) ?? []).map((raw) => {
      const q = (raw ?? {}) as Record<string, unknown>;
      return {
        question: String(q.question ?? ''),
        options: normalizeOptions(Array.isArray(q.options) ? (q.options as unknown[]).map(String) : []),
        multiSelect: q.multiSelect === true,
        label: cleanLabel(q.label),
      } as AskQuestionInput;
    });

    if (questions.length === 0 || questions.some((q) => !q.question || q.options.length === 0)) {
      throw new Error('ask_question 需要提供 question 和 options，或提供非空的 questions 数组。');
    }

    const { promise } = createPending(sessionId, { questions } as unknown as Record<string, unknown>);

    const result = await promise;

    // 超时 / 取消 → 未回答的 details
    if (isCancelledResult(result) || result.timeout) {
      const details: QuestionnaireDetails = {
        questions: questions.map((q) => ({
          question: q.question,
          label: q.label,
          options: q.options,
          answer: null,
          multiSelect: q.multiSelect === true,
        })),
        cancelled: true,
      };
      const text = result?.timeout ? '用户未回答' : '用户取消了问卷。';
      return { content: [{ type: 'text', text }], details };
    }

    // 正常完成：归一化逐题答案
    const rawAnswers = Array.isArray(result.answers) ? (result.answers as unknown[]) : [];
    const normalizedAnswers: Array<QuestionnaireAnswer | undefined> = questions.map((q, index) => {
      const raw = rawAnswers[index];
      if (raw === undefined || raw === null) return undefined;
      // 逐题形状：string | string[] | { answers: string[], wasCustom?, customAnswers?, completed? } | { answer: ... }
      if (typeof raw === 'string') {
        const answers = asStringArray(raw);
        return answers ? { answers, completed: true } : undefined;
      }
      if (Array.isArray(raw)) {
        const answers = asStringArray(raw);
        return answers ? { answers, completed: true } : undefined;
      }
      if (typeof raw === 'object') {
        const obj = raw as Record<string, unknown>;
        if (Array.isArray(obj.answers)) {
          const answers = asStringArray(obj.answers);
          if (!answers) return undefined;
          return {
            answers,
            wasCustom: obj.wasCustom === true ? true : undefined,
            customAnswers: Array.isArray(obj.customAnswers) ? (obj.customAnswers as unknown[]).map(String) : undefined,
            completed: true,
          } as QuestionnaireAnswer;
        }
        if ('answer' in obj) {
          if (obj.answer === null) return undefined;
          const answers = asStringArray(obj.answer);
          if (!answers) return undefined;
          return {
            answers,
            wasCustom: obj.wasCustom === true ? true : undefined,
            customAnswers: Array.isArray(obj.customAnswers) ? (obj.customAnswers as unknown[]).map(String) : undefined,
            completed: true,
          } as QuestionnaireAnswer;
        }
      }
      return undefined;
    });

    const details = questionnaireDetails(questions, normalizedAnswers);
    details.cancelled = false;

    const summary = details.questions
      .map(
        (q, index) =>
          `${q.label || `问题 ${index + 1}`}（${q.question}）：${q.answer === null ? '未回答' : Array.isArray(q.answer) ? formatList(q.answer) : q.answer}`,
      )
      .join('\n');

    return {
      content: [{ type: 'text', text: `用户回答了 ${questions.length} 个问题：\n${summary}` }],
      details,
    };
  }

  // ===== 单题模式 =====
  if (typeof params.question !== 'string' || !Array.isArray(params.options)) {
    throw new Error('ask_question 需要提供 question 和 options，或提供非空的 questions 数组。');
  }

  const question = params.question;
  const options = normalizeOptions((params.options as unknown[]).map(String));
  const multiSelect = params.multiSelect === true;

  if (!question || options.length === 0) {
    throw new Error('ask_question 需要提供 question 和 options，或提供非空的 questions 数组。');
  }

  const { promise } = createPending(sessionId, { question, options, multiSelect } as unknown as Record<string, unknown>);

  const result = await promise;

  // 超时
  if (result?.timeout) {
    return {
      content: [{ type: 'text', text: '用户未回答' }],
      details: { question, options, answer: null, multiSelect, cancelled: true } as AskQuestionDetails,
    };
  }

  // 取消
  if (isCancelledResult(result)) {
    return {
      content: [{ type: 'text', text: '用户取消了选择。' }],
      details: { question, options, answer: null, multiSelect, cancelled: true } as AskQuestionDetails,
    };
  }

  // 多选
  if (multiSelect) {
    const finalAnswers = asStringArray(result.answer ?? result.answers) ?? [];
    if (finalAnswers.length === 0) {
      return {
        content: [{ type: 'text', text: '用户取消了选择。' }],
        details: { question, options, answer: null, multiSelect, cancelled: true } as AskQuestionDetails,
      };
    }
    return {
      content: [{ type: 'text', text: `用户选择了 ${finalAnswers.length} 项：\n${formatList(finalAnswers)}` }],
      details: {
        question,
        options,
        answer: finalAnswers,
        multiSelect: true,
        wasCustom: result.wasCustom,
        customAnswers: result.customAnswers,
      } as AskQuestionDetails,
    };
  }

  // 单选
  const finalAnswer = asStringArray(result.answer ?? result.answers)?.[0] ?? '';
  if (!finalAnswer) {
    return {
      content: [{ type: 'text', text: '用户取消了选择。' }],
      details: { question, options, answer: null, multiSelect, cancelled: true } as AskQuestionDetails,
    };
  }
  const wasCustom = result.wasCustom ?? !options.includes(finalAnswer);

  if (wasCustom) {
    return {
      content: [{ type: 'text', text: `用户输入：${finalAnswer}` }],
      details: {
        question,
        options,
        answer: finalAnswer,
        multiSelect: false,
        wasCustom: true,
        customAnswers: result.customAnswers,
      } as AskQuestionDetails,
    };
  }

  return {
    content: [{ type: 'text', text: `用户选择：${finalAnswer}` }],
    details: {
      question,
      options,
      answer: finalAnswer,
      multiSelect: false,
      wasCustom: false,
    } as AskQuestionDetails,
  };
}

// ===== before_agent_start systemPrompt 注入 =====

/** ask_question 工具的使用指引，注入到 systemPrompt，帮助模型恰当地使用该工具。
 *  接线：domain 的 startSessionRun/reloadProjectSessionRuntimes 在工具列表含
 *  ask_question 时，把本文本作为 systemPrompt 传入 pi-client ensureRuntime 的
 *  extensionFactories（registerAgentStartSystemPrompt 注册 before_agent_start 处理器），
 *  每 turn 注入一次（SDK 链式语义，不累积）。 */
export const ASK_QUESTION_SYSTEM_PROMPT = [
  '有一个 ask_question 工具可用于向用户提问：',
  '- 当你需要用户决策、确认方案或补充信息才能继续时，必须调用 ask_question，而不要只在普通文本里提问；调用会阻塞等待用户回答（无超时，用户可在任意时间回答；session 空闲回收后重新激活仍可回答）。',
  '- 单题：传入 question + options（2-6 个简短选项），可选 multiSelect 允许多选；工具会自动追加“自己输入”选项。',
  '- 问卷（questions 数组）：一次可提多个问题（每项 question + options + 可选 multiSelect/label），前端会分页导航让用户逐题作答后统一提交；需要连续收集多个决策时直接用 questions。',
  '- 用户可能取消（details.cancelled 或 answer 为 null），此时不要重试提问，转述结果即可。',
].join('\n');

/** 供 runtime/safetyTimeout 查询：某会话是否有待回答的 ask_question。 */
export function isAskQuestionPendingForSession(sessionId: string): boolean {
  for (const entry of pendingQuestions.values()) {
    if (entry.sessionId === sessionId) return true;
  }
  return false;
}

/** 列出某会话的全部待回答（用于刷新后重建表单）。 */
export function listPendingForSession(sessionId: string): AskQuestionPendingPayload[] {
  const result: AskQuestionPendingPayload[] = [];
  for (const entry of pendingQuestions.values()) {
    if (entry.sessionId !== sessionId) continue;
    const payload: AskQuestionPendingPayload = { questionId: entry.questionId, sessionId: entry.sessionId };
    const params = entry.params;
    if (Array.isArray(params.questions) && (params.questions as unknown[]).length > 0) {
      payload.questions = ((params.questions as unknown[]) ?? []).map((raw) => {
        const q = (raw ?? {}) as Record<string, unknown>;
        return {
          question: String(q.question ?? ''),
          options: Array.isArray(q.options) ? normalizeOptions((q.options as unknown[]).map(String)) : [],
          multiSelect: q.multiSelect === true,
          label: cleanLabel(q.label),
        } as AskQuestionInput;
      });
    } else {
      if (typeof params.question === 'string') payload.question = params.question;
      if (Array.isArray(params.options)) payload.options = normalizeOptions((params.options as unknown[]).map(String));
      payload.multiSelect = params.multiSelect === true;
      payload.label = cleanLabel(params.label);
    }
    result.push(payload);
  }
  return result;
}
