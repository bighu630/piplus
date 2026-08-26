import type { Hono } from 'hono';
import { createDb } from '@piplus/db/client';
import { projects, sessions } from '@piplus/db/schema';
import { eq } from 'drizzle-orm';
import { getDbPath } from '../../../db-context';
import { socketHub } from '../../../ws/server';
import { createEvent } from '../../../ws/protocol';
import { WS_EVENT_ASK_QUESTION_PENDING } from '@piplus/shared/ws';
import {
  answerQuestion,
  onAskQuestionPending,
  type AskQuestionPendingPayload,
} from '@piplus/domain';

let askQuestionPendingListenerRegistered = false;

/**
 * 把 domain 的 ask_question_pending 回调接到 socketHub：
 * ask_question 工具发起提问（createPending）时，向该会话的订阅连接推送
 * ask_question_pending WS 事件（带 scope.session_id，由 socketHub 按订阅过滤投递）。
 * 幂等注册：路由多次注册/测试重复导入不会重复订阅。
 */
function ensureAskQuestionPendingListener(): void {
  if (askQuestionPendingListenerRegistered) return;
  askQuestionPendingListenerRegistered = true;
  onAskQuestionPending((payload: AskQuestionPendingPayload) => {
    const sessionId = payload.sessionId;
    if (!sessionId) return;
    socketHub.sendToSession(
      sessionId,
      createEvent(
        WS_EVENT_ASK_QUESTION_PENDING,
        payload as unknown as Record<string, unknown>,
        { session_id: sessionId },
      ),
    );
  });
}

/** 回填答案的合法形状：string | null（单题选中/自己输入/取消），或任意数组（多选/问卷，由 domain 归一化）。 */
function isValidAnswerValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return true;
  return Array.isArray(value);
}

export function registerAskQuestionRoutes(app: Hono) {
  ensureAskQuestionPendingListener();

  /**
   * @swagger
   * /api/v1/sessions/{sessionId}/ask-answer:
   *   post:
   *     summary: 回填 ask_question 待回答问题
   *     tags: [Sessions]
   *     security:
   *       - bearerAuth: []
   *     description: |
   *       回填 ask_question 工具阻塞等待的问题（单题/多选/自己输入/问卷/取消）。
   *       body: { questionId, answer: string|string[]|null, answers?, wasCustom?, customAnswers?, cancelled? }。
   *       成功后 resolve 对应的 pending promise，模型继续执行。
   *     responses:
   *       200:
   *         description: 回填成功。
   *       400:
   *         description: body 非法（缺 questionId / 缺 answer 或 answers 字段 / answer 形状不对）。
   *       404:
   *         description: 会话不存在或无访问权限，或 questionId 无对应待回答问题。
   */
  app.post('/api/v1/sessions/:sessionId/ask-answer', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const userId = (c as any).get('userId') as string;
    const body = await c.req.json().catch(() => null);

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: { code: 'INVALID_BODY', message: 'Request body must be a JSON object' } }, 400);
    }

    const { questionId, answer, answers, wasCustom, customAnswers, cancelled } = body as {
      questionId?: unknown;
      answer?: unknown;
      answers?: unknown;
      wasCustom?: unknown;
      customAnswers?: unknown;
      cancelled?: unknown;
    };

    if (typeof questionId !== 'string' || questionId.length === 0) {
      return c.json({ error: { code: 'INVALID_BODY', message: 'questionId is required' } }, 400);
    }

    // 必须显式提供 answer 或 answers 字段。缺失时视为取消会误消费 pending
    // （pending 会以 cancelled:true 提前 resolve，模型拿到“用户取消”继续执行）——
    // 因此缺字段一律 400，不触碰 pending。answer: null 是合法取消，不受影响。
    if (answer === undefined && answers === undefined) {
      return c.json({ error: { code: 'INVALID_BODY', message: 'answer or answers is required' } }, 400);
    }

    // 会话存在性 + 归属校验（与其它 sessions 路由一致：无权限一律按 404 处理）
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!session) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const [project] = await db
      .select({ id: projects.id, createdBy: projects.createdBy })
      .from(projects)
      .where(eq(projects.id, session.projectId))
      .limit(1);
    if (!project || project.createdBy !== userId) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);
    }

    // 答案形状：单题走 answer（string | string[] | null），问卷走 answers 数组
    let answerValue: unknown = answer;
    if (answerValue === undefined && answers !== undefined) answerValue = answers;
    if (!isValidAnswerValue(answerValue)) {
      return c.json(
        { error: { code: 'INVALID_BODY', message: 'answer must be a string, an array, or null' } },
        400,
      );
    }

    const result = answerQuestion(questionId, answerValue, {
      wasCustom: typeof wasCustom === 'boolean' ? wasCustom : undefined,
      customAnswers: Array.isArray(customAnswers)
        ? customAnswers.filter((v): v is string => typeof v === 'string')
        : undefined,
      cancelled: typeof cancelled === 'boolean' ? cancelled : undefined,
    });

    if (!result.ok) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Pending question not found' } }, 404);
    }

    return c.json({ ok: true });
  });
}
