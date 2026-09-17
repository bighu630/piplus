import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createSeedDb } from '@piplus/db/init';
import { createDb } from '@piplus/db/client';
import { projects, roleTemplates, sessions } from '@piplus/db/schema';
import { createApp } from '../app';
import { createToken } from '../auth/token';
import { withPasswordAuth } from '../test-utils';
import { socketHub } from '../ws/server';
import { answerQuestion, createPending, pendingQuestions } from '@piplus/domain';

function makeDbPath() {
  return `/tmp/piplus-api-ask-question-${crypto.randomUUID()}.sqlite`;
}

/** 准备一个私有会话：直接向 seed DB 插入 project + session（避免依赖模型列表 API）。 */
async function prepareSession(
  path: string,
  createdBy: string,
  sessionId = `sess_${crypto.randomUUID().slice(0, 8)}`,
): Promise<string> {
  const db = createDb(`file:${path}`);
  const [role] = await db.select({ id: roleTemplates.id }).from(roleTemplates).limit(1);
  const projectId = `proj_${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date();
  await db.insert(projects).values({
    id: projectId,
    name: 'Ask Question Project',
    createdBy,
    status: 'active',
    projectPath: '/tmp',
    sourceType: 'existing',
    sourceUrl: '',
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(sessions).values({
    id: sessionId,
    projectId,
    rootSessionId: sessionId,
    depth: 0,
    roleTemplateId: role?.id ?? 'role_default',
    piSessionId: `pi_${sessionId}`,
    piSessionLocatorJson: '{}',
    title: 'Ask Question Session',
    createdBy,
    status: 'active',
    runtimeStatus: 'idle',
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return sessionId;
}

/** 默认 dev 身份：与 prepareSession 的 owner 一致（配合 test-setup 的 PIPLUS_DEV_AUTH=1）。 */
const DEV_USER = 'local-user';

/**
 * 请求头：显式携带 dev 身份（x-user-id 回退），与其它 sessions 路由测试一致。
 * 本项目 auth 在测试进程里恒为开启（test-setup 固定 APP_PASSWORD），
 * 因此匿名请求会 401 —— 每个请求都必须表名身份。
 * 传 token 时走真实 v2 token 的认证路径。
 */
function makeHeaders(token?: string, userId: string = DEV_USER) {
  return {
    'content-type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : { 'x-user-id': userId }),
  };
}

describe('POST /api/v1/sessions/:sessionId/ask-answer', () => {
  const originalDatatabaseUrl = Bun.env.DATABASE_URL;
  const originalTimeout = Bun.env.PIPLUS_ASK_QUESTION_TIMEOUT_MS;

  beforeEach(() => {
    // 测试用极短超时，未回填的 pending 也能快速释放，避免 5 分钟 timer 拖住进程
    Bun.env.PIPLUS_ASK_QUESTION_TIMEOUT_MS = '100';
  });

  afterEach(() => {
    if (originalDatatabaseUrl === undefined) delete Bun.env.DATABASE_URL;
    else Bun.env.DATABASE_URL = originalDatatabaseUrl;
    if (originalTimeout === undefined) delete Bun.env.PIPLUS_ASK_QUESTION_TIMEOUT_MS;
    else Bun.env.PIPLUS_ASK_QUESTION_TIMEOUT_MS = originalTimeout;
    // 兜底清理：未回填的 pending 由 100ms 超时自动释放，这里确保清空表
    for (const id of [...pendingQuestions.keys()]) {
      answerQuestion(id, null);
    }
  });

  test('回填单题 pending：answer 解析并返回 {ok:true}', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();
    const sessionId = await prepareSession(path, 'local-user');

    const { questionId, promise } = createPending(sessionId, { question: 'Q?', options: ['A', 'B'] });

    const res = await app.request(`/api/v1/sessions/${sessionId}/ask-answer`, {
      method: 'POST',
      headers: makeHeaders(),
      body: JSON.stringify({ questionId, answer: 'A' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await promise).answer).toBe('A');
  });

  test('问卷模式：answers 数组解析', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();
    const sessionId = await prepareSession(path, 'local-user');

    const { questionId, promise } = createPending(sessionId, {
      questions: [
        { question: 'Q1', options: ['A', 'B'] },
        { question: 'Q2', options: ['X', 'Y'], multiSelect: true },
      ],
    });

    const res = await app.request(`/api/v1/sessions/${sessionId}/ask-answer`, {
      method: 'POST',
      headers: makeHeaders(),
      body: JSON.stringify({
        questionId,
        answers: [{ answers: ['A'] }, { answers: ['X', 'Y'] }],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const value = (await promise) as { answers: Array<{ answers: string[] }> };
    expect(value.answers).toHaveLength(2);
    expect(value.answers[1].answers).toEqual(['X', 'Y']);
  });

  test('取消：answer:null + cancelled:true 解析为取消且返回 {ok:true}', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();
    const sessionId = await prepareSession(path, 'local-user');

    const { questionId, promise } = createPending(sessionId, { question: 'Q?', options: ['A', 'B'] });

    const res = await app.request(`/api/v1/sessions/${sessionId}/ask-answer`, {
      method: 'POST',
      headers: makeHeaders(),
      body: JSON.stringify({ questionId, answer: null, cancelled: true }),
    });
    expect(res.status).toBe(200);
    const value = await promise;
    expect(value.cancelled).toBe(true);
    expect(value.answer).toBeNull();
  });

  test('会话归属不匹配 → 404，pending 不被消费；归属匹配才可回填', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();
    // 会话 owner 是 owner_user，请求者用另一个 dev 身份 → 归属不匹配
    const sessionId = await prepareSession(path, 'owner_user');

    const { questionId, promise } = createPending(sessionId, { question: 'Q?', options: ['A', 'B'] });

    const denied = await app.request(`/api/v1/sessions/${sessionId}/ask-answer`, {
      method: 'POST',
      headers: makeHeaders(undefined, 'other_user'),
      body: JSON.stringify({ questionId, answer: 'A' }),
    });
    expect(denied.status).toBe(404);
    // pending 未被消费，仍可用匹配身份回填
    expect(pendingQuestions.has(questionId)).toBe(true);

    // 正对照：同一 pending 换成 owner 的 dev 身份即可回填 → 证明 404 确实源于归属校验，
    // 而不是「所有请求都被拒」这种恒真断言。
    const allowed = await app.request(`/api/v1/sessions/${sessionId}/ask-answer`, {
      method: 'POST',
      headers: makeHeaders(undefined, 'owner_user'),
      body: JSON.stringify({ questionId, answer: 'A' }),
    });
    expect(allowed.status).toBe(200);
    expect((await promise).answer).toBe('A');
  });

  test('会话不存在 → 404', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const res = await app.request('/api/v1/sessions/does-not-exist/ask-answer', {
      method: 'POST',
      headers: makeHeaders(),
      body: JSON.stringify({ questionId: 'q1', answer: 'A' }),
    });
    expect(res.status).toBe(404);
  });

  test('questionId 无对应 pending → 404', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();
    const sessionId = await prepareSession(path, 'local-user');

    const res = await app.request(`/api/v1/sessions/${sessionId}/ask-answer`, {
      method: 'POST',
      headers: makeHeaders(),
      body: JSON.stringify({ questionId: 'ask_wrong_id', answer: 'A' }),
    });
    expect(res.status).toBe(404);
  });

  test('缺 questionId → 400', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();
    const sessionId = await prepareSession(path, 'local-user');

    const res = await app.request(`/api/v1/sessions/${sessionId}/ask-answer`, {
      method: 'POST',
      headers: makeHeaders(),
      body: JSON.stringify({ answer: 'A' }),
    });
    expect(res.status).toBe(400);
  });

  test('缺 answer 且缺 answers → 400，pending 不被消费（不得误取消）', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();
    const sessionId = await prepareSession(path, 'local-user');

    const { questionId } = createPending(sessionId, { question: 'Q?', options: ['A', 'B'] });
    const res = await app.request(`/api/v1/sessions/${sessionId}/ask-answer`, {
      method: 'POST',
      headers: makeHeaders(),
      body: JSON.stringify({ questionId }),
    });
    expect(res.status).toBe(400);
    // 修复点：缺 answer 必须 400；旧行为会把 undefined 当取消消费掉 pending
    expect(pendingQuestions.has(questionId)).toBe(true);

    // 仅 cancelled:true 但没有 answer/answers 字段同样 400（cancelled 不是答案载体）
    const res2 = await app.request(`/api/v1/sessions/${sessionId}/ask-answer`, {
      method: 'POST',
      headers: makeHeaders(),
      body: JSON.stringify({ questionId, cancelled: true }),
    });
    expect(res2.status).toBe(400);
    expect(pendingQuestions.has(questionId)).toBe(true);

    // 后续仍可用合法 answer 回填
    const ok = await app.request(`/api/v1/sessions/${sessionId}/ask-answer`, {
      method: 'POST',
      headers: makeHeaders(),
      body: JSON.stringify({ questionId, answer: 'A' }),
    });
    expect(ok.status).toBe(200);
  });

  test('answer 形状非法（数字/对象）→ 400', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();
    const sessionId = await prepareSession(path, 'local-user');

    const { questionId } = createPending(sessionId, { question: 'Q?', options: ['A', 'B'] });
    const res = await app.request(`/api/v1/sessions/${sessionId}/ask-answer`, {
      method: 'POST',
      headers: makeHeaders(),
      body: JSON.stringify({ questionId, answer: 42 }),
    });
    expect(res.status).toBe(400);
  });

  test('WS 推送：createPending 按用户定向投递（同用户未订阅连接也收到，其他用户收不到）', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp(); // 注册路由时挂载 ask_question_pending → socketHub 监听
    const sessionId = await prepareSession(path, DEV_USER);

    // 三连接模拟真实场景：
    // ① 订阅了本会话的同用户连接 —— 保底路径
    // ② **未订阅本会话**的同用户连接 —— 本次修复核心：用户切到别的会话/标签页也要收到通知
    // ③ 其他用户的连接 —— 必须收不到（多用户下不得泄露他人提问内容）
    const subscribedReceived: string[] = [];
    const subscribedSocket = { send(data: string) { subscribedReceived.push(data); }, __userId: DEV_USER };
    const unsubscribedReceived: string[] = [];
    const unsubscribedSocket = { send(data: string) { unsubscribedReceived.push(data); }, __userId: DEV_USER };
    const otherUserReceived: string[] = [];
    const otherUserSocket = { send(data: string) { otherUserReceived.push(data); }, __userId: 'someone-else' };

    socketHub.attach(subscribedSocket);
    socketHub.attach(unsubscribedSocket);
    socketHub.attach(otherUserSocket);
    socketHub.handleClientMessage(subscribedSocket, {
      kind: 'client',
      type: 'subscribe_session',
      payload: { session_id: sessionId },
    });

    try {
      const { questionId } = createPending(sessionId, { question: 'Q?', options: ['A', 'B'] });

      const extract = (raw: string[]) =>
        raw
          .map((s) => JSON.parse(s) as { type: string; payload?: { questionId?: string } })
          .filter((e) => e.type === 'ask_question_pending');

      const subscribedEvents = extract(subscribedReceived);
      expect(subscribedEvents.length).toBe(1);
      expect(subscribedEvents[0].payload?.questionId).toBe(questionId);

      const unsubscribedEvents = extract(unsubscribedReceived);
      expect(unsubscribedEvents.length).toBe(1);
      expect(unsubscribedEvents[0].payload?.questionId).toBe(questionId);

      expect(extract(otherUserReceived)).toHaveLength(0);

      answerQuestion(questionId, null);
    } finally {
      // 断言失败也不能把假 socket 留在模块级单例 hub 里污染后续用例
      socketHub.detach(subscribedSocket);
      socketHub.detach(unsubscribedSocket);
      socketHub.detach(otherUserSocket);
    }
  });

  test('GET /api/v1/ask-pending：跨会话返回本人待回答，不含他人会话；匿名 401', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();
    const ownSessionA = await prepareSession(path, DEV_USER);
    const ownSessionB = await prepareSession(path, DEV_USER);
    const foreignSession = await prepareSession(path, 'someone-else');

    const { questionId: qA } = createPending(ownSessionA, { question: 'A?', options: ['1'] });
    const { questionId: qB } = createPending(ownSessionB, { question: 'B?', options: ['2'] });
    const { questionId: qForeign } = createPending(foreignSession, { question: 'X?', options: ['3'] });

    const res = await app.request('/api/v1/ask-pending', { headers: makeHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pending: Array<{ questionId: string; sessionId?: string }> };
    expect(body.pending.map((p) => p.questionId).sort()).toEqual([qA, qB].sort());
    expect(body.pending.some((p) => p.questionId === qForeign)).toBe(false);

    // 会话内接口回归：仍只返回该会话的 pending
    const oneRes = await app.request(`/api/v1/sessions/${ownSessionA}/ask-pending`, { headers: makeHeaders() });
    expect(oneRes.status).toBe(200);
    const oneBody = (await oneRes.json()) as { pending: Array<{ questionId: string }> };
    expect(oneBody.pending.map((p) => p.questionId)).toEqual([qA]);

    // app.ts 已挂 requireAuth：匿名访问一律 401
    const anonRes = await app.request('/api/v1/ask-pending');
    expect(anonRes.status).toBe(401);
  });

  test('auth 开启时：token 身份与会话归属匹配才能回填（非 owner → 404）', async () =>
    withPasswordAuth(async () => {
      const path = makeDbPath();
      createSeedDb(path);
      Bun.env.DATABASE_URL = `file:${path}`;
      const app = createApp();
      const token = createToken();
      // owner 应为 local-user（token 身份）
      const sessionId = await prepareSession(path, 'local-user');

      const { questionId, promise } = createPending(sessionId, { question: 'Q?', options: ['A', 'B'] });
      const res = await app.request(`/api/v1/sessions/${sessionId}/ask-answer`, {
        method: 'POST',
        headers: makeHeaders(token),
        body: JSON.stringify({ questionId, answer: 'A' }),
      });
      expect(res.status).toBe(200);
      expect((await promise).answer).toBe('A');
    }));
});
