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

function makeHeaders(token?: string) {
  return {
    'content-type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

  test('会话归属不匹配 → 404，pending 不被消费', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();
    // auth 关闭时 requireAuth 一律 userId='local-user'；会话 owner 为 user_seed → 归属不匹配
    const sessionId = await prepareSession(path, 'user_seed');

    const { questionId } = createPending(sessionId, { question: 'Q?', options: ['A', 'B'] });

    const res = await app.request(`/api/v1/sessions/${sessionId}/ask-answer`, {
      method: 'POST',
      headers: { ...makeHeaders(), 'x-user-id': 'user_seed' },
      body: JSON.stringify({ questionId, answer: 'A' }),
    });
    expect(res.status).toBe(404);
    // pending 未被消费，仍可用匹配身份回填
    expect(pendingQuestions.has(questionId)).toBe(true);
    answerQuestion(questionId, 'A');
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

  test('WS 推送：createPending 触发 ask_question_pending 事件到订阅连接', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp(); // 注册路由时挂载 ask_question_pending → socketHub 监听
    const sessionId = await prepareSession(path, 'local-user');

    // 挂一个订阅了该会话的假 socket
    const received: string[] = [];
    const fakeSocket = { send(data: string) { received.push(data); } };
    socketHub.attach(fakeSocket);
    socketHub.handleClientMessage(fakeSocket, {
      kind: 'client',
      type: 'subscribe_session',
      payload: { session_id: sessionId },
    });

    const { questionId } = createPending(sessionId, { question: 'Q?', options: ['A', 'B'] });

    const events = received
      .map((s) => JSON.parse(s) as { type: string; payload?: { questionId?: string } })
      .filter((e) => e.type === 'ask_question_pending');
    expect(events.length).toBe(1);
    expect(events[0].payload?.questionId).toBe(questionId);

    // 其它会话订阅的连接不应收到
    const otherReceived: string[] = [];
    const otherSocket = { send(data: string) { otherReceived.push(data); } };
    socketHub.attach(otherSocket);
    socketHub.handleClientMessage(otherSocket, {
      kind: 'client',
      type: 'subscribe_session',
      payload: { session_id: 'other-session' },
    });
    const { questionId: q2 } = createPending(sessionId, { question: 'Q2?', options: ['A'] });
    expect(otherReceived.some((s) => s.includes('ask_question_pending'))).toBe(false);

    // 清理挂起项，避免 5 分钟 timer 拖住测试进程
    socketHub.detach(fakeSocket);
    socketHub.detach(otherSocket);
    answerQuestion(questionId, null);
    answerQuestion(q2, null);
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
