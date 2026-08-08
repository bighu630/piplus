import { createSeedDb } from '@piplus/db/init';
import { describe, expect, test } from 'bun:test';
import { and, asc, eq } from 'drizzle-orm';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createDb } from '@piplus/db/client';
import { messages, messageInjections, sessions } from '@piplus/db/schema';
import { createPiClient } from '@piplus/pi-client';
import { createApp } from '../app';
import { parseModelRef, buildVisionMergedContent, describeImagesWithFallback, stripMergedPromptPrefix } from './sessions';

const imageCapableModelPromise = createPiClient().listAvailableModels().then((models) => models.at(-1) ?? models[0]);

function makeDbPath() {
  return `/tmp/piplus-api-session-${crypto.randomUUID()}.sqlite`;
}

async function createImageCapableSession(app: ReturnType<typeof createApp>, name: string) {
  const target = await imageCapableModelPromise;
  expect(target).toBeTruthy();

  const projectRes = await app.request('/api/v1/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
    body: JSON.stringify({
      name,
      mode: 'existing',
      path: '/tmp',
      model: { provider: target.provider, id: target.id },
    }),
  });
  expect(projectRes.status).toBe(201);
  return projectRes.json();
}

describe('session routes', () => {
  test('chat message history requires authentication', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Private Session Project', mode: 'existing', path: '/tmp' }),
    });
    const projectBody = await projectRes.json();

    const historyRes = await app.request(`/api/v1/sessions/${projectBody.sessionId}/chat/messages?limit=2&cursor=0`);
    expect(historyRes.status).toBe(401);
  });

  test('message history returns user and assistant messages from pi session file', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const projectBody = await createImageCapableSession(app, 'LLM History Project');
    const sessionId = projectBody.sessionId as string;

    const sendRes = await app.request(`/api/v1/sessions/${sessionId}/chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({
        content: 'hello from api test',
        attachments: [{
          type: 'image',
          mime_type: 'image/png',
          data_base64: Buffer.from('fake-image').toString('base64'),
          filename: 'test.png',
        }],
      }),
    });
    expect(sendRes.status).toBe(202);

    const pageRes = await app.request(`/api/v1/sessions/${sessionId}/chat/messages?limit=10&cursor=0`, {
      headers: { 'x-user-id': 'user_seed' },
    });
    expect(pageRes.status).toBe(200);
    const page = await pageRes.json();
    expect(Array.isArray(page.messages)).toBe(true);
    for (const message of page.messages) {
      expect(message).toHaveProperty('content_text');
      expect(message).toHaveProperty('content_blocks');
    }

    const db = createDb(`file:${path}`);
    const rows = await db.select().from(messages).where(eq(messages.sessionId, sessionId));
    const userMessage = rows.find((row) => row.role === 'user' && row.contentText === 'hello from api test');
    expect(userMessage?.contentBlocksJson).toContain('hello from api test');
    expect(userMessage?.contentBlocksJson).toContain('image/png');
    expect(userMessage?.contentBlocksJson).toContain('test.png');
  });

  test('chat messages accept image-only content and persist structured blocks', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const projectBody = await createImageCapableSession(app, 'Image Only Project');
    const sessionId = projectBody.sessionId as string;

    const sendRes = await app.request(`/api/v1/sessions/${sessionId}/chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({
        content: '',
        attachments: [{
          type: 'image',
          mime_type: 'image/png',
          data_base64: Buffer.from('image-only').toString('base64'),
          filename: 'only.png',
        }],
      }),
    });
    expect(sendRes.status).toBe(202);

    const db = createDb(`file:${path}`);
    const rows = await db.select().from(messages).where(eq(messages.sessionId, sessionId));
    const userMessage = rows.find((row) => row.role === 'user');
    expect(userMessage?.contentText).toBe('');
    expect(userMessage?.contentBlocksJson).toContain('image');
  });

  test('chat messages reject more than four image attachments', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Attachment Limit Project', mode: 'existing', path: '/tmp' }),
    });
    const projectBody = await projectRes.json();
    const sessionId = projectBody.sessionId as string;

    const attachments = Array.from({ length: 5 }, (_, index) => ({
      type: 'image',
      mime_type: 'image/png',
      data_base64: Buffer.from(`img-${index}`).toString('base64'),
      filename: `img-${index}.png`,
    }));

    const sendRes = await app.request(`/api/v1/sessions/${sessionId}/chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ content: 'too many', attachments }),
    });
    expect(sendRes.status).toBe(400);
    expect(await sendRes.json()).toMatchObject({ error: { code: 'TOO_MANY_ATTACHMENTS' } });
  });

  test('chat messages reject images for models without image support', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Text Only Model Project', mode: 'existing', path: '/tmp' }),
    });
    const projectBody = await projectRes.json();
    const sessionId = projectBody.sessionId as string;

    // Switch to a text-only model (no image support).
    // The default model may report image support in newer SDK versions.
    const modelsRes = await app.request('/api/v1/models', {
      headers: { 'x-user-id': 'user_seed' },
    });
    const modelsBody = await modelsRes.json();
    const textOnlyModel = (modelsBody.models as Array<{ provider: string; id: string; input?: string[] }>).find(
      (m) => Array.isArray(m.input) && !m.input.includes('image'),
    );
    if (textOnlyModel) {
      await app.request(`/api/v1/sessions/${sessionId}/model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
        body: JSON.stringify({ provider: textOnlyModel.provider, id: textOnlyModel.id }),
      });
    }

    const sendRes = await app.request(`/api/v1/sessions/${sessionId}/chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({
        content: 'describe this',
        attachments: [{
          type: 'image',
          mime_type: 'image/png',
          data_base64: Buffer.from('blocked').toString('base64'),
          filename: 'blocked.png',
        }],
      }),
    });
    expect(sendRes.status).toBe(400);
    expect(await sendRes.json()).toMatchObject({ error: { code: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } });
  });

  test('vision relay: both vision models fail → 400 + error history message, user message not stored', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Vision Relay Project', mode: 'existing', path: '/tmp' }),
    });
    const projectBody = await projectRes.json();
    const sessionId = projectBody.sessionId as string;

    // 切换到纯文本模型（无图片支持）
    const modelsRes = await app.request('/api/v1/models', { headers: { 'x-user-id': 'user_seed' } });
    const modelsBody = await modelsRes.json();
    const textOnlyModel = (modelsBody.models as Array<{ provider: string; id: string; input?: string[] }>).find(
      (m) => Array.isArray(m.input) && !m.input.includes('image'),
    );
    if (textOnlyModel) {
      await app.request(`/api/v1/sessions/${sessionId}/model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
        body: JSON.stringify({ provider: textOnlyModel.provider, id: textOnlyModel.id }),
      });
    }

    // 开启 vision relay，主模型指向不存在的模型（保证快速失败，无需真实 API key）
    const settingsRes = await app.request('/api/v1/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({
        vision_enabled: 'true',
        vision_model: 'nonexistent-vision/nonexistent-model',
        vision_fallback_model: 'nonexistent-vision/fallback-model',
      }),
    });
    expect(settingsRes.status).toBe(200);

    const sendRes = await app.request(`/api/v1/sessions/${sessionId}/chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({
        content: 'describe this',
        attachments: [{
          type: 'image',
          mime_type: 'image/png',
          data_base64: Buffer.from('blocked').toString('base64'),
          filename: 'blocked.png',
        }],
      }),
    });
    expect(sendRes.status).toBe(400);
    expect(await sendRes.json()).toMatchObject({ error: { code: 'VISION_DESCRIPTION_FAILED' } });

    // 用户消息不落库
    const db = createDb(`file:${path}`);
    const userRows = await db.select().from(messages).where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'user')));
    expect(userRows).toHaveLength(0);

    // error 消息落注入表（message_injections）
    const injectionRows = await db.select().from(messageInjections)
      .where(and(eq(messageInjections.sessionId, sessionId), eq(messageInjections.messageKind, 'error')));
    expect(injectionRows).toHaveLength(1);
    expect(injectionRows[0].role).toBe('assistant');
    expect(injectionRows[0].contentText).toContain('图片识别失败');

    // error 历史消息可见
    const histRes = await app.request(`/api/v1/sessions/${sessionId}/chat/messages?limit=50&cursor=0`, {
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
    });
    expect(histRes.status).toBe(200);
    const histBody = await histRes.json();
    const errorMsg = (histBody.messages as Array<{ message_kind: string; content_text: string }>).find((m) => m.message_kind === 'error');
    expect(errorMsg).toBeTruthy();
    expect(errorMsg!.content_text).toContain('图片识别失败');
  });

  test('vision relay: successful description merges into content sent to text model and session stays idle', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;

    const realClient = createPiClient();
    let visionCalls = 0;
    const captured: { content: string | null } = { content: null };
    const stubClient = new Proxy(realClient, {
      get(target, prop, receiver) {
        if (prop === 'completeModel') {
          return async () => {
            visionCalls += 1;
            return { text: '这是一张报错截图', stopReason: 'stop' };
          };
        }
        if (prop === 'sendMessage') {
          return async (_sessionId: string, content: string) => {
            captured.content = content;
            throw new Error('no_api_key_in_test');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const app = createApp({ piClient: stubClient });

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Vision Relay Success', mode: 'existing', path: '/tmp' }),
    });
    const projectBody = await projectRes.json();
    const sessionId = projectBody.sessionId as string;

    // 切换到纯文本模型（无图片支持）
    const modelsRes = await app.request('/api/v1/models', { headers: { 'x-user-id': 'user_seed' } });
    const modelsBody = await modelsRes.json();
    const textOnlyModel = (modelsBody.models as Array<{ provider: string; id: string; input?: string[] }>).find(
      (m) => Array.isArray(m.input) && !m.input.includes('image'),
    );
    if (textOnlyModel) {
      await app.request(`/api/v1/sessions/${sessionId}/model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
        body: JSON.stringify({ provider: textOnlyModel.provider, id: textOnlyModel.id }),
      });
    }

    // 开启 vision relay，主/备模型用 stub 拦截（无需真实 API key）
    const settingsRes = await app.request('/api/v1/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({
        vision_enabled: 'true',
        vision_model: 'fake-vision/fake-model',
        vision_fallback_model: 'fake-vision/fallback-model',
      }),
    });
    expect(settingsRes.status).toBe(200);

    const sendRes = await app.request(`/api/v1/sessions/${sessionId}/chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({
        content: 'describe this',
        attachments: [{
          type: 'image',
          mime_type: 'image/png',
          data_base64: Buffer.from('blocked').toString('base64'),
          filename: 'blocked.png',
        }],
      }),
    });
    // 不断言具体状态码：sendMessage stub 抛错在 startSessionRun 的后台 cleanup 中发生（void attemptSend），
    // 响应本身是 202；本测试关注的是 vision 链路与状态恢复。
    void sendRes;
    expect(visionCalls).toBe(1); // 只调了一次主模型（无回退）
    expect(captured.content).toContain('[图片内容识别]');
    expect(captured.content).toContain('这是一张报错截图');
    expect(captured.content).toContain('describe this'); // 用户原文本保留
    expect(captured.content).not.toContain(Buffer.from('blocked').toString('base64')); // 图片 base64 不发给文本模型

    // 会话状态未被卡死（回归点：修复前 startSessionRun 重新读库读到 running → session_busy → 永久卡死）
    // sendMessage 抛错后由 startSessionRun 的 cleanup 异步恢复 idle，轮询等待
    const db = createDb(`file:${path}`);
    let sessionRow: { runtimeStatus: string } | undefined;
    for (let i = 0; i < 200; i++) {
      [sessionRow] = await db.select({ runtimeStatus: sessions.runtimeStatus }).from(sessions).where(eq(sessions.id, sessionId));
      if (sessionRow?.runtimeStatus === 'idle') break;
      await Bun.sleep(10);
    }
    expect(sessionRow?.runtimeStatus).toBe('idle');

    // vision relay 成功：用户消息落注入表（messageKind='vision_relay'），messages 表无该用户消息行
    const injectionRows = await db.select().from(messageInjections)
      .where(and(eq(messageInjections.sessionId, sessionId), eq(messageInjections.messageKind, 'vision_relay')));
    expect(injectionRows).toHaveLength(1);
    expect(injectionRows[0].role).toBe('user');
    expect(injectionRows[0].contentText).toBe('describe this');
    expect(injectionRows[0].contentBlocksJson).toContain('image/png');
    expect(injectionRows[0].contentBlocksJson).toContain('blocked.png');
    const userRows = await db.select().from(messages).where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'user')));
    expect(userRows).toHaveLength(0);
  });

  test('vision relay: history shows original user text and image attachments instead of merged description', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;

    const realClient = createPiClient();
    const capturedRaw: { messages: Array<{ role: string; text: string }> | null } = { messages: null };
    const stubClient = new Proxy(realClient, {
      get(target, prop, receiver) {
        if (prop === 'completeModel') {
          return async () => ({ text: '这是一张报错截图', stopReason: 'stop' });
        }
        if (prop === 'sendMessage') {
          // 成功返回（stub 不写 pi 历史）：随后测试手动注入合并文本消息模拟真实 pi 会话文件
          return async (_sessionId: string, _content: string) => ({ sessionId: _sessionId, runId: 'stub-run' });
        }
        if (prop === 'getHistory') {
          // 记录 pi 会话文件里的原始历史（未经过替换），用于证明替换确实发生
          return async (...args: Parameters<typeof target.getHistory>) => {
            const result = await target.getHistory(...args);
            capturedRaw.messages = result.messages.map((m) => ({ role: m.role, text: m.text }));
            return result;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const app = createApp({ piClient: stubClient });

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Vision Relay History', mode: 'existing', path: '/tmp' }),
    });
    const projectBody = await projectRes.json();
    const sessionId = projectBody.sessionId as string;

    // 切换到纯文本模型
    const modelsRes = await app.request('/api/v1/models', { headers: { 'x-user-id': 'user_seed' } });
    const modelsBody = await modelsRes.json();
    const textOnlyModel = (modelsBody.models as Array<{ provider: string; id: string; input?: string[] }>).find(
      (m) => Array.isArray(m.input) && !m.input.includes('image'),
    );
    if (textOnlyModel) {
      await app.request(`/api/v1/sessions/${sessionId}/model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
        body: JSON.stringify({ provider: textOnlyModel.provider, id: textOnlyModel.id }),
      });
    }

    await app.request('/api/v1/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ vision_enabled: 'true', vision_model: 'fake-vision/fake-model' }),
    });

    const sendRes = await app.request(`/api/v1/sessions/${sessionId}/chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({
        content: 'describe this',
        attachments: [{
          type: 'image',
          mime_type: 'image/png',
          data_base64: Buffer.from('blocked').toString('base64'),
          filename: 'blocked.png',
        }],
      }),
    });
    expect(sendRes.status).toBe(202);

    // 模拟真实 pi 会话文件：往文件追加一条 vision relay 合并文本用户消息（时间戳贴近 DB 落库时间）
    const db = createDb(`file:${path}`);
    const [sessionRow] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    const locator = JSON.parse(sessionRow.piSessionLocatorJson) as { sessionFile: string };
    const manager = SessionManager.open(locator.sessionFile);
    manager.appendMessage({
      role: 'user',
      content: 'describe this\n\n[图片内容识别]\n这是一张报错截图',
      timestamp: Date.now(),
    });

    // 轮询 GET 历史直到用户消息可见（pi 历史已包含注入消息）
    type HistoryMessage = {
      role: string;
      content_text: string;
      content_blocks: Array<{ type: string; data_base64?: string }> | null;
    };
    let histBody: { messages: HistoryMessage[] } | null = null;
    for (let i = 0; i < 200; i++) {
      const histRes = await app.request(`/api/v1/sessions/${sessionId}/chat/messages?limit=50&cursor=0`, {
        headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      });
      const body = (await histRes.json()) as { messages: HistoryMessage[] };
      histBody = body;
      if (body.messages.some((m) => m.role === 'user' && m.content_text.includes('describe this'))) break;
      await Bun.sleep(10);
    }

    // pi 原始历史确实包含合并文本消息（替换前提成立）
    expect(capturedRaw.messages?.some((m) => m.role === 'user' && m.text.includes('[图片内容识别]')) ?? false).toBe(true);

    // GET 响应中该用户消息被替换为原始文本 + 图片附件
    const userMsg = histBody!.messages.find((m) => m.role === 'user' && m.content_text.includes('describe this'));
    expect(userMsg).toBeTruthy();
    expect(userMsg!.content_text).not.toContain('[图片内容识别]');
    const imageBlock = userMsg!.content_blocks?.find((b) => b.type === 'image');
    expect(imageBlock).toBeTruthy();
    expect(imageBlock!.data_base64).toBe(Buffer.from('blocked').toString('base64'));
  });

  test('vision relay: concurrent POST while describe in flight gets 409', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;

    let releaseDescribe: (() => void) | null = null;
    const describeGate = new Promise<void>((resolve) => { releaseDescribe = resolve; });
    const realClient = createPiClient();
    let visionCalls = 0;
    const stubClient = new Proxy(realClient, {
      get(target, prop, receiver) {
        if (prop === 'completeModel') {
          return async () => {
            visionCalls += 1;
            await describeGate;
            return { text: '描述', stopReason: 'stop' };
          };
        }
        if (prop === 'sendMessage') {
          return async () => { throw new Error('no_api_key_in_test'); };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const app = createApp({ piClient: stubClient });

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Vision Relay Concurrent', mode: 'existing', path: '/tmp' }),
    });
    const projectBody = await projectRes.json();
    const sessionId = projectBody.sessionId as string;

    // 切换到纯文本模型（同测试 A）
    const modelsRes = await app.request('/api/v1/models', { headers: { 'x-user-id': 'user_seed' } });
    const modelsBody = await modelsRes.json();
    const textOnlyModel = (modelsBody.models as Array<{ provider: string; id: string; input?: string[] }>).find(
      (m) => Array.isArray(m.input) && !m.input.includes('image'),
    );
    if (textOnlyModel) {
      await app.request(`/api/v1/sessions/${sessionId}/model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
        body: JSON.stringify({ provider: textOnlyModel.provider, id: textOnlyModel.id }),
      });
    }

    const settingsRes = await app.request('/api/v1/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({
        vision_enabled: 'true',
        vision_model: 'fake-vision/fake-model',
        vision_fallback_model: 'fake-vision/fallback-model',
      }),
    });
    expect(settingsRes.status).toBe(200);

    const imageMessage = () => ({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({
        content: 'describe this',
        attachments: [{
          type: 'image',
          mime_type: 'image/png',
          data_base64: Buffer.from('blocked').toString('base64'),
          filename: 'blocked.png',
        }],
      }),
    });

    // 第一个 POST 进入 describe 挂起（原子认领已完成，会话 running）
    const firstPromise = app.request(`/api/v1/sessions/${sessionId}/chat/messages`, imageMessage());
    // 轮询等待描述请求已发出：visionCalls===1 保证 claim 已完成（claim 在 describe 之前）
    for (let i = 0; i < 100 && visionCalls === 0; i++) await Bun.sleep(10);
    expect(visionCalls).toBe(1);

    // 第二个 POST 读到 running → 409
    const secondRes = await app.request(`/api/v1/sessions/${sessionId}/chat/messages`, imageMessage());
    expect(secondRes.status).toBe(409);

    // 放行第一个 POST，等待其完成（成功路径由 startSessionRun 管理状态）
    releaseDescribe!();
    await firstPromise;
  });

  test('vision relay: enabled but no vision model keeps MODEL_DOES_NOT_SUPPORT_IMAGES', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Vision Relay Unconfigured', mode: 'existing', path: '/tmp' }),
    });
    const projectBody = await projectRes.json();
    const sessionId = projectBody.sessionId as string;

    // 切换到纯文本模型
    const modelsRes = await app.request('/api/v1/models', { headers: { 'x-user-id': 'user_seed' } });
    const modelsBody = await modelsRes.json();
    const textOnlyModel = (modelsBody.models as Array<{ provider: string; id: string; input?: string[] }>).find(
      (m) => Array.isArray(m.input) && !m.input.includes('image'),
    );
    if (textOnlyModel) {
      await app.request(`/api/v1/sessions/${sessionId}/model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
        body: JSON.stringify({ provider: textOnlyModel.provider, id: textOnlyModel.id }),
      });
    }

    // 开启功能但不配置模型 → 保持原拒绝行为
    const settingsRes = await app.request('/api/v1/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ vision_enabled: 'true' }),
    });
    expect(settingsRes.status).toBe(200);

    const sendRes = await app.request(`/api/v1/sessions/${sessionId}/chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({
        content: 'describe this',
        attachments: [{
          type: 'image',
          mime_type: 'image/png',
          data_base64: Buffer.from('blocked').toString('base64'),
          filename: 'blocked.png',
        }],
      }),
    });
    expect(sendRes.status).toBe(400);
    expect(await sendRes.json()).toMatchObject({ error: { code: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } });
  });

  test('slash command messages are stored in message_injections', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Slash Command Project', mode: 'existing', path: '/tmp' }),
    });
    expect(projectRes.status).toBe(201);
    const projectBody = await projectRes.json();
    const sessionId = projectBody.sessionId as string;

    // /help 是内置 slash command，executeCommand 无需运行时会话即可执行
    const sendRes = await app.request(`/api/v1/sessions/${sessionId}/chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ content: '/help' }),
    });
    expect(sendRes.status).toBe(202);

    // 注入表含 role=user 与 role=assistant 两条 slash_command 行
    const db = createDb(`file:${path}`);
    const injectionRows = await db.select().from(messageInjections)
      .where(and(eq(messageInjections.sessionId, sessionId), eq(messageInjections.messageKind, 'slash_command')))
      .orderBy(asc(messageInjections.createdAt));
    expect(injectionRows).toHaveLength(2);
    expect(injectionRows[0].role).toBe('user');
    expect(injectionRows[0].contentText).toBe('/help');
    expect(injectionRows[1].role).toBe('assistant');
    expect(injectionRows[1].contentText).toContain('可用命令');

    // messages 表无新行（slash_command 不再落 messages 表）
    const msgRows = await db.select().from(messages).where(eq(messages.sessionId, sessionId));
    expect(msgRows).toHaveLength(0);

    // GET 历史中可见两条 slash_command 消息（双读合并：注入表新数据）
    const histRes = await app.request(`/api/v1/sessions/${sessionId}/chat/messages?limit=50&cursor=0`, {
      headers: { 'x-user-id': 'user_seed' },
    });
    expect(histRes.status).toBe(200);
    const histBody = await histRes.json();
    const slashMessages = (histBody.messages as Array<{ message_kind: string; role: string; content_text: string }>)
      .filter((m) => m.message_kind === 'slash_command');
    expect(slashMessages).toHaveLength(2);
    const slashUser = slashMessages.find((m) => m.role === 'user');
    expect(slashUser?.content_text).toBe('/help');
    const slashAssistant = slashMessages.find((m) => m.role === 'assistant');
    expect(slashAssistant?.content_text).toContain('可用命令');
  });

  test('create top-level session inherits project planner model', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();
    const models = await createPiClient().listAvailableModels();
    const target = models.at(-1) ?? models[0];
    expect(target).toBeTruthy();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({
        name: 'Inherited Session Project',
        mode: 'existing',
        path: '/tmp',
        model: { provider: target.provider, id: target.id },
      }),
    });
    const projectBody = await projectRes.json();

    const createSessionRes = await app.request(`/api/v1/projects/${projectBody.projectId}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({}),
    });
    expect(createSessionRes.status).toBe(201);
    const createdSession = await createSessionRes.json();

    const infoRes = await app.request(`/api/v1/sessions/${createdSession.session_id}/info`, {
      headers: { 'x-user-id': 'user_seed' },
    });
    expect(infoRes.status).toBe(200);
    const info = await infoRes.json();
    expect(info.session.current_model).toMatchObject({
      provider: target.provider,
      id: target.id,
    });

    const db = createDb(`file:${path}`);
    const [createdRow] = await db.select().from(sessions).where(eq(sessions.id, createdSession.session_id)).limit(1);
    expect(createdRow?.currentModelProvider).toBe(target.provider);
    expect(createdRow?.currentModelId).toBe(target.id);
  });

  test('set session model persists DB mirror and is returned by session info', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Model Mirror Project', mode: 'existing', path: '/tmp' }),
    });
    const projectBody = await projectRes.json();
    const sessionId = projectBody.sessionId as string;

    const modelsRes = await app.request('/api/v1/models', {
      headers: { 'x-user-id': 'user_seed' },
    });
    expect(modelsRes.status).toBe(200);
    const modelsBody = await modelsRes.json();
    const target = modelsBody.models.at(-1) ?? modelsBody.models[0];
    expect(target).toBeTruthy();

    const setModelRes = await app.request(`/api/v1/sessions/${sessionId}/model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ provider: target.provider, id: target.id }),
    });
    expect(setModelRes.status).toBe(200);

    const infoRes = await app.request(`/api/v1/sessions/${sessionId}/info`, {
      headers: { 'x-user-id': 'user_seed' },
    });
    expect(infoRes.status).toBe(200);
    const info = await infoRes.json();
    expect(info.session.current_model).toMatchObject({
      provider: target.provider,
      id: target.id,
    });
  });

  test('patch session title updates the title', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Title Project', mode: 'existing', path: '/tmp' }),
    });
    const projectBody = await projectRes.json();

    const patchRes = await app.request(`/api/v1/sessions/${projectBody.sessionId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ title: 'Renamed Session' }),
    });
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json();
    expect(patchBody.title).toBe('Renamed Session');
    expect(patchBody.title_source).toBe('user');

    const infoRes = await app.request(`/api/v1/sessions/${projectBody.sessionId}/info`, {
      headers: { 'x-user-id': 'user_seed' },
    });
    const info = await infoRes.json();
    expect(info.session.title).toBe('Renamed Session');
  });

  test('patch session title requires authentication', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const res = await app.request('/api/v1/sessions/session_nonexistent', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'No Auth' }),
    });
    expect(res.status).toBe(401);
  });

  // ─── Stop session / error resilience ──────────────────────────────────────

  test('POST /api/v1/sessions/:id/stop returns 202 for fresh session (no runtime)', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'StopTest Project', mode: 'existing', path: '/tmp' }),
    });
    const projectBody = await projectRes.json();
    const sessionId = projectBody.sessionId as string;

    // Stop a session that was just created and has NO runtime restored.
    // The handler must return 202 immediately — no hanging even when agentSession is absent.
    const stopRes = await app.request(`/api/v1/sessions/${sessionId}/stop`, {
      method: 'POST',
      headers: { 'x-user-id': 'user_seed' },
    });
    expect(stopRes.status).toBe(202);
    const body = await stopRes.json();
    expect(body).toMatchObject({ session_id: sessionId, status: 'stopping' });
  });

  test('POST /api/v1/sessions/:id/stop returns 202 after sending a message (runtime active)', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'StopTest Active Project', mode: 'existing', path: '/tmp' }),
    });
    const projectBody = await projectRes.json();
    const sessionId = projectBody.sessionId as string;

    // Send a message to activate the runtime
    const sendRes = await app.request(`/api/v1/sessions/${sessionId}/chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ content: 'test message for stop' }),
    });
    expect(sendRes.status).toBe(202);

    // Stop while runtime may still be active — must return 202 promptly
    const stopRes = await app.request(`/api/v1/sessions/${sessionId}/stop`, {
      method: 'POST',
      headers: { 'x-user-id': 'user_seed' },
    });
    expect(stopRes.status).toBe(202);
    const body = await stopRes.json();
    expect(body).toMatchObject({ session_id: sessionId, status: 'stopping' });
  });

  test('POST /api/v1/sessions/:id/stop can be called multiple times (idempotent)', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'StopTest Idempotent Project', mode: 'existing', path: '/tmp' }),
    });
    const projectBody = await projectRes.json();
    const sessionId = projectBody.sessionId as string;

    // Stop twice — second call must also return 202
    const r1 = await app.request(`/api/v1/sessions/${sessionId}/stop`, {
      method: 'POST',
      headers: { 'x-user-id': 'user_seed' },
    });
    expect(r1.status).toBe(202);

    const r2 = await app.request(`/api/v1/sessions/${sessionId}/stop`, {
      method: 'POST',
      headers: { 'x-user-id': 'user_seed' },
    });
    expect(r2.status).toBe(202);
  });

  test('POST /api/v1/sessions/:id/stop requires authentication', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const res = await app.request('/api/v1/sessions/session_nonexistent/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(401);
  });

  test('POST /api/v1/sessions/:id/stop returns 404 for nonexistent session', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const res = await app.request('/api/v1/sessions/session_doesnotexist/stop', {
      method: 'POST',
      headers: { 'x-user-id': 'user_seed' },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});

describe('stripMergedPromptPrefix', () => {
  test('strips merged role prompt prefix from planner first message', () => {
    const merged = 'You are a planner...\n\n请尊重用户的语言习惯，现在用户说：\n\n帮我看看这个项目';
    expect(stripMergedPromptPrefix(merged)).toBe('帮我看看这个项目');
  });

  test('returns text unchanged when no separator present', () => {
    expect(stripMergedPromptPrefix('普通消息')).toBe('普通消息');
  });

  test('keeps content after the last separator occurrence', () => {
    const text = 'a\n\n请尊重用户的语言习惯，现在用户说：\n\nb\n\n请尊重用户的语言习惯，现在用户说：\n\nc';
    expect(stripMergedPromptPrefix(text)).toBe('c');
  });
});

describe('parseModelRef', () => {
  test("parses 'provider/id'", () => {
    expect(parseModelRef('a/b')).toEqual({ provider: 'a', id: 'b' });
  });

  test("keeps the remainder as id for 'provider/id/sub'", () => {
    expect(parseModelRef('a/b/c')).toEqual({ provider: 'a', id: 'b/c' });
  });

  test('returns null for empty, null and malformed refs', () => {
    expect(parseModelRef('')).toBeNull();
    expect(parseModelRef(null)).toBeNull();
    expect(parseModelRef('   ')).toBeNull();
    expect(parseModelRef('/leading')).toBeNull();
    expect(parseModelRef('trailing/')).toBeNull();
  });
});

describe('buildVisionMergedContent', () => {
  test('appends description after user text', () => {
    expect(buildVisionMergedContent('看下这个报错', 'ERR: xxx')).toBe('看下这个报错\n\n[图片内容识别]\nERR: xxx');
  });

  test('image-only message uses description only', () => {
    expect(buildVisionMergedContent('', '图片描述')).toBe('[图片内容识别]\n图片描述');
  });
});

describe('describeImagesWithFallback', () => {
  const primary = { provider: 'vision', id: 'primary-model' };
  const fallback = { provider: 'vision', id: 'fallback-model' };

  test('primary success → ok and primary-only call', async () => {
    const calls: string[] = [];
    const piClient = {
      completeModel: async (input: { provider: string; id: string }) => {
        calls.push(`${input.provider}/${input.id}`);
        return { text: '主模型描述', stopReason: 'stop' };
      },
    };
    const outcome = await describeImagesWithFallback(piClient, primary, fallback, '内容', []);
    expect(outcome).toEqual({ ok: true, description: '主模型描述' });
    expect(calls).toEqual(['vision/primary-model']);
  });

  test('primary failure → fallback succeeds, both called', async () => {
    const calls: string[] = [];
    const piClient = {
      completeModel: async (input: { provider: string; id: string }) => {
        calls.push(`${input.provider}/${input.id}`);
        if (calls.length === 1) throw new Error('primary down');
        return { text: '备选描述', stopReason: 'stop' };
      },
    };
    const outcome = await describeImagesWithFallback(piClient, primary, fallback, '内容', []);
    expect(outcome).toEqual({ ok: true, description: '备选描述' });
    expect(calls).toEqual(['vision/primary-model', 'vision/fallback-model']);
  });

  test('both fail → ok:false', async () => {
    const piClient = {
      completeModel: async () => {
        throw new Error('down');
      },
    };
    const outcome = await describeImagesWithFallback(piClient, primary, fallback, '内容', []);
    expect(outcome).toEqual({ ok: false, error: '主备多模态模型均不可用' });
  });

  test('empty response counts as failure and triggers fallback', async () => {
    const calls: string[] = [];
    const piClient = {
      completeModel: async (input: { provider: string; id: string }) => {
        calls.push(`${input.provider}/${input.id}`);
        return { text: '   \n  ', stopReason: 'stop' };
      },
    };
    const outcome = await describeImagesWithFallback(piClient, primary, fallback, '内容', []);
    expect(outcome).toEqual({ ok: false, error: '主备多模态模型均不可用' });
    expect(calls).toEqual(['vision/primary-model', 'vision/fallback-model']);
  });

  test('stopReason error with errorMessage fails the model attempt', async () => {
    const calls: string[] = [];
    const piClient = {
      completeModel: async (input: { provider: string; id: string }) => {
        calls.push(`${input.provider}/${input.id}`);
        return { text: '', stopReason: 'error', errorMessage: 'upstream 500' };
      },
    };
    const outcome = await describeImagesWithFallback(piClient, primary, fallback, '内容', []);
    expect(outcome).toEqual({ ok: false, error: '主备多模态模型均不可用' });
    expect(calls).toEqual(['vision/primary-model', 'vision/fallback-model']);
  });
});
