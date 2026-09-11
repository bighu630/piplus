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
  listAllPending,
  listPendingForSession,
  onAskQuestionPending,
  type AskQuestionPendingPayload,
} from '@piplus/domain';

let askQuestionPendingListenerRegistered = false;

/**
 * 按路径缓存的共享 db 实例：ask_question 每次提问都要查会话 owner，
 * 而 createDb 每次都新开 bun:sqlite 句柄且无法事后 close（同 ws/server.ts）。
 * 按路径缓存避免句柄累积，同时保证测试同进程切库时互不串库。
 */
const dbByPath = new Map<string, ReturnType<typeof createDb>>();
function getCachedDb() {
  const path = getDbPath();
  let db = dbByPath.get(path);
  if (!db) {
    db = createDb(`file:${path}`);
    dbByPath.set(path, db);
  }
  return db;
}

/**
 * 查会话创建者（= 该提问应通知的用户）。查不到/为空时返回 null，
 * 由调用方回退广播（auth 关闭的本地单用户场景）。
 * 用同步的 .get() 而非 await：监听器由 createPending 同步触发，同步查询不影响工具执行时序。
 */
function lookupSessionOwner(sessionId: string): string | null {
  try {
    const row = getCachedDb()
      .select({ createdBy: sessions.createdBy })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1)
      .get();
    const owner = row?.createdBy;
    return typeof owner === 'string' && owner.length > 0 ? owner : null;
  } catch (err) {
    console.error('[ask-question] lookup session owner failed:', err);
    return null;
  }
}

/**
 * 把 domain 的 ask_question_pending 回调接到 socketHub：
 * ask_question 工具发起提问（createPending）时，把事件推给**该会话 owner 的全部连接**。
 *
 * 为什么不用 `sendToSession`：它按 `scope.session_id` 做订阅过滤，而前端任何时刻
 * 只订阅当前激活会话（ws-provider 切会话会退订旧会话），用户切走后就收不到提问事件。
 * `sendToUser` 绕过订阅过滤但仍限定同一登录用户，兼顾「跨会话可达」与「不跨用户泄露」。
 * owner 缺失（auth 关闭的历史会话）时回退 broadcast，本地单用户场景等价且更稳。
 * 幂等注册：路由多次注册/测试重复导入不会重复订阅。
 */
function ensureAskQuestionPendingListener(): void {
  if (askQuestionPendingListenerRegistered) return;
  askQuestionPendingListenerRegistered = true;
  onAskQuestionPending((payload: AskQuestionPendingPayload) => {
    const sessionId = payload.sessionId;
    if (!sessionId) return;
    const message = createEvent(
      WS_EVENT_ASK_QUESTION_PENDING,
      payload as unknown as Record<string, unknown>,
      { session_id: sessionId },
    );
    const ownerId = lookupSessionOwner(sessionId);
    if (ownerId) {
      socketHub.sendToUser(ownerId, message);
    } else {
      socketHub.broadcast(message);
    }
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

  /**
   * @swagger
   * /api/v1/sessions/{sessionId}/ask-pending:
   *   get:
   *     summary: 查询当前会话的待回答 ask_question（用于刷新后重建表单）
   *     tags: [Sessions]
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: 返回待回答列表。
   *       404:
   *         description: 会话不存在或无访问权限。
   */
  app.get('/api/v1/sessions/:sessionId/ask-pending', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const userId = (c as any).get('userId') as string;

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

    const pending = listPendingForSession(sessionId);
    return c.json({ pending });
  });

  /**
   * @swagger
   * /api/v1/ask-pending:
   *   get:
   *     summary: 查询当前用户全部会话的待回答 ask_question（全局通知补偿）
   *     tags: [Sessions]
   *     security:
   *       - bearerAuth: []
   *     description: |
   *       跨会话返回当前用户所有待回答的 ask_question，仅含当前用户创建的会话。
   *       用于前端在挂载 / WS 重连 / 窗口重新聚焦时补齐断线期间错过的
   *       ask_question_pending 实时事件（该事件按用户定向推送，不依赖会话订阅）。
   *     responses:
   *       200:
   *         description: 返回待回答列表。
   */
  app.get('/api/v1/ask-pending', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const userId = (c as any).get('userId') as string;

    // 只返回归属当前用户的会话：pending 在 domain 里是全局内存表，
    // 必须在路由层按 sessions.createdBy 过滤，否则多用户下会泄露他人提问。
    const ownedSessions = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.createdBy, userId));
    const ownedIds = new Set(ownedSessions.map((row) => row.id));
    const pending = listAllPending().filter((p) => p.sessionId !== undefined && ownedIds.has(p.sessionId));
    return c.json({ pending });
  });
}
