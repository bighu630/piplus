import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createDb } from '@piplus/db/client';
import { createSeedDb } from '@piplus/db/init';
import { messages, projects, roleTemplates, sessionEvents, sessions } from '@piplus/db/schema';
import { stringifyLocator } from '@piplus/pi-client/locator';
import type { PiClient, PiSessionStreamEvent, PiToolDef } from '@piplus/pi-client';
import { startSessionRun, clearIdleRuntimeCleanup, markWritebackConsumed, scheduleIdleRuntimeCleanup, finalizeSessionStop, finalizeForcedRuntimeReclaim, markSessionIdleIfRunOwned } from './runtime';
import { ASK_QUESTION_SYSTEM_PROMPT } from '../extensions/ask-question';
import { createRoleManagerService } from '../role-manager/service';
import { setCrossProjectWait, clearCrossProjectWait, setWaitingOnChild, clearWaitingOnChild, isWaitingOnChild } from './request-context';

function makeDbPath() {
  return `/tmp/piplus-session-runtime-${crypto.randomUUID()}.sqlite`;
}

function makePiClient(options?: { sendError?: Error; ensureRuntimeError?: Error; streaming?: boolean }) {
  const opts = options;
  const state: {
    runtimeEnsured: Array<{ sessionId: string; cwd?: string; systemPrompt?: string }>;
    promptsInjected: string[];
    bound: Array<{ sessionId: string; cwd?: string; tools: PiToolDef[] }>;
    subscribed: string[];
    unsubscribed: string[];
    sent: Array<{ sessionId: string; content: string }>;
    closeRuntimeCalls: string[];
    stopSessionCalls: string[];
  } = {
    runtimeEnsured: [],
    promptsInjected: [],
    bound: [],
    subscribed: [],
    unsubscribed: [],
    sent: [],
    closeRuntimeCalls: [],
    stopSessionCalls: [],
  };

  const client: PiClient = {
    async createSession() {
      throw new Error('not_implemented');
    },
    async restoreRuntime(_sessionId, _locator, _cwd) {
      // restores runtime — called internally by ensureRuntime
    },
    async ensureRuntime(sessionId, options) {
      state.runtimeEnsured.push({ sessionId, cwd: options.cwd, systemPrompt: options.systemPrompt });
      // 模拟 ensureRuntime 抛错（如 runtime 无法恢复）——认领后失败必须复位 idle
      if (opts?.ensureRuntimeError) throw opts.ensureRuntimeError;
    },
    isFirstConversation() {
      return false;
    },
    getRuntimeState() {
      // streaming: true 模拟 safety timeout 后 agent 仍在后台生成（isStreaming 守卫）
      return opts?.streaming ? { ready: true, isFirst: false, isStreaming: true } : null;
    },
    async injectPromptIfNeeded(sessionId) {
      state.promptsInjected.push(sessionId);
    },
    async subscribeSession(sessionId, listener) {
      state.subscribed.push(sessionId);
      await listener({ type: 'message_start', sessionId, runId: 'run_stream', messageId: 'msg_stream' } satisfies PiSessionStreamEvent);
      return () => {
        state.unsubscribed.push(sessionId);
      };
    },
    async getHistory() {
      return { messages: [], nextCursor: null };
    },
    async sendMessage(sessionId, content) {
      state.sent.push({ sessionId, content });
      if (opts?.sendError) throw opts.sendError;
      return { sessionId, runId: 'run_pi' };
    },
    async stopSession(sessionId: string) {
      state.stopSessionCalls.push(sessionId);
      return { status: 'stopped' as const };
    },
    async waitForSessionIdle() {
      return true;
    },
    async closeRuntime(sessionId: string) {
      state.closeRuntimeCalls.push(sessionId);
      return;
    },
    async disposeSession() {
      // 删除/归档路径的释放逻辑在 API 路由测试中覆盖，domain 层 mock 无需跟踪
      return;
    },
    async reloadIdleRuntimes() {
      return 0;
    },
    async listAvailableModels() {
      return [];
    },
    async getCurrentModel() {
      return null;
    },
    async setSessionModel() {
      throw new Error('not_implemented');
    },
    async getContextUsage() {
      return null;
    },
    async compactSession() {
      return;
    },
    async getCommands() {
      return [];
    },
    async executeCommand() {
      return null;
    },
    async bindToolRuntime(sessionId, tools, _handler, cwd) {
      state.bound.push({ sessionId, cwd, tools });
    },
    async getThinkingLevel() {
      return null;
    },
    async getAvailableThinkingLevels() {
      return [];
    },
    async setThinkingLevel() {
      return 'medium';
    },
    async completeModel() {
      throw new Error('not implemented in test mock');
    },
  };

  return { client, state };
}

async function setupSession(overrides?: {
  roleTemplateId?: string;
  sessionId?: string;
}) {
  const dbPath = makeDbPath();
  createSeedDb(dbPath);
  const db = createDb(`file:${dbPath}`);
  const now = new Date();
  await db.insert(projects).values({
    id: 'project_test_runtime',
    name: 'Runtime Project',
    createdBy: 'user_seed',
    status: 'active',
    projectPath: '/tmp/runtime-project',
    sourceType: 'existing',
    sourceUrl: '',
    archivedAt: null,
    archivedBy: null,
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
  } as any);

  await db.insert(sessions).values({
    id: overrides?.sessionId ?? 'session_test_runtime',
    projectId: 'project_test_runtime',
    parentSessionId: null,
    rootSessionId: overrides?.sessionId ?? 'session_test_runtime',
    depth: 0,
    roleTemplateId: overrides?.roleTemplateId ?? 'rt_blank',
    piSessionId: 'pi_session_runtime',
    piSessionLocatorJson: stringifyLocator({ piSessionId: 'pi_session_runtime', sessionFile: '/tmp/pi-runtime.jsonl' }),
    requestedByMessageId: null,
    title: 'Runtime Session',
    titleSource: 'default',
    status: 'active',
    runtimeStatus: 'idle',
    currentModelProvider: null,
    currentModelId: null,
    lastActivityAt: now,
    lastRunAt: null,
    lastStopAt: null,
    lastRuntimeError: null,
    createdBy: 'user_seed',
    archivedAt: null,
    archivedBy: null,
    createdAt: now,
    updatedAt: now,
    roleBasePromptSnapshot: 'base',
    userSuppliedPrompt: '',
    parentSuppliedPrompt: '',
    compiledPrompt: 'compiled',
  } as any);

  return { db };
}

/**
 * 有界轮询等待条件成立（超时返回 false）。
 * 固定 sleep 在慢 CI 上会 flake（要么观测不到、要么把断言变成空跑）；
 * 轮询在超时后仍返回一次判定结果，调用方必须对返回值断言——不得当弱断言用。
 */
async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await Bun.sleep(5);
  }
  return await predicate();
}

/** 有界轮询：预算内确认条件始终不成立（「不得发生」类断言，避免固定 sleep 的单点抽样）。 */
async function confirmNever(predicate: () => boolean | Promise<boolean>, budgetMs = 200): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await predicate()) return false;
    await Bun.sleep(10);
  }
  return !(await predicate());
}

type TestDb = Awaited<ReturnType<typeof setupSession>>['db'];

async function readSessionRuntime(db: TestDb, sessionId: string) {
  const [row] = await db
    .select({ runtimeStatus: sessions.runtimeStatus, lastRuntimeError: sessions.lastRuntimeError })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return row;
}

/** 有界轮询等待会话落到目标 runtimeStatus（慢 CI 上固定 sleep 会 flake）。 */
async function waitForRuntimeStatus(db: TestDb, sessionId: string, status: 'idle' | 'running', timeoutMs = 3000): Promise<boolean> {
  return await waitUntil(async () => (await readSessionRuntime(db, sessionId))?.runtimeStatus === status, timeoutMs);
}

/**
 * 有界轮询：在 windows × windowMs 的预算内反复确认会话「始终未被 safety timeout 收敛」。
 * - 固定 sleep 在慢 CI 上只观测一次，且无法区分「豁免生效」与「定时器根本没跑」；
 * - 轮询在每个窗口内多次读 DB，并在预算耗尽后再断言一次（等价于原 sleep 的强度，不放宽）；
 * - 若预算内出现 idle，立即由断言报失败——不是「睡完再看」的单点抽样。
 */
async function expectStillRunningAcrossWindows(
  db: TestDb,
  sessionId: string,
  options: { windowMs: number; windows: number; unsubscribed?: string[] },
) {
  const deadline = Date.now() + options.windowMs * options.windows;
  const pollInterval = Math.max(5, Math.floor(options.windowMs / 4));
  while (Date.now() < deadline) {
    const row = await readSessionRuntime(db, sessionId);
    expect(row?.runtimeStatus).toBe('running');
    expect(row?.lastRuntimeError).toBeNull();
    if (options.unsubscribed) expect(options.unsubscribed).not.toContain(sessionId);
    await Bun.sleep(pollInterval);
  }
  const final = await readSessionRuntime(db, sessionId);
  expect(final?.runtimeStatus).toBe('running');
  expect(final?.lastRuntimeError).toBeNull();
  if (options.unsubscribed) expect(options.unsubscribed).not.toContain(sessionId);
}

describe('startSessionRun', () => {
  test('marks session running before send and restores idle after success', async () => {
    const { db } = await setupSession();
    const { client, state } = makePiClient();
    const statusEvents: Array<{ runtimeStatus: 'running' | 'idle'; error: string | null }> = [];
    const streamEvents: PiSessionStreamEvent[] = [];

    const run = await startSessionRun({
      db,
      piClient: client,
      sessionId: 'session_test_runtime',
      userId: 'user_seed',
      content: 'hello runtime',
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      onStreamEvent: async (event) => {
        streamEvents.push(event);
      },
      onRuntimeStatusChange: async ({ runtimeStatus, error }) => {
        statusEvents.push({ runtimeStatus, error });
      },
    });

    expect(run.sessionId).toBe('session_test_runtime');
    expect(state.runtimeEnsured).toEqual([{
      sessionId: 'session_test_runtime',
      cwd: '/tmp/runtime-project',
      // buildAllToolDefs 默认加载 ask_question → systemPrompt 使用指引随之传入（before_agent_start 注入）
      systemPrompt: ASK_QUESTION_SYSTEM_PROMPT,
    }]);
    // Prompt is now merged with user content at the caller level (not injected separately)
    // Tool binding is now part of ensureRuntime (not called separately)
    expect(state.sent).toEqual([{ sessionId: 'session_test_runtime', content: 'hello runtime' }]);
    expect(streamEvents).toHaveLength(1);
    expect(statusEvents[0]).toEqual({ runtimeStatus: 'running', error: null });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const [session] = await db.select().from(sessions).where(eq(sessions.id, 'session_test_runtime')).limit(1);
    expect(session?.runtimeStatus).toBe('idle');
    expect(session?.lastRunAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(session?.lastRuntimeError).toBeNull();
    expect(statusEvents.at(-1)).toEqual({ runtimeStatus: 'idle', error: null });
    expect(state.unsubscribed).toEqual(['session_test_runtime']);
  });

  test('ask_question 工具存在时 ensureRuntime 收到 ASK_QUESTION_SYSTEM_PROMPT（before_agent_start 注入接线）', async () => {
    const { db } = await setupSession();
    const { client, state } = makePiClient();

    await startSessionRun({
      db,
      piClient: client,
      sessionId: 'session_test_runtime',
      userId: 'user_seed',
      content: 'hello runtime',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // buildAllToolDefs 默认注册 ask_question → startSessionRun 必须把使用指引传给 ensureRuntime（
    // 由 pi-client 经 before_agent_start 注入 systemPrompt）。
    expect(state.runtimeEnsured).toHaveLength(1);
    expect(state.runtimeEnsured[0].systemPrompt).toBe(ASK_QUESTION_SYSTEM_PROMPT);
    // 指引内容包含工具用法要点，确保模型能收到可执行的说明
    expect(ASK_QUESTION_SYSTEM_PROMPT).toContain('ask_question');
    expect(ASK_QUESTION_SYSTEM_PROMPT).toContain('questions');
  });

  test('records runtime error and restores idle after failure', async () => {
    const { db } = await setupSession();
    const { client } = makePiClient({ sendError: new Error('pi_send_failed') });
    const statusEvents: Array<{ runtimeStatus: 'running' | 'idle'; error: string | null }> = [];

    await startSessionRun({
      db,
      piClient: client,
      sessionId: 'session_test_runtime',
      userId: 'user_seed',
      content: 'hello runtime',
      onRuntimeStatusChange: async ({ runtimeStatus, error }) => {
        statusEvents.push({ runtimeStatus, error });
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const [session] = await db.select().from(sessions).where(eq(sessions.id, 'session_test_runtime')).limit(1);
    expect(session?.runtimeStatus).toBe('idle');
    expect(session?.lastRuntimeError).toBe('pi_send_failed');
    expect(statusEvents[0]).toEqual({ runtimeStatus: 'running', error: null });
    expect(statusEvents.at(-1)).toEqual({ runtimeStatus: 'idle', error: 'pi_send_failed' });

    // Verify sessionEvents row was inserted
    const errEvents = await db.select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, 'session_test_runtime'))
      .all();
    expect(errEvents.length).toBeGreaterThan(0);
    expect(errEvents.at(-1)?.type).toBe('chat_runtime_error');
    expect(errEvents.at(-1)?.payload).toContain('pi_send_failed');
  });

  test('worker calls closeRuntime immediately after successful run', async () => {
    const { db } = await setupSession();

    // Insert a worker role template so the join resolves to key='worker'
    const workerRoleTmplId = 'rt_worker_test';
    await db.insert(roleTemplates).values({
      id: workerRoleTmplId,
      key: 'worker',
      version: '1',
      name: 'Worker',
      description: 'Worker role',
      basePrompt: 'Do work.',
      configJson: '{}',
      createdBy: 'system',
      ownerType: 'system',
      visibility: 'public',
      isBuiltin: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    // Create a worker session
    const workerSessionId = 'session_worker_test';
    await db.insert(sessions).values({
      id: workerSessionId,
      projectId: 'project_test_runtime',
      parentSessionId: null,
      rootSessionId: workerSessionId,
      depth: 0,
      roleTemplateId: workerRoleTmplId,
      piSessionId: 'pi_worker_test',
      piSessionLocatorJson: stringifyLocator({ piSessionId: 'pi_worker_test', sessionFile: '/tmp/pi-worker.jsonl' }),
      requestedByMessageId: null,
      title: 'Worker Session',
      titleSource: 'default',
      status: 'active',
      runtimeStatus: 'idle',
      currentModelProvider: null,
      currentModelId: null,
      lastActivityAt: new Date(),
      lastRunAt: null,
      lastStopAt: null,
      lastRuntimeError: null,
      createdBy: 'user_seed',
      archivedAt: null,
      archivedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      roleBasePromptSnapshot: 'base',
      userSuppliedPrompt: '',
      parentSuppliedPrompt: '',
      compiledPrompt: 'compiled',
    } as any);

    const { client, state } = makePiClient();
    await startSessionRun({
      db,
      piClient: client,
      sessionId: workerSessionId,
      userId: 'user_seed',
      content: 'hello worker',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    // Worker should have closeRuntime called immediately
    expect(state.closeRuntimeCalls).toContain(workerSessionId);
  });

  test('worker calls closeRuntime immediately after failed run', async () => {
    const { db } = await setupSession();

    const workerRoleTmplId = 'rt_worker_test2';
    await db.insert(roleTemplates).values({
      id: workerRoleTmplId,
      key: 'worker',
      version: '1',
      name: 'Worker',
      description: 'Worker role',
      basePrompt: 'Do work.',
      configJson: '{}',
      createdBy: 'system',
      ownerType: 'system',
      visibility: 'public',
      isBuiltin: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    const workerSessionId = 'session_worker_test_fail';
    await db.insert(sessions).values({
      id: workerSessionId,
      projectId: 'project_test_runtime',
      parentSessionId: null,
      rootSessionId: workerSessionId,
      depth: 0,
      roleTemplateId: workerRoleTmplId,
      piSessionId: 'pi_worker_fail',
      piSessionLocatorJson: stringifyLocator({ piSessionId: 'pi_worker_fail', sessionFile: '/tmp/pi-worker-fail.jsonl' }),
      requestedByMessageId: null,
      title: 'Worker Session Fail',
      titleSource: 'default',
      status: 'active',
      runtimeStatus: 'idle',
      currentModelProvider: null,
      currentModelId: null,
      lastActivityAt: new Date(),
      lastRunAt: null,
      lastStopAt: null,
      lastRuntimeError: null,
      createdBy: 'user_seed',
      archivedAt: null,
      archivedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      roleBasePromptSnapshot: 'base',
      userSuppliedPrompt: '',
      parentSuppliedPrompt: '',
      compiledPrompt: 'compiled',
    } as any);

    const { client, state } = makePiClient({ sendError: new Error('worker_failed') });
    await startSessionRun({
      db,
      piClient: client,
      sessionId: workerSessionId,
      userId: 'user_seed',
      content: 'hello worker',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    // Worker should still have closeRuntime called even on failure
    expect(state.closeRuntimeCalls).toContain(workerSessionId);
  });

  test('non-worker does NOT call closeRuntime immediately', async () => {
    const { db } = await setupSession();
    const { client, state } = makePiClient();

    // roleTemplateId 'rt_blank' does not match any template in DB, so roleKey=null (non-worker)
    await startSessionRun({
      db,
      piClient: client,
      sessionId: 'session_test_runtime',
      userId: 'user_seed',
      content: 'hello non-worker',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    // Non-worker should NOT have closeRuntime called immediately
    expect(state.closeRuntimeCalls).not.toContain('session_test_runtime');
  });

  test('scheduleIdleRuntimeCleanup calls closeRuntime after TTL', async () => {
    const { client: piClient, state } = makePiClient();
    const sessionId = 'session_idle_ttl';

    // Schedule with a very short TTL (10ms)
    scheduleIdleRuntimeCleanup(piClient, sessionId, 10);

    // Verify not called yet
    expect(state.closeRuntimeCalls).not.toContain(sessionId);

    // Wait for timer to fire
    await new Promise((resolve) => setTimeout(resolve, 20));

    // After TTL, closeRuntime should have been called
    expect(state.closeRuntimeCalls).toContain(sessionId);

    // Cleanup any remaining timer
    clearIdleRuntimeCleanup(sessionId);
  });

  test('clearIdleRuntimeCleanup cancels pending timer', async () => {
    const { client: piClient, state } = makePiClient();
    const sessionId = 'session_idle_cancel';

    // Schedule with a short TTL
    scheduleIdleRuntimeCleanup(piClient, sessionId, 50);

    // Immediately cancel
    clearIdleRuntimeCleanup(sessionId);

    // Wait past the TTL
    await new Promise((resolve) => setTimeout(resolve, 70));

    // closeRuntime should NOT have been called (timer was cancelled before firing)
    expect(state.closeRuntimeCalls).not.toContain(sessionId);
  });

  test('startSessionRun clears existing idle timer for non-worker', async () => {
    const { db } = await setupSession();
    const { client, state } = makePiClient();

    // First run: non-worker enters idle and schedules a 30-min cleanup timer
    await startSessionRun({
      db,
      piClient: client,
      sessionId: 'session_test_runtime',
      userId: 'user_seed',
      content: 'first run',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    // closeRuntime should NOT have been called yet (non-worker)
    expect(state.closeRuntimeCalls).not.toContain('session_test_runtime');

    // Manually schedule a short-TTL timer for this session to simulate an
    // existing idle timer that should be cancelled by the next startSessionRun
    scheduleIdleRuntimeCleanup(client, 'session_test_runtime', 30);

    // Second run: should cancel the old timer via clearIdleRuntimeCleanup at start
    await startSessionRun({
      db,
      piClient: client,
      sessionId: 'session_test_runtime',
      userId: 'user_seed',
      content: 'second run',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    // Wait past the short TTL — the old timer should have been cancelled
    // and should NOT have called closeRuntime
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(state.closeRuntimeCalls).not.toContain('session_test_runtime');
  });

  test('safety timeout is exempted while a direct child session is running', async () => {
    // Parent session with role_worker; child session inserted as still running
    const { db } = await setupSession({ sessionId: 'session_parent', roleTemplateId: 'role_worker' });
    const now = new Date();

    await db.insert(sessions).values({
      id: 'session_child',
      projectId: 'project_test_runtime',
      parentSessionId: 'session_parent',
      rootSessionId: 'session_parent',
      depth: 1,
      roleTemplateId: 'role_worker',
      piSessionId: 'pi_session_child',
      piSessionLocatorJson: stringifyLocator({ piSessionId: 'pi_session_child', sessionFile: '/tmp/pi-child.jsonl' }),
      requestedByMessageId: null,
      title: 'Child Session',
      titleSource: 'default',
      status: 'active',
      runtimeStatus: 'running',
      currentModelProvider: null,
      currentModelId: null,
      lastActivityAt: now,
      lastRunAt: now,
      lastStopAt: null,
      lastRuntimeError: null,
      createdBy: 'user_seed',
      archivedAt: null,
      archivedBy: null,
      createdAt: now,
      updatedAt: now,
      roleBasePromptSnapshot: 'base',
      userSuppliedPrompt: '',
      parentSuppliedPrompt: '',
      compiledPrompt: 'compiled',
    } as any);

    const { client, state } = makePiClient();
    // sendMessage never resolves — session stays running with no stream events
    const pendingClient: PiClient = { ...client, sendMessage: () => new Promise<never>(() => {}) };

    await startSessionRun({
      db,
      piClient: pendingClient,
      sessionId: 'session_parent',
      userId: 'user_seed',
      content: 'x',
      safetyTimeoutMs: 150,
      onStreamEvent: async () => {},
      onRuntimeStatusChange: async () => {},
    });

    // Wait past the safety timeout — parent must stay running (child active)
    await Bun.sleep(400);

    const [parent] = await db.select().from(sessions).where(eq(sessions.id, 'session_parent')).limit(1);
    expect(parent?.runtimeStatus).toBe('running');
    expect(parent?.lastRuntimeError).toBeNull();
    // No cleanup ran — stream subscription still active
    expect(state.unsubscribed).not.toContain('session_parent');

    // Child goes idle — countdown resumes and the timeout finally fires
    await db.update(sessions)
      .set({ runtimeStatus: 'idle', updatedAt: new Date() })
      .where(eq(sessions.id, 'session_child'));

    await Bun.sleep(400);

    const [parentAfter] = await db.select().from(sessions).where(eq(sessions.id, 'session_parent')).limit(1);
    expect(parentAfter?.runtimeStatus).toBe('idle');
    // session_run_timeout is an internal safety timeout — not surfaced to the user
    expect(parentAfter?.lastRuntimeError).toBeNull();
    expect(state.unsubscribed).toContain('session_parent');
  });

  test('cross-project wait marker exempts safety timeout', async () => {
    // 临时 db + parent session；sendMessage 永不 resolve（无 stream 事件）
    const { db } = await setupSession({ sessionId: 'session_cross_wait' });

    const { client, state } = makePiClient();
    // sendMessage never resolves — session stays running with no stream events
    const pendingClient: PiClient = { ...client, sendMessage: () => new Promise<never>(() => {}) };

    try {
      // 标记本会话正在等待跨项目回复（目标会话是顶层会话，DB 查不到子会话）
      setCrossProjectWait('session_cross_wait', 'req_test');

      await startSessionRun({
        db,
        piClient: pendingClient,
        sessionId: 'session_cross_wait',
        userId: 'user_seed',
        content: 'x',
        safetyTimeoutMs: 150,
        onStreamEvent: async () => {},
        onRuntimeStatusChange: async () => {},
      });

      // Wait past the safety timeout — the marker exempts the parent
      await Bun.sleep(400);

      const [parent] = await db.select().from(sessions).where(eq(sessions.id, 'session_cross_wait')).limit(1);
      expect(parent?.runtimeStatus).toBe('running');
      expect(parent?.lastRuntimeError).toBeNull();
      // No cleanup ran — stream subscription still active
      expect(state.unsubscribed).not.toContain('session_cross_wait');

      // Marker cleared — countdown resumes and the timeout finally fires
      clearCrossProjectWait('session_cross_wait');

      await Bun.sleep(400);

      const [parentAfter] = await db.select().from(sessions).where(eq(sessions.id, 'session_cross_wait')).limit(1);
      expect(parentAfter?.runtimeStatus).toBe('idle');
      // session_run_timeout is an internal safety timeout — not surfaced to the user
      expect(parentAfter?.lastRuntimeError).toBeNull();
      expect(state.unsubscribed).toContain('session_cross_wait');
    } finally {
      // 即使断言失败也要清理标记，避免模块级单例 Map 残留污染其他测试
      clearCrossProjectWait('session_cross_wait');
    }
  });

  // ─── waitingOnChild 内存标记：父 wait 期间豁免（对子会话瞬时 idle 免疫）────────
  test('safety timeout is exempted while parent is waiting on child (in-memory marker)', async () => {
    // 精确复现竞态：子会话已处于瞬时 idle 窗口（子 run 结束未 writeback / 子被自身超时杀 /
    // writeback 落库前）——旧 DB 查询（查非 idle 子会话）在此窗口豁免失败 → 父被连坐杀。
    // 内存标记在 wait 循环期间始终置位，与子会话瞬时 DB 状态无关，修复此竞态。
    const { db } = await setupSession({ sessionId: 'session_wait_marker', roleTemplateId: 'role_worker' });
    const now = new Date();

    // 子会话已 idle（瞬时窗口）：旧 DB 查询豁免不到，只有内存标记能豁免
    await db.insert(sessions).values({
      id: 'session_wait_marker_child',
      projectId: 'project_test_runtime',
      parentSessionId: 'session_wait_marker',
      rootSessionId: 'session_wait_marker',
      depth: 1,
      roleTemplateId: 'role_worker',
      piSessionId: 'pi_session_wait_marker_child',
      piSessionLocatorJson: stringifyLocator({ piSessionId: 'pi_session_wait_marker_child', sessionFile: '/tmp/pi-wait-marker-child.jsonl' }),
      requestedByMessageId: null,
      title: 'Wait Marker Child',
      titleSource: 'default',
      status: 'active',
      runtimeStatus: 'idle',
      currentModelProvider: null,
      currentModelId: null,
      lastActivityAt: now,
      lastRunAt: now,
      lastStopAt: null,
      lastRuntimeError: null,
      createdBy: 'user_seed',
      archivedAt: null,
      archivedBy: null,
      createdAt: now,
      updatedAt: now,
      roleBasePromptSnapshot: 'base',
      userSuppliedPrompt: '',
      parentSuppliedPrompt: '',
      compiledPrompt: 'compiled',
    } as any);

    const { client, state } = makePiClient();
    // sendMessage never resolves — session stays running with no stream events
    const pendingClient: PiClient = { ...client, sendMessage: () => new Promise<never>(() => {}) };

    try {
      // 标记父会话正处于 waitForChildWriteback 轮询（wait 循环开始时置位，退出时清除）
      setWaitingOnChild('session_wait_marker', 'req_test', 'session_wait_marker_child');

      await startSessionRun({
        db,
        piClient: pendingClient,
        sessionId: 'session_wait_marker',
        userId: 'user_seed',
        content: 'x',
        safetyTimeoutMs: 150,
        onStreamEvent: async () => {},
        onRuntimeStatusChange: async () => {},
      });

      // 内存标记豁免（子会话 idle 也不受影响）：在 ≥1 个安全窗口内轮询确认始终未被收敛。
      // （旧写法：固定 sleep(400) 单点抽样——慢 CI 上既可能漏观测，也可能空跑）
      await expectStillRunningAcrossWindows(db, 'session_wait_marker', {
        windowMs: 150,
        windows: 1,
        unsubscribed: state.unsubscribed,
      });

      // Marker cleared — countdown resumes and the timeout finally fires
      clearWaitingOnChild('session_wait_marker');

      // 有界轮询等待超时恢复执行（证明计时器确实在跑，上方的「仍 running」不是空跑）
      expect(await waitForRuntimeStatus(db, 'session_wait_marker', 'idle')).toBe(true);

      const [parentAfter] = await db.select().from(sessions).where(eq(sessions.id, 'session_wait_marker')).limit(1);
      expect(parentAfter?.runtimeStatus).toBe('idle');
      // session_run_timeout is an internal safety timeout — not surfaced to the user
      expect(parentAfter?.lastRuntimeError).toBeNull();
      expect(state.unsubscribed).toContain('session_wait_marker');
    } finally {
      // 即使断言失败也要清理标记，避免模块级单例 Map 残留污染其他测试
      clearWaitingOnChild('session_wait_marker');
    }
  });

  test('parallel parent waits: clearing one child keeps the parent exempt via the other child', async () => {
    // 回归（线上事故场景）：父并行 spawn_session(wait=true) 等两个 worker。先返回的
    // waitForChildWriteback 在 finally 里只应清理自己那个子会话的标记；旧实现 clear(parent)
    // 会把另一个仍在进行的等待一并清掉 → 父失去豁免 1，被自身 safety timeout 强杀。
    const { db } = await setupSession({ sessionId: 'session_parallel_wait_parent', roleTemplateId: 'role_worker' });
    const now = new Date();

    // 两个子会话在 DB 中均为 idle（瞬时窗口）：豁免 2 的 DB 查询查不到 active child，
    // 父是否被豁免完全取决于内存多条目标记（豁免 1）。
    for (const childId of ['session_parallel_wait_child_1', 'session_parallel_wait_child_2']) {
      await db.insert(sessions).values({
        id: childId,
        projectId: 'project_test_runtime',
        parentSessionId: 'session_parallel_wait_parent',
        rootSessionId: 'session_parallel_wait_parent',
        depth: 1,
        roleTemplateId: 'role_worker',
        piSessionId: `pi_${childId}`,
        piSessionLocatorJson: stringifyLocator({ piSessionId: `pi_${childId}`, sessionFile: `/tmp/pi-${childId}.jsonl` }),
        requestedByMessageId: null,
        title: 'Parallel Wait Child',
        titleSource: 'default',
        status: 'active',
        runtimeStatus: 'idle',
        currentModelProvider: null,
        currentModelId: null,
        lastActivityAt: now,
        lastRunAt: now,
        lastStopAt: null,
        lastRuntimeError: null,
        createdBy: 'user_seed',
        archivedAt: null,
        archivedBy: null,
        createdAt: now,
        updatedAt: now,
        roleBasePromptSnapshot: 'base',
        userSuppliedPrompt: '',
        parentSuppliedPrompt: '',
        compiledPrompt: 'compiled',
      } as any);
    }

    const { client, state } = makePiClient();
    // sendMessage never resolves — session stays running with no stream events
    const pendingClient: PiClient = { ...client, sendMessage: () => new Promise<never>(() => {}) };

    try {
      // 父并行等待两个子会话（两次 spawn_session wait=true）——多条目并存
      setWaitingOnChild('session_parallel_wait_parent', 'req_parallel_1', 'session_parallel_wait_child_1');
      setWaitingOnChild('session_parallel_wait_parent', 'req_parallel_2', 'session_parallel_wait_child_2');

      await startSessionRun({
        db,
        piClient: pendingClient,
        sessionId: 'session_parallel_wait_parent',
        userId: 'user_seed',
        content: 'x',
        safetyTimeoutMs: 150,
        onStreamEvent: async () => {},
        onRuntimeStatusChange: async () => {},
      });

      // 先跨过 1 个安全窗口：父并行等两子，豁免 1 必须让它始终未被收敛
      await expectStillRunningAcrossWindows(db, 'session_parallel_wait_parent', {
        windowMs: 150,
        windows: 1,
        unsubscribed: state.unsubscribed,
      });

      // 第一个 wait 循环先退出：精确清理自己那个子会话
      clearWaitingOnChild('session_parallel_wait_parent', 'session_parallel_wait_child_1');

      // 旧实现：clear 连 child_2 的标记一起清掉 → 父被超时强杀 → 以下轮询断言 FAIL。
      // 在 ≥2 个窗口内持续确认仍 running（固定 sleep 的单点抽样换成全程轮询）
      await expectStillRunningAcrossWindows(db, 'session_parallel_wait_parent', {
        windowMs: 150,
        windows: 2,
        unsubscribed: state.unsubscribed,
      });

      // 第二个 wait 循环也退出后，豁免 1 才真正失效，超时恢复执行
      clearWaitingOnChild('session_parallel_wait_parent', 'session_parallel_wait_child_2');

      expect(await waitForRuntimeStatus(db, 'session_parallel_wait_parent', 'idle')).toBe(true);

      const [parentAfter] = await db.select().from(sessions).where(eq(sessions.id, 'session_parallel_wait_parent')).limit(1);
      expect(parentAfter?.runtimeStatus).toBe('idle');
      expect(parentAfter?.lastRuntimeError).toBeNull();
      expect(state.unsubscribed).toContain('session_parallel_wait_parent');
    } finally {
      // 即使断言失败也要清理标记，避免模块级单例 Map 残留污染其他测试
      clearWaitingOnChild('session_parallel_wait_parent');
    }
  });

  test('child session is exempted from its own safety timeout while parent waits', async () => {
    // 子会话被父 wait 循环管理时豁免自身 10 分钟硬超时：父的 reminder（15-45s）比硬杀
    // 更及时更有针对性，且子被硬杀正是父被连坐杀的直接诱因。父 wait 循环退出（含 deadline
    // 超时）会清除标记，豁免随之消失，真正卡死的会话最终仍会被自身超时回收。
    const { db } = await setupSession({ sessionId: 'session_child_managed', roleTemplateId: 'role_worker' });
    // 无需真实插入父行——豁免逻辑只读子行 + 内存标记
    await db.update(sessions)
      .set({ parentSessionId: 'session_waiting_parent', updatedAt: new Date() })
      .where(eq(sessions.id, 'session_child_managed'));

    const { client, state } = makePiClient();
    // sendMessage never resolves — session stays running with no stream events
    const pendingClient: PiClient = { ...client, sendMessage: () => new Promise<never>(() => {}) };

    try {
      setWaitingOnChild('session_waiting_parent', 'req_test', 'session_child_managed');

      await startSessionRun({
        db,
        piClient: pendingClient,
        sessionId: 'session_child_managed',
        userId: 'user_seed',
        content: 'x',
        safetyTimeoutMs: 150,
        onStreamEvent: async () => {},
        onRuntimeStatusChange: async () => {},
      });

      // Wait past the safety timeout — 父在等 → 豁免生效，子仍 running、未 unsubscribed
      await Bun.sleep(400);

      const [child] = await db.select().from(sessions).where(eq(sessions.id, 'session_child_managed')).limit(1);
      expect(child?.runtimeStatus).toBe('running');
      expect(child?.lastRuntimeError).toBeNull();
      expect(state.unsubscribed).not.toContain('session_child_managed');

      // Marker cleared — 豁免随之消失，超时恢复执行
      clearWaitingOnChild('session_waiting_parent');

      await Bun.sleep(400);

      const [childAfter] = await db.select().from(sessions).where(eq(sessions.id, 'session_child_managed')).limit(1);
      expect(childAfter?.runtimeStatus).toBe('idle');
      // session_run_timeout is an internal safety timeout — not surfaced to the user
      expect(childAfter?.lastRuntimeError).toBeNull();
      expect(state.unsubscribed).toContain('session_child_managed');
    } finally {
      clearWaitingOnChild('session_waiting_parent');
    }
  });

  test('sibling child is NOT exempted — only the awaited child matches', async () => {
    // 豁免 4 必须精确匹配父标记中记录的 childSessionId：父先 spawn wait=false 后台子 B（本测试跑 B），
    // 再 spawn wait=true 等子 A（标记记录的是 A）。旧实现只做 has 判断，B 卡死时也会命中父标记
    // 被无限豁免；修复后 B 必须被自身超时回收（父的 reminder 只管得到 A，管不到 B）。
    const { db } = await setupSession({ sessionId: 'session_sibling_child', roleTemplateId: 'role_worker' });
    // 无需真实插入父行——豁免逻辑只读子行 + 内存标记
    await db.update(sessions)
      .set({ parentSessionId: 'session_sibling_parent', updatedAt: new Date() })
      .where(eq(sessions.id, 'session_sibling_child'));

    const { client, state } = makePiClient();
    // sendMessage never resolves — session stays running with no stream events
    const pendingClient: PiClient = { ...client, sendMessage: () => new Promise<never>(() => {}) };

    try {
      // 父在等的子会话是 A（session_awaited_child），本测试跑的是 B（session_sibling_child）——不匹配
      setWaitingOnChild('session_sibling_parent', 'req_test', 'session_awaited_child');

      await startSessionRun({
        db,
        piClient: pendingClient,
        sessionId: 'session_sibling_child',
        userId: 'user_seed',
        content: 'x',
        safetyTimeoutMs: 150,
        onStreamEvent: async () => {},
        onRuntimeStatusChange: async () => {},
      });

      // Wait past the safety timeout — B 不是父正在等的那一个 → 无豁免，直接被超时杀
      await Bun.sleep(400);

      const [child] = await db.select().from(sessions).where(eq(sessions.id, 'session_sibling_child')).limit(1);
      expect(child?.runtimeStatus).toBe('idle');
      // session_run_timeout is an internal safety timeout — not surfaced to the user
      expect(child?.lastRuntimeError).toBeNull();
      expect(state.unsubscribed).toContain('session_sibling_child');
    } finally {
      clearWaitingOnChild('session_sibling_parent');
    }
  });

  test('parallel siblings are each exempted while the parent waits on both', async () => {
    // 回归（并行场景）：父标记改为多条目后，豁免 4 必须对父正在等的每个子会话各自成立。
    // 旧实现单条目：后一次 setWaitingOnChild 覆盖前一次，只有一个子会话能命中豁免 4，
    // 另一个子会话被自身 safety timeout 误杀。
    const childId1 = 'session_parallel_managed_child_1';
    const childId2 = 'session_parallel_managed_child_2';
    const parentId = 'session_parallel_managed_parent';

    const setup1 = await setupSession({ sessionId: childId1, roleTemplateId: 'role_worker' });
    const setup2 = await setupSession({ sessionId: childId2, roleTemplateId: 'role_worker' });
    // 无需真实插入父行——豁免逻辑只读子行 + 内存标记
    await setup1.db.update(sessions)
      .set({ parentSessionId: parentId, updatedAt: new Date() })
      .where(eq(sessions.id, childId1));
    await setup2.db.update(sessions)
      .set({ parentSessionId: parentId, updatedAt: new Date() })
      .where(eq(sessions.id, childId2));

    const { client: client1, state: state1 } = makePiClient();
    const { client: client2, state: state2 } = makePiClient();
    // sendMessage never resolves — sessions stay running with no stream events
    const pendingClient1: PiClient = { ...client1, sendMessage: () => new Promise<never>(() => {}) };
    const pendingClient2: PiClient = { ...client2, sendMessage: () => new Promise<never>(() => {}) };

    try {
      // 父并行等待两个子会话——两条标记并存，两个子各自精确匹配自己那条
      setWaitingOnChild(parentId, 'req_parallel_managed_1', childId1);
      setWaitingOnChild(parentId, 'req_parallel_managed_2', childId2);

      await startSessionRun({
        db: setup1.db,
        piClient: pendingClient1,
        sessionId: childId1,
        userId: 'user_seed',
        content: 'x',
        safetyTimeoutMs: 150,
        onStreamEvent: async () => {},
        onRuntimeStatusChange: async () => {},
      });
      await startSessionRun({
        db: setup2.db,
        piClient: pendingClient2,
        sessionId: childId2,
        userId: 'user_seed',
        content: 'x',
        safetyTimeoutMs: 150,
        onStreamEvent: async () => {},
        onRuntimeStatusChange: async () => {},
      });

      // 跨过 2 个豁免窗口（未达连续豁免上限 3）——两个子都必须仍被豁免
      await Bun.sleep(350);

      const [child1] = await setup1.db.select().from(sessions).where(eq(sessions.id, childId1)).limit(1);
      const [child2] = await setup2.db.select().from(sessions).where(eq(sessions.id, childId2)).limit(1);
      // 旧实现：child_1 的标记已被 child_2 覆盖 → child_1 超时被杀 → 以下断言 FAIL
      expect(child1?.runtimeStatus).toBe('running');
      expect(child2?.runtimeStatus).toBe('running');
      expect(state1.unsubscribed).not.toContain(childId1);
      expect(state2.unsubscribed).not.toContain(childId2);

      // 父 wait 两个循环都退出 → 豁免失效，两个子各自被自身超时回收
      clearWaitingOnChild(parentId);
      await Bun.sleep(400);

      const [child1After] = await setup1.db.select().from(sessions).where(eq(sessions.id, childId1)).limit(1);
      const [child2After] = await setup2.db.select().from(sessions).where(eq(sessions.id, childId2)).limit(1);
      expect(child1After?.runtimeStatus).toBe('idle');
      expect(child2After?.runtimeStatus).toBe('idle');
    } finally {
      // 即使断言失败也要清理标记，避免模块级单例 Map 残留污染其他测试
      clearWaitingOnChild(parentId);
    }
  });

  test('managed child exemption is capped — stuck child still times out', async () => {
    // 默认配置下父 wait 循环 deadline=null 无限轮询：running 卡死（无事件、无自身标记）的子由豁免 4
    // 管理，但 reminder 只在子 idle 时触发，running 卡死无任何管理路径 → 永不超时。给豁免 4 加
    // 连续豁免上限（约 3×10 分钟）：只有连续静默窗口才累积，合法静默（嵌套 wait/跨项目等待）由
    // 豁免 1/3 覆盖不会走到这里，因此上限精确界定卡死场景。
    const { db } = await setupSession({ sessionId: 'session_capped_child', roleTemplateId: 'role_worker' });
    // 无需真实插入父行——豁免逻辑只读子行 + 内存标记
    await db.update(sessions)
      .set({ parentSessionId: 'session_capped_parent', updatedAt: new Date() })
      .where(eq(sessions.id, 'session_capped_child'));

    const { client, state } = makePiClient();
    // sendMessage never resolves — session stays running with no stream events
    const pendingClient: PiClient = { ...client, sendMessage: () => new Promise<never>(() => {}) };

    try {
      // 精确匹配（父确实在等本子会话）→ 豁免 4 生效，但连续豁免 3 次后达到上限强制超时
      setWaitingOnChild('session_capped_parent', 'req_test', 'session_capped_child');

      await startSessionRun({
        db,
        piClient: pendingClient,
        sessionId: 'session_capped_child',
        userId: 'user_seed',
        content: 'x',
        safetyTimeoutMs: 100, // 3 个豁免窗口 = 300ms 后达到上限
        onStreamEvent: async () => {},
        onRuntimeStatusChange: async () => {},
      });

      // Wait past 3 exemption windows — 标记仍在但已达上限，子被强制超时杀
      await Bun.sleep(700);

      const [child] = await db.select().from(sessions).where(eq(sessions.id, 'session_capped_child')).limit(1);
      expect(child?.runtimeStatus).toBe('idle');
      // session_run_timeout is an internal safety timeout — not surfaced to the user
      expect(child?.lastRuntimeError).toBeNull();
      expect(state.unsubscribed).toContain('session_capped_child');
      // 父标记仍在 → 证明杀因是豁免上限而非标记丢失
      expect(isWaitingOnChild('session_capped_parent')).toBe(true);
    } finally {
      clearWaitingOnChild('session_capped_parent');
    }
  });

  test('safety timeout fires normally when no child session is running', async () => {
    const { db } = await setupSession();

    const { client, state } = makePiClient();
    // sendMessage never resolves — no stream activity, only the timeout can end the run
    const pendingClient: PiClient = { ...client, sendMessage: () => new Promise<never>(() => {}) };

    await startSessionRun({
      db,
      piClient: pendingClient,
      sessionId: 'session_test_runtime',
      userId: 'user_seed',
      content: 'x',
      safetyTimeoutMs: 150,
      onStreamEvent: async () => {},
      onRuntimeStatusChange: async () => {},
    });

    // Wait past the safety timeout — no children, so the timeout must fire
    await Bun.sleep(400);

    const [session] = await db.select().from(sessions).where(eq(sessions.id, 'session_test_runtime')).limit(1);
    expect(session?.runtimeStatus).toBe('idle');
    // session_run_timeout is an internal safety timeout — not surfaced to the user
    expect(session?.lastRuntimeError).toBeNull();
    expect(state.unsubscribed).toContain('session_test_runtime');
  });

  // ─── 子会话安全计时器：不传 onStreamEvent 也必须订阅流事件 ─────────────
  test('subscribes to stream events even without onStreamEvent (child sessions)', async () => {
    const { db } = await setupSession({ sessionId: 'session_subscribe_no_ui' });
    const { client, state } = makePiClient();

    await startSessionRun({
      db,
      piClient: client,
      sessionId: 'session_subscribe_no_ui',
      userId: 'user_seed',
      content: 'x',
      safetyTimeoutMs: 150,
      // 不传 onStreamEvent：startChildSessionRun（spawn_session 的 worker 子会话）
      // 没有 UI 消费方，正是这种调用方式。安全计时器重置不能依赖它。
      onRuntimeStatusChange: async () => {},
    });

    try {
      // 即使没有 UI 消费方，runtime 也必须订阅流事件（否则 10 分钟硬超时必杀子会话）
      expect(state.subscribed).toContain('session_subscribe_no_ui');

      // sendMessage 正常 resolve → 会话正常回到 idle，订阅随之解除
      await Bun.sleep(50);
      const [session] = await db.select().from(sessions).where(eq(sessions.id, 'session_subscribe_no_ui')).limit(1);
      expect(session?.runtimeStatus).toBe('idle');
      expect(state.unsubscribed).toContain('session_subscribe_no_ui');
    } finally {
      // 非 worker 的 doCleanup 会调度 30min 定时器，取消避免污染模块级 Map
      clearIdleRuntimeCleanup('session_subscribe_no_ui');
    }
  });

  test('safety timeout resets on stream activity without onStreamEvent', async () => {
    const { db } = await setupSession({ sessionId: 'session_safety_reset' });
    const { client, state } = makePiClient();
    // sendMessage never resolves — only stream activity or the timeout can end the run
    const pendingClient: PiClient = { ...client, sendMessage: () => new Promise<never>(() => {}) };
    // 手动控制流事件到达时机：订阅只捕获 listener，不自动触发
    let capturedListener: ((event: PiSessionStreamEvent) => void | Promise<void>) | null = null;
    const manualClient: PiClient = {
      ...pendingClient,
      async subscribeSession(sessionId, listener) {
        state.subscribed.push(sessionId);
        capturedListener = listener;
        return () => {
          state.unsubscribed.push(sessionId);
        };
      },
    };

    await startSessionRun({
      db,
      piClient: manualClient,
      sessionId: 'session_safety_reset',
      userId: 'user_seed',
      content: 'x',
      safetyTimeoutMs: 150,
      onRuntimeStatusChange: async () => {},
    });

    try {
      // 80ms 时手动发一个 activity 事件（模拟 thinking/tool 阶段），重置计时器
      await Bun.sleep(80);
      expect(capturedListener).not.toBeNull();
      await capturedListener!({ type: 'activity', sessionId: 'session_safety_reset', runId: 'run_test' });

      // ~200ms：若无重置，150ms 超时早已触发；重置后仍应 running
      await Bun.sleep(120);
      let [session] = await db.select().from(sessions).where(eq(sessions.id, 'session_safety_reset')).limit(1);
      expect(session?.runtimeStatus).toBe('running');

      // ~450ms：无更多事件，超时兜底仍生效 → idle
      await Bun.sleep(250);
      [session] = await db.select().from(sessions).where(eq(sessions.id, 'session_safety_reset')).limit(1);
      expect(session?.runtimeStatus).toBe('idle');
      expect(state.unsubscribed).toContain('session_safety_reset');
    } finally {
      // 非 worker 的 doCleanup 会调度 30min 定时器，取消避免污染模块级 Map
      clearIdleRuntimeCleanup('session_safety_reset');
    }
  });

  test('unsubscribe still runs when onRuntimeStatusChange throws during cleanup', async () => {
    const { db } = await setupSession({ sessionId: 'session_unsub_on_status_error' });
    const { client, state } = makePiClient();

    // 第 1 次调用（running 状态回调）必须成功——它在 startSessionRun 主体 await，
    // 抛错会让 run 启动失败；只有第 2 次（doCleanup 的 idle 回调）抛错，
    // 才能覆盖 "markSessionIdle 之后、unsubscribe 之前出错" 的泄漏路径。
    let statusCalls = 0;
    await startSessionRun({
      db,
      piClient: client,
      sessionId: 'session_unsub_on_status_error',
      userId: 'user_seed',
      content: 'x',
      onRuntimeStatusChange: async () => {
        statusCalls++;
        if (statusCalls > 1) throw new Error('status_fail');
      },
    });

    // doCleanup 在异步 attemptSend 中执行：轮询等待 unsubscribe 被调用
    // （onRuntimeStatusChange 抛错也不得泄漏 listener——这是本次 try/finally 修复的核心）
    for (let i = 0; i < 200; i++) {
      if (state.unsubscribed.includes('session_unsub_on_status_error')) break;
      await Bun.sleep(10);
    }
    expect(state.unsubscribed).toContain('session_unsub_on_status_error');

    // 状态回调抛错不影响 DB 状态复位（markSessionIdle 在它之前已执行）
    const [session] = await db.select().from(sessions).where(eq(sessions.id, 'session_unsub_on_status_error')).limit(1);
    expect(session?.runtimeStatus).toBe('idle');
    expect(statusCalls).toBe(2);
  });

  // ─── #6 原子认领：并发双 POST 只有一个能启动 run ─────────────────────────
  test('#6 concurrent startSessionRun: atomic claim allows exactly one run', async () => {
    const { db } = await setupSession({ sessionId: 'session_concurrent_claim' });
    const { client, state } = makePiClient();

    const results = await Promise.allSettled([
      startSessionRun({ db, piClient: client, sessionId: 'session_concurrent_claim', userId: 'user_seed', content: 'first' }),
      startSessionRun({ db, piClient: client, sessionId: 'session_concurrent_claim', userId: 'user_seed', content: 'second' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason?.message).toBe('session_busy');

    // 轮询等待胜利方 doCleanup 把会话复位 idle（慢 CI 上固定 sleep 可能 flake）；
    // doCleanup 在 sendMessage 之后执行，DB idle 即意味着 sendMessage 已发出
    let sessionRow: { runtimeStatus: string; lastRuntimeError: string | null } | undefined;
    for (let i = 0; i < 200; i++) {
      [sessionRow] = await db.select({ runtimeStatus: sessions.runtimeStatus, lastRuntimeError: sessions.lastRuntimeError })
        .from(sessions)
        .where(eq(sessions.id, 'session_concurrent_claim'));
      if (sessionRow?.runtimeStatus === 'idle') break;
      await Bun.sleep(10);
    }

    // 只有一个 sendMessage 真正发出
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]?.content).toBe('first');
    expect(sessionRow?.runtimeStatus).toBe('idle');
    expect(sessionRow?.lastRuntimeError).toBeNull();

    // 非 worker 的 doCleanup 会调度 30min 定时器，取消避免污染模块级 Map
    clearIdleRuntimeCleanup('session_concurrent_claim');
  });

  // ─── #6 认领后失败复位：ensureRuntime 抛错不能把会话卡死在 running ───────
  test('#6 ensureRuntime failure resets claimed status back to idle', async () => {
    const { db } = await setupSession({ sessionId: 'session_claim_reset' });
    const { client } = makePiClient({ ensureRuntimeError: new Error('ensure_failed') });

    await expect(
      startSessionRun({ db, piClient: client, sessionId: 'session_claim_reset', userId: 'user_seed', content: 'hi' }),
    ).rejects.toThrow('ensure_failed');

    // 认领已发生（idle→running），失败后必须复位 idle，否则只能等重启 recoverStuckSessions
    const [session] = await db.select().from(sessions).where(eq(sessions.id, 'session_claim_reset')).limit(1);
    expect(session?.runtimeStatus).toBe('idle');
    expect(session?.lastRuntimeError).toBeNull();
  });

  // ─── #6 认领前失败：只读步骤（parseLocator 等）抛错时无状态变更，会话保持 idle ──
  test('#6 pre-claim failure (corrupt locator) leaves session idle — no stuck running', async () => {
    const { db } = await setupSession({ sessionId: 'session_corrupt_locator' });
    // 认领前只有只读步骤：parseLocator 对 corrupt JSON 抛错，此时不得把会话置为 running
    await db.update(sessions)
      .set({ piSessionLocatorJson: 'not-json{{{', updatedAt: new Date() })
      .where(eq(sessions.id, 'session_corrupt_locator'));
    const { client } = makePiClient();

    await expect(
      startSessionRun({ db, piClient: client, sessionId: 'session_corrupt_locator', userId: 'user_seed', content: 'hi' }),
    ).rejects.toThrow(); // parseLocator 的 JSON.parse 抛 SyntaxError（corrupt JSON），认领前即失败

    // 认领尚未发生：会话保持 idle，与旧行为一致（回归点：认领提前后曾会卡死在 running）
    const [session] = await db.select().from(sessions).where(eq(sessions.id, 'session_corrupt_locator')).limit(1);
    expect(session?.runtimeStatus).toBe('idle');
  });

  // ─── #7 isStreaming 守卫：safety timeout 后 agent 仍在生成 → 拒绝新 run ────
  test('#7 isStreaming guard rejects with session_busy and restores idle', async () => {
    const { db } = await setupSession({ sessionId: 'session_streaming_guard' });
    const { client, state } = makePiClient({ streaming: true });

    await expect(
      startSessionRun({ db, piClient: client, sessionId: 'session_streaming_guard', userId: 'user_seed', content: 'hi' }),
    ).rejects.toThrow('session_busy');

    // 守卫在 ensureRuntime 之后检查，runtime 确实被确保了
    expect(state.runtimeEnsured).toEqual([{
      sessionId: 'session_streaming_guard',
      cwd: '/tmp/runtime-project',
      systemPrompt: ASK_QUESTION_SYSTEM_PROMPT,
    }]);
    // 守卫抛错后 #6 的 catch 复位 DB idle
    const [session] = await db.select().from(sessions).where(eq(sessions.id, 'session_streaming_guard')).limit(1);
    expect(session?.runtimeStatus).toBe('idle');
    expect(session?.lastRuntimeError).toBeNull();

    // 守卫重新武装了 domain 回收定时器（默认 30min），取消避免污染模块级 Map
    clearIdleRuntimeCleanup('session_streaming_guard');
  });
});

describe('finalizeSessionStop', () => {
  // ─── 回归：abort 永不响应 → 超时后也得把 stopping 收敛回 idle ──────
  test('forces stopping back to idle when waitForSessionIdle never converges', async () => {
    const { db } = await setupSession({ sessionId: 'session_stop_stuck' });

    // 模拟 stop 端点已把会话置为 stopping，且 agent abort 永不响应（waitForSessionIdle 返回 false）
    await db.update(sessions)
      .set({ runtimeStatus: 'stopping', updatedAt: new Date() })
      .where(eq(sessions.id, 'session_stop_stuck'));
    const { client } = makePiClient();
    const patchedClient: PiClient = { ...client, waitForSessionIdle: async () => false };

    const statusCalls: Array<{ sessionId: string; projectId: string; runtimeStatus: 'idle' }> = [];
    await finalizeSessionStop({
      db,
      piClient: patchedClient,
      sessionId: 'session_stop_stuck',
      projectId: 'project_test_runtime',
      timeoutMs: 50,
      onRuntimeStatusChange: async (payload) => {
        statusCalls.push(payload);
      },
    });

    const [session] = await db.select().from(sessions).where(eq(sessions.id, 'session_stop_stuck')).limit(1);
    expect(session?.runtimeStatus).toBe('idle');
    expect(session?.lastRuntimeError).toBeNull();
    expect(statusCalls).toEqual([
      { sessionId: 'session_stop_stuck', projectId: 'project_test_runtime', runtimeStatus: 'idle' },
    ]);
  });

  // ─── 已非 stopping 不覆盖：期间新 run 认领为 running 时绝不能复位 ────
  test('skips finalization when session is no longer stopping (running not overwritten)', async () => {
    const { db } = await setupSession({ sessionId: 'session_stop_preserve_run' });

    // 模拟 stop 之后新 run 又认领为 running
    await db.update(sessions)
      .set({ runtimeStatus: 'running', updatedAt: new Date() })
      .where(eq(sessions.id, 'session_stop_preserve_run'));
    const { client } = makePiClient();

    let statusCalls = 0;
    await finalizeSessionStop({
      db,
      piClient: client,
      sessionId: 'session_stop_preserve_run',
      projectId: 'project_test_runtime',
      timeoutMs: 50,
      onRuntimeStatusChange: async () => {
        statusCalls++;
      },
    });

    // 条件更新（仅 stopping→idle）未命中，running 必须保持不变
    const [session] = await db.select().from(sessions).where(eq(sessions.id, 'session_stop_preserve_run')).limit(1);
    expect(session?.runtimeStatus).toBe('running');
    expect(statusCalls).toBe(0);
  });
});

// B1：pi-client 卡死兜底强杀（forced runtime dispose）后，domain 必须把会话状态收敛回 idle，
// 否则迟到的 writeback 因「父会话仍 running」而无法触发 auto-wake，结果永久躺在 DB 里（线上事故）。
// finalizeForcedRuntimeReclaim 是幂等的条件收敛：lastRunAt 护栏保证绝不覆盖已接管会话的新 run。
describe('finalizeForcedRuntimeReclaim', () => {
  const SESSION = 'session_test_runtime';
  const DISPOSED_AT = Date.parse('2026-01-01T00:10:00.000Z');

  async function seedRunningSession(overrides: {
    runtimeStatus?: string;
    lastRunAt?: Date | null;
    lastRuntimeError?: string | null;
  } = {}) {
    const { db } = await setupSession();
    await db.update(sessions).set({
      runtimeStatus: overrides.runtimeStatus ?? 'running',
      lastRunAt: overrides.lastRunAt === undefined ? new Date('2026-01-01T00:00:00.000Z') : overrides.lastRunAt,
      lastRuntimeError: overrides.lastRuntimeError === undefined ? 'stale_error' : overrides.lastRuntimeError,
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    }).where(eq(sessions.id, SESSION));
    return { db };
  }

  // 'running' 也出现：强杀收敛会广播 idle，随后补投递 run 拉起时会广播 running（前端状态刷新）
  type StatusPayload = { sessionId: string; projectId: string; runtimeStatus: 'idle' | 'running'; error: string | null };

  test('running 且 lastRunAt <= disposedAt：收敛 idle + 广播一次（payload 形状断言）', async () => {
    const { db } = await seedRunningSession({ lastRunAt: new Date('2026-01-01T00:00:00.000Z') });
    const broadcasts: StatusPayload[] = [];

    const converged = await finalizeForcedRuntimeReclaim({
      db,
      sessionId: SESSION,
      disposedAt: DISPOSED_AT,
      attempts: 3,
      noProgressMs: 1_800_000,
      onRuntimeStatusChange: async (payload) => {
        broadcasts.push(payload);
      },
    });

    expect(converged).toBe(true);
    expect(broadcasts).toEqual([{
      sessionId: SESSION,
      projectId: 'project_test_runtime',
      runtimeStatus: 'idle',
      error: null,
    }]);

    const [session] = await db.select().from(sessions).where(eq(sessions.id, SESSION)).limit(1);
    expect(session?.runtimeStatus).toBe('idle');
    expect(session?.lastRuntimeError).toBeNull();
  });

  test('running 但 lastRunAt > disposedAt（已被更新的 run 接管）：不覆盖、不广播、返回 false', async () => {
    const newerRunAt = new Date('2026-01-01T00:20:00.000Z');
    const { db } = await seedRunningSession({ lastRunAt: newerRunAt });
    const broadcasts: StatusPayload[] = [];

    const converged = await finalizeForcedRuntimeReclaim({
      db,
      sessionId: SESSION,
      disposedAt: DISPOSED_AT,
      onRuntimeStatusChange: async (payload) => {
        broadcasts.push(payload);
      },
    });

    expect(converged).toBe(false);
    expect(broadcasts).toEqual([]);

    const [session] = await db.select().from(sessions).where(eq(sessions.id, SESSION)).limit(1);
    expect(session?.runtimeStatus).toBe('running');
    expect(session?.lastRunAt?.toISOString()).toBe(newerRunAt.toISOString());
  });

  test('已 idle：skip 不广播、返回 false（不重复收敛）', async () => {
    const { db } = await seedRunningSession({ runtimeStatus: 'idle', lastRuntimeError: null });
    const broadcasts: StatusPayload[] = [];

    const converged = await finalizeForcedRuntimeReclaim({
      db,
      sessionId: SESSION,
      disposedAt: DISPOSED_AT,
      onRuntimeStatusChange: async (payload) => {
        broadcasts.push(payload);
      },
    });

    expect(converged).toBe(false);
    expect(broadcasts).toEqual([]);

    const [session] = await db.select().from(sessions).where(eq(sessions.id, SESSION)).limit(1);
    expect(session?.runtimeStatus).toBe('idle');
  });

  test('stopping：skip 不广播、返回 false（正在进行中的用户停止流程自己收尾）', async () => {
    const { db } = await seedRunningSession({ runtimeStatus: 'stopping' });
    const broadcasts: StatusPayload[] = [];

    const converged = await finalizeForcedRuntimeReclaim({
      db,
      sessionId: SESSION,
      disposedAt: DISPOSED_AT,
      onRuntimeStatusChange: async (payload) => {
        broadcasts.push(payload);
      },
    });

    expect(converged).toBe(false);
    expect(broadcasts).toEqual([]);

    const [session] = await db.select().from(sessions).where(eq(sessions.id, SESSION)).limit(1);
    expect(session?.runtimeStatus).toBe('stopping');
  });

  test('会话不存在：返回 false 且不抛（handler 不得因迟到会话被删而报错）', async () => {
    const { db } = await setupSession();
    let broadcasts = 0;

    const converged = await finalizeForcedRuntimeReclaim({
      db,
      sessionId: 'session_never_exists',
      disposedAt: DISPOSED_AT,
      onRuntimeStatusChange: async () => {
        broadcasts++;
      },
    });

    expect(converged).toBe(false);
    expect(broadcasts).toBe(0);
  });
});

// 配套加固：被强杀旧 run 的迟到 cleanup（线上实测可迟到 5 分钟）不得把新 run 的状态改成 idle，
// 也不得回收新 run 的 runtime。所有权判据 = lastRunAt（markSessionRunning 每次 run 写入），
// 绝不能用 updated_at（writeback/活动会刷新）。
describe('markSessionIdleIfRunOwned / doCleanup 所有权判定', () => {
  const SESSION = 'session_test_runtime';

  test('自身 run（lastRunAt === runStartedAt）正常收敛 idle 并写入 error/updatedAt', async () => {
    const { db } = await setupSession();
    const runStartedAt = new Date('2026-01-01T00:00:00.000Z');
    const finishedAt = new Date('2026-01-01T00:02:00.000Z');
    await db.update(sessions).set({ runtimeStatus: 'running', lastRunAt: runStartedAt, lastRuntimeError: null, updatedAt: runStartedAt }).where(eq(sessions.id, SESSION));

    const owned = await markSessionIdleIfRunOwned(db, SESSION, runStartedAt, finishedAt, 'boom');

    expect(owned).toBe(true);
    const [session] = await db.select().from(sessions).where(eq(sessions.id, SESSION)).limit(1);
    expect(session?.runtimeStatus).toBe('idle');
    expect(session?.lastRuntimeError).toBe('boom');
    expect(session?.updatedAt?.toISOString()).toBe(finishedAt.toISOString());
  });

  test('lastRunAt 已被更新的 run 推进：返回 false 且绝不覆盖新 run 的状态', async () => {
    const { db } = await setupSession();
    const oldRunStartedAt = new Date('2026-01-01T00:00:00.000Z');
    const newRunStartedAt = new Date('2026-01-01T00:05:00.000Z');
    await db.update(sessions).set({ runtimeStatus: 'running', lastRunAt: newRunStartedAt, lastRuntimeError: null, updatedAt: newRunStartedAt }).where(eq(sessions.id, SESSION));

    const owned = await markSessionIdleIfRunOwned(db, SESSION, oldRunStartedAt, new Date('2026-01-01T00:06:00.000Z'), 'late_error');

    expect(owned).toBe(false);
    const [session] = await db.select().from(sessions).where(eq(sessions.id, SESSION)).limit(1);
    expect(session?.runtimeStatus).toBe('running');
    expect(session?.lastRunAt?.toISOString()).toBe(newRunStartedAt.toISOString());
    expect(session?.lastRuntimeError).toBeNull();
  });

  // lastRunAt IS NULL 的收敛语义（刻意选保守出口，见 markSessionIdleIfRunOwned JSDoc）：
  // 不变量是「running 会话的 lastRunAt 必非 NULL」（认领即写 lastRunAt，doCleanup 必在
  // 认领与 markSessionRunning 之后），因此本用例在真实运行中不可达；
  // 一旦外部写者（如 chat 路由 vision 占位）把会话置 running 而没写 lastRunAt，
  // 所有权无法证明 → 绝不写 idle/不误覆盖（旧实现与修复后行为一致）。
  test('lastRunAt IS NULL：不视为本 run 所有（返回 false）且不写 idle/不写错误', async () => {
    const { db } = await setupSession();
    await db.update(sessions)
      .set({ runtimeStatus: 'running', lastRunAt: null, lastRuntimeError: null, updatedAt: new Date() })
      .where(eq(sessions.id, SESSION));

    const owned = await markSessionIdleIfRunOwned(db, SESSION, new Date(), new Date('2026-01-01T00:06:00.000Z'), 'boom');

    expect(owned).toBe(false);
    const [session] = await db.select().from(sessions).where(eq(sessions.id, SESSION)).limit(1);
    expect(session?.runtimeStatus).toBe('running');
    expect(session?.lastRunAt).toBeNull();
    expect(session?.lastRuntimeError).toBeNull();
  });

  // 被强杀/被接管的旧 run 迟到 cleanup 的两种出口（成功与失败）都必须完全不碰新 run。
  async function runSupersededWorker(options: { sessionId: string; sendError?: Error }) {
    const { db } = await setupSession({ sessionId: options.sessionId });
    // worker 角色：若所有权判定误判为「仍拥有会话」，doCleanup 会调用 closeRuntime（可观测）
    const workerRoleTmplId = `rt_worker_${options.sessionId}`;
    await db.insert(roleTemplates).values({
      id: workerRoleTmplId,
      key: 'worker',
      version: '1',
      name: 'Worker',
      description: 'Worker role',
      basePrompt: 'Do work.',
      configJson: '{}',
      createdBy: 'system',
      ownerType: 'system',
      visibility: 'public',
      isBuiltin: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
    await db.update(sessions).set({ roleTemplateId: workerRoleTmplId }).where(eq(sessions.id, options.sessionId));

    const oldRunStartedAt = new Date('2026-01-01T00:00:00.000Z');
    const newRunStartedAt = new Date('2026-01-01T00:01:00.000Z');
    const { client, state } = options.sendError ? makePiClient({ sendError: options.sendError }) : makePiClient();

    // 模拟「旧 run 的 sendMessage 还在途，新 run 已认领会话」：
    // 在 sendMessage 返回前把 lastRunAt 推进到更晚（新 run 的 markSessionRunning 语义）
    const baseSendMessage = client.sendMessage.bind(client);
    client.sendMessage = async (sessionId: string, content: string) => {
      await db.update(sessions).set({
        runtimeStatus: 'running',
        lastRunAt: newRunStartedAt,
        lastRuntimeError: null,
        updatedAt: newRunStartedAt,
      }).where(eq(sessions.id, sessionId));
      return baseSendMessage(sessionId, content);
    };

    const statusEvents: Array<{ runtimeStatus: 'running' | 'idle'; error: string | null }> = [];
    await startSessionRun({
      db,
      piClient: client,
      sessionId: options.sessionId,
      userId: 'user_seed',
      content: 'old run',
      startedAt: oldRunStartedAt,
      onRuntimeStatusChange: async ({ runtimeStatus, error }) => {
        statusEvents.push({ runtimeStatus, error });
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    return { db, state, statusEvents, newRunStartedAt };
  }

  test('doCleanup 端到端（成功出口）：旧 run 迟到 cleanup 不置 idle、不广播 idle、不回收新 run 的 runtime', async () => {
    const workerSessionId = 'session_worker_superseded';
    const { db, state, statusEvents, newRunStartedAt } = await runSupersededWorker({ sessionId: workerSessionId });

    // 会话仍归新 run：状态与 lastRunAt 都不得被旧 run 的 cleanup 改动
    const [session] = await db.select().from(sessions).where(eq(sessions.id, workerSessionId)).limit(1);
    expect(session?.runtimeStatus).toBe('running');
    expect(session?.lastRunAt?.toISOString()).toBe(newRunStartedAt.toISOString());
    expect(session?.lastRuntimeError).toBeNull();

    // 不广播 idle（只有启动时的 running）
    expect(statusEvents).toEqual([{ runtimeStatus: 'running', error: null }]);
    // 不回收新 run 的 runtime（避免连坐杀掉新 run）
    expect(state.closeRuntimeCalls).not.toContain(workerSessionId);
  });

  test('doCleanup 端到端（失败出口）：旧 run 迟到失败 cleanup 不 abort 新 run、不写旧 run 错误事件', async () => {
    const workerSessionId = 'session_worker_superseded_error';
    const { db, state, statusEvents } = await runSupersededWorker({
      sessionId: workerSessionId,
      sendError: new Error('old_run_failed'),
    });

    // 旧 run 的失败 cleanup 对被新 run 接管的会话不得有任何副作用：
    // abort（stopSession）会打断新 run 的在途生成，closeRuntime 会回收新 run 的 runtime
    expect(state.stopSessionCalls).not.toContain(workerSessionId);
    expect(state.closeRuntimeCalls).not.toContain(workerSessionId);
    expect(statusEvents).toEqual([{ runtimeStatus: 'running', error: null }]);

    // 旧 run 的错误事件不得写进已归新 run 的会话
    const events = await db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, workerSessionId));
    expect(events.filter((e) => e.type === 'chat_runtime_error')).toHaveLength(0);
  });

  // ─── R1 blocker 回归：认领窗口（原子认领已生效、markSessionRunning 尚未执行）──────
  // 旧实现：原子认领只写 runtimeStatus/updatedAt，lastRunAt 仍停在旧 run 的认领时刻 →
  // 窗口内旧 run 的迟到 cleanup 只查 lastRunAt → 被误判为「仍是所有者」→
  // 对**新 run** 执行 stopSession(abort) + 广播陈旧 idle + 写陈旧 chat_runtime_error。
  // 可达性：B1 强杀后会话提前变 idle → 新 run（auto-wake/用户消息）毫秒级认领并在 runtime
  // 刚被回收时走 ensureRuntime 重建（秒级窗口），而旧 run 的 prompt 要等它在途 tool
  // （如每 2s 轮询父会话状态的 wait 循环）落定后才走 doCleanup → 必然晚于认领。
  test('R1 blocker：认领即写 lastRunAt，认领窗口内 run 身份已切换（旧实现窗口内仍是旧值/null）', async () => {
    const sessionId = 'session_claim_window_identity';
    const { db } = await setupSession({ sessionId, roleTemplateId: 'role_worker' });
    const { client, state } = makePiClient();
    const newStartedAt = new Date();
    let ensureEntered = false;
    const delayedClient: PiClient = {
      ...client,
      ensureRuntime: async (sid, options) => {
        ensureEntered = true;
        // 慢 ensureRuntime：runtime 刚被强杀回收，重建耗时长，窗口敞开可观测
        await Bun.sleep(400);
        await client.ensureRuntime(sid, options);
      },
      // 新 run 停在 sendMessage：不产生 doCleanup，窗口内容与状态稳定可观测
      sendMessage: () => new Promise<never>(() => {}),
    };

    try {
      void startSessionRun({
        db, piClient: delayedClient, sessionId, userId: 'user_seed', content: 'new run',
        startedAt: newStartedAt, safetyTimeoutMs: 60_000,
        onRuntimeStatusChange: async () => {},
      }).catch(() => {});

      // 等到 ensureRuntime 已进入（认领先于它执行）
      expect(await waitUntil(() => ensureEntered)).toBe(true);
      const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      expect(row?.runtimeStatus).toBe('running');
      // 修复点：认领即写 lastRunAt（不变量：running 会话的 lastRunAt 必然由某个 run 的认领写入）
      expect(row?.lastRunAt?.toISOString()).toBe(newStartedAt.toISOString());
      // 仍在窗口内：markSessionRunning/ sendMessage 都还没发生
      expect(state.sent).toHaveLength(0);
      expect(row?.lastRuntimeError).toBeNull();
    } finally {
      // 新 run 永不结束（pending sendMessage）→ 取消 domain 回收定时器避免污染模块级 Map
      clearIdleRuntimeCleanup(sessionId);
    }
  });

  // B1 同源衍生（同一个认领窗口的另一条受害者）：强杀通知是 `void notifyForcedRuntimeDispose(...)`
  // 异步落库的，而新 run 可以毫秒级认领 —— 通知到达时 disposedAt（强杀时刻）已早于本次认领。
  // 修复前窗口内 lastRunAt 仍是旧值 → `lte(lastRunAt, disposedAt)` 成立 → 把**新 run** 收敛成
  // idle（新 run 仍在跑但 DB 已 idle，甚至可被后续请求重复认领）。认领即写 lastRunAt 后护栏才真正覆盖该窗口。
  test('R1 blocker 衍生：陈旧强杀通知落在认领窗口内不得把新 run 收敛为 idle', async () => {
    const sessionId = 'session_claim_window_stale_notify';
    const { db } = await setupSession({ sessionId, roleTemplateId: 'role_worker' });
    const { client } = makePiClient();
    const newStartedAt = new Date();
    // 会话此前已跑过 run（真实场景：父会话已等过一轮子会话）：窗口内 lastRunAt 是**旧 run 的非 NULL 值**
    const priorRunAt = new Date(newStartedAt.getTime() - 10 * 60_000);
    await db.update(sessions)
      .set({ lastRunAt: priorRunAt, updatedAt: priorRunAt })
      .where(eq(sessions.id, sessionId));
    let ensureEntered = false;
    const delayedClient: PiClient = {
      ...client,
      ensureRuntime: async (sid, options) => {
        ensureEntered = true;
        await Bun.sleep(400);
        await client.ensureRuntime(sid, options);
      },
      sendMessage: () => new Promise<never>(() => {}),
    };

    try {
      void startSessionRun({
        db, piClient: delayedClient, sessionId, userId: 'user_seed', content: 'new run',
        startedAt: newStartedAt, safetyTimeoutMs: 60_000,
        onRuntimeStatusChange: async () => {},
      }).catch(() => {});
      expect(await waitUntil(() => ensureEntered)).toBe(true);

      // disposedAt 比本次认领早 1ms：模拟「旧 runtime 早已 dispose、通知现在才落库」
      const converged = await finalizeForcedRuntimeReclaim({ db, sessionId, disposedAt: newStartedAt.getTime() - 1 });
      expect(converged).toBe(false);

      const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      expect(row?.runtimeStatus).toBe('running');
      expect(row?.lastRunAt?.toISOString()).toBe(newStartedAt.toISOString());
    } finally {
      clearIdleRuntimeCleanup(sessionId);
    }
  });

  test('R1 blocker：旧 run 迟到 cleanup 落在认领窗口内 → 完全不碰新 run（不 abort/不广播/不写错误/不回收）', async () => {
    const sessionId = 'session_worker_claim_window';
    const { db } = await setupSession({ sessionId, roleTemplateId: 'role_worker' });

    // 1) 旧 run：sendMessage 挂起（模拟强杀后旧 run 的在途 tool 仍在等子会话 writeback）
    const oldStartedAt = new Date(Date.now() - 10 * 60_000);
    const { client: oldClient, state: oldState } = makePiClient();
    let releaseOldRun!: (err: Error) => void;
    const oldSendGate = new Promise<never>((_, reject) => { releaseOldRun = reject; });
    const gatedOldClient: PiClient = {
      ...oldClient,
      sendMessage: async (sid, content) => {
        oldState.sent.push({ sessionId: sid, content });
        return oldSendGate;
      },
    };
    const oldBroadcasts: Array<{ runtimeStatus: 'running' | 'idle'; error: string | null }> = [];
    await startSessionRun({
      db, piClient: gatedOldClient, sessionId, userId: 'user_seed', content: 'old run',
      startedAt: oldStartedAt, safetyTimeoutMs: 60_000,
      onRuntimeStatusChange: async ({ runtimeStatus, error }) => { oldBroadcasts.push({ runtimeStatus, error }); },
    });
    expect(await waitUntil(() => oldState.sent.length === 1)).toBe(true);

    // 2) B1：卡死兜底强杀 → domain 把会话收敛回 idle（lastRunAt 停在旧 run 的认领时刻）
    expect(await finalizeForcedRuntimeReclaim({ db, sessionId, disposedAt: Date.now() })).toBe(true);

    // 3) 新 run：ensureRuntime 慢 500ms → 认领后长时间停在「认领 → markSessionRunning」窗口
    const newStartedAt = new Date();
    const { client: newClient, state: newState } = makePiClient();
    const gatedNewClient: PiClient = {
      ...newClient,
      ensureRuntime: async (sid, options) => {
        // 800ms：窗口足够宽，慢 CI 上「窗口内观测」也不会滑到 markSessionRunning 之后
        await Bun.sleep(800);
        await newClient.ensureRuntime(sid, options);
      },
      sendMessage: () => new Promise<never>(() => {}),
    };
    const newBroadcasts: Array<{ runtimeStatus: 'running' | 'idle'; error: string | null }> = [];
    void startSessionRun({
      db, piClient: gatedNewClient, sessionId, userId: 'user_seed', content: 'new run',
      startedAt: newStartedAt, safetyTimeoutMs: 60_000,
      onRuntimeStatusChange: async ({ runtimeStatus, error }) => { newBroadcasts.push({ runtimeStatus, error }); },
    }).catch(() => {});

    // 等新 run 的原子认领生效（仍停在 ensureRuntime 内 → 窗口敞开）
    expect(await waitUntil(async () => {
      const [row] = await db.select({ status: sessions.runtimeStatus }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      return row?.status === 'running';
    })).toBe(true);
    expect(newState.sent).toHaveLength(0);
    // 认领窗口内：markSessionRunning / running 广播都还没发生（证明下面旧 run 的 cleanup 确实落在窗口内）
    expect(newBroadcasts).toEqual([]);

    try {
      // 4) 旧 run 的 sendMessage 落定（失败出口）→ 迟到 cleanup 立即执行（落在窗口内）
      releaseOldRun(new Error('old_run_failed_after_forced_reclaim'));
      // unsubscribe 在所有权判定之后、一切副作用之前：它出现即证明判定已完成
      expect(await waitUntil(() => oldState.unsubscribed.includes(sessionId))).toBe(true);

      // 负向断言的宽限窗口：修复后这些副作用一次都不会出现；
      // 一旦出现立即退出循环，交给下方断言报失败（固定 sleep 之外再留足余量，慢 CI 不 flake）。
      const quietDeadline = Date.now() + 300;
      while (Date.now() < quietDeadline) {
        const staleSideEffect = oldState.stopSessionCalls.includes(sessionId)
          || oldState.closeRuntimeCalls.includes(sessionId)
          || oldBroadcasts.some((b) => b.runtimeStatus === 'idle')
          || newBroadcasts.some((b) => b.runtimeStatus === 'idle');
        if (staleSideEffect) break;
        await Bun.sleep(10);
      }

      // 窗口内视角（新 run 尚未走完启动，lastRunAt 仍应是认领写入的值）：
      // 1) 不 abort 新 run；2) 不广播陈旧 idle；3) 不写陈旧 chat_runtime_error；
      // 4) 新 run 仍是所有者（runtimeStatus/lastRunAt/lastRuntimeError 都不被旧 run 改动）；
      // 5) 不回收新 run 的 runtime。汇总成单次断言：修复前一次性展示全部副作用
      // （分条 expect 只会报第一个）。
      const events = await db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, sessionId));
      const [inWindow] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      expect({
        stopSessionCalls: oldState.stopSessionCalls,
        closeRuntimeCalls: oldState.closeRuntimeCalls,
        oldIdleBroadcasts: oldBroadcasts.filter((b) => b.runtimeStatus === 'idle'),
        newIdleBroadcasts: newBroadcasts.filter((b) => b.runtimeStatus === 'idle'),
        staleErrorEvents: events.filter((e) => e.type === 'chat_runtime_error').length,
        runtimeStatus: inWindow?.runtimeStatus,
        lastRunAt: inWindow?.lastRunAt?.toISOString(),
        lastRuntimeError: inWindow?.lastRuntimeError,
      }).toEqual({
        stopSessionCalls: [],
        closeRuntimeCalls: [],
        oldIdleBroadcasts: [],
        newIdleBroadcasts: [],
        staleErrorEvents: 0,
        runtimeStatus: 'running',
        lastRunAt: newStartedAt.toISOString(),
        lastRuntimeError: null,
      });

      // 分条重申（保持逐项断言的强度与可读性，避免汇总对象被重构时漏项）
      expect(oldState.stopSessionCalls).not.toContain(sessionId);
      expect(oldState.closeRuntimeCalls).not.toContain(sessionId);
      expect(oldBroadcasts).toEqual([{ runtimeStatus: 'running', error: null }]);
      expect(newBroadcasts).toEqual([]);
      expect(events.filter((e) => e.type === 'chat_runtime_error')).toHaveLength(0);
      expect(inWindow?.runtimeStatus).toBe('running');
      expect(inWindow?.lastRunAt?.toISOString()).toBe(newStartedAt.toISOString());
      expect(inWindow?.lastRuntimeError).toBeNull();

      // 新 run 继续走完启动（ensureRuntime 800ms → markSessionRunning → running 广播）：
      // 旧 run 的迟到 cleanup 不得打断它，也不得留下任何陈旧副作用
      expect(await waitUntil(() => newBroadcasts.some((b) => b.runtimeStatus === 'running'))).toBe(true);
      const [afterStartup] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      expect(newBroadcasts).toEqual([{ runtimeStatus: 'running', error: null }]);
      expect(afterStartup?.runtimeStatus).toBe('running');
      expect(afterStartup?.lastRunAt?.toISOString()).toBe(newStartedAt.toISOString());
      expect(afterStartup?.lastRuntimeError).toBeNull();
    } finally {
      clearIdleRuntimeCleanup(sessionId);
    }
  });

});

/**
 * ① 补投递（rescan）与 ② 强杀审计事件。
 *
 * 场景来源（线上事故）：Worker A 的 writeback 在 13:58:34 落库（父会话当时仍 running，
 * 其消费者=当时在跑的 wait 循环），父会话 13:59:36 被卡死兜底强杀 → 该条 writeback
 * 再也没有任何消费者（事后到达的 writeback 有 auto-wake 兜底，这条「强杀前已落库」的没有）。
 * 因此强杀收敛时重扫「被杀那次 run 窗口 [lastRunAt, disposedAt]」内的 writeback 并补投给父会话。
 */
describe('forced reclaim 补投递（rescan stranded writebacks）', () => {
  const SESSION = 'session_test_runtime';
  const RUN_STARTED_AT = new Date('2026-01-01T00:00:00.000Z');
  const DISPOSED_AT = Date.parse('2026-01-01T00:10:00.000Z');

  async function seedParent(options: {
    writebacks?: Array<{ summary: string; at: number; source?: string; blocks?: unknown }>;
    status?: string;
    lastRunAt?: Date | null;
    runtimeStatus?: string;
  } = {}) {
    const { db } = await setupSession();
    await db.update(sessions).set({
      runtimeStatus: options.runtimeStatus ?? 'running',
      status: options.status ?? 'active',
      lastRunAt: options.lastRunAt === undefined ? RUN_STARTED_AT : options.lastRunAt,
      lastRuntimeError: 'stale_error',
      updatedAt: RUN_STARTED_AT,
    }).where(eq(sessions.id, SESSION));

    for (const [i, wb] of (options.writebacks ?? []).entries()) {
      await db.insert(messages).values({
        id: `msg_stranded_${i}`,
        sessionId: SESSION,
        piMessageId: null,
        messageKind: 'writeback',
        sourceSessionId: wb.source ?? `session_child_${i}`,
        role: 'assistant',
        contentText: wb.summary,
        contentBlocksJson: wb.blocks ? JSON.stringify(wb.blocks) : null,
        contentVersion: 1,
        requestId: `req_child_${i}`,
        createdAt: new Date(wb.at),
      } as any);
    }
    return { db };
  }

  async function readReclaimEvents(db: TestDb) {
    const rows = await db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, SESSION));
    return rows.filter((e) => e.type === 'runtime_forced_reclaim').map((e) => JSON.parse(e.payload));
  }

  test('收敛后补投递窗口内的 writeback（带醒目标记）并写审计事件', async () => {
    const { db } = await seedParent({
      writebacks: [
        { summary: 'Worker A 完成：后端 tag 端点', at: Date.parse('2026-01-01T00:05:00.000Z'), source: 'session_child_a' },
        { summary: 'Worker B 完成：前端切换 UI', at: Date.parse('2026-01-01T00:06:00.000Z'), source: 'session_child_b', blocks: [{ type: 'text', text: 'done' }] },
      ],
    });
    const { client, state } = makePiClient();

    try {
      const converged = await finalizeForcedRuntimeReclaim({
        db,
        sessionId: SESSION,
        disposedAt: DISPOSED_AT,
        attempts: 40,
        noProgressMs: 1_800_000,
        piClient: client,
      });
      expect(converged).toBe(true);

      // 补投递：父会话被拉起，内容包含两条 summary、来源会话与醒目标记
      expect(await waitUntil(() => state.sent.some((s) => s.sessionId === SESSION))).toBe(true);
      const replayed = state.sent.find((s) => s.sessionId === SESSION)!;
      expect(replayed.content).toContain('补投递');
      expect(replayed.content).toContain('Worker A 完成：后端 tag 端点');
      expect(replayed.content).toContain('Worker B 完成：前端切换 UI');
      expect(replayed.content).toContain('session_child_a');
      expect(replayed.content).toContain('session_child_b');
      // blocks 不丢：结构化内容一并补投
      expect(replayed.content).toContain('done');

      // ② 审计事件可查
      const events = await readReclaimEvents(db);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        result: 'converged',
        disposed_at: new Date(DISPOSED_AT).toISOString(),
        attempts: 40,
        no_progress_ms: 1_800_000,
        last_run_at: RUN_STARTED_AT.toISOString(),
        stranded_writebacks: 2,
        wake_result: 'started',
      });
    } finally {
      clearIdleRuntimeCleanup(SESSION);
    }
  });

  test('强杀之后、收敛之前落库的 writeback 仍会补投递（当时 auto-wake 看到 running 会跳过）', async () => {
    // disposedAt 到 hook 实际收敛之间有时间差（fire-and-forget），这段窗口内落库的 writeback
    // 既不在「对杀前」也不在「收敛后」，只靠 auto-wake 会被跳过 → 必须由补投递接住。
    const { db } = await seedParent({
      writebacks: [{ summary: '强杀之后、收敛之前到达的 writeback', at: DISPOSED_AT + 60_000 }],
    });
    const { client, state } = makePiClient();

    try {
      expect(await finalizeForcedRuntimeReclaim({
        db, sessionId: SESSION, disposedAt: DISPOSED_AT, piClient: client,
      })).toBe(true);
      expect(await waitUntil(() => state.sent.some((s) => s.sessionId === SESSION))).toBe(true);
      expect(state.sent[0].content).toContain('强杀之后、收敛之前到达的 writeback');

      const events = await readReclaimEvents(db);
      expect(events[0]).toMatchObject({ result: 'converged', stranded_writebacks: 1, wake_result: 'started' });
    } finally {
      clearIdleRuntimeCleanup(SESSION);
    }
  });

  test('窗口上界：收敛之后落库的 writeback 不补投递（由它自己的 auto-wake 负责）', async () => {
    // 收敛（=本次 finalize 执行）之后才落库的写回，其 auto-wake 必然读到 idle → 由那条路径负责。
    const futureAt = Date.now() + 60_000;
    const { db } = await seedParent({
      writebacks: [{ summary: '收敛之后才到达的 writeback', at: futureAt }],
    });
    const { client, state } = makePiClient();

    try {
      const converged = await finalizeForcedRuntimeReclaim({
        db, sessionId: SESSION, disposedAt: DISPOSED_AT, piClient: client,
      });
      expect(converged).toBe(true);
      expect(await confirmNever(() => state.sent.length > 0)).toBe(true);

      const events = await readReclaimEvents(db);
      expect(events[0]).toMatchObject({ result: 'converged', stranded_writebacks: 0, wake_result: 'not_attempted' });
    } finally {
      clearIdleRuntimeCleanup(SESSION);
    }
  });

  test('无 writeback 时不拉起（审计记录 stranded=0 / wake_result=not_attempted）', async () => {
    const { db } = await seedParent();
    const { client, state } = makePiClient();

    try {
      expect(await finalizeForcedRuntimeReclaim({ db, sessionId: SESSION, disposedAt: DISPOSED_AT, piClient: client })).toBe(true);
      expect(await confirmNever(() => state.sent.length > 0)).toBe(true);
      expect(await readReclaimEvents(db)).toHaveLength(1);
    } finally {
      clearIdleRuntimeCleanup(SESSION);
    }
  });

  test('已归档父会话不补投递（仍写审计事件）', async () => {
    const { db } = await seedParent({
      status: 'archived',
      writebacks: [{ summary: '归档会话的遗留 writeback', at: Date.parse('2026-01-01T00:05:00.000Z') }],
    });
    const { client, state } = makePiClient();

    try {
      expect(await finalizeForcedRuntimeReclaim({ db, sessionId: SESSION, disposedAt: DISPOSED_AT, piClient: client })).toBe(true);
      expect(await confirmNever(() => state.sent.length > 0)).toBe(true);
      const events = await readReclaimEvents(db);
      expect(events[0]).toMatchObject({
        result: 'converged',
        stranded_writebacks: 1,
        wake_result: 'not_attempted',
        skip_reason: 'not_replayable',
      });
    } finally {
      clearIdleRuntimeCleanup(SESSION);
    }
  });

  test('补投递失败不外抛（运行时不可用）：finalize 仍返回 true 且审计 wake_result=failed', async () => {
    const previousRetry = process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS;
    const previousAttempts = process.env.PIPLUS_FORCED_RECLAIM_REPLAY_ATTEMPTS;
    // failed 也消耗重试预算（覆盖 SQLITE_BUSY 等瞬态错误）→ 测试用极小值驱动，避免等默认 30s 间隔
    process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS = '5';
    process.env.PIPLUS_FORCED_RECLAIM_REPLAY_ATTEMPTS = '2';
    const { db } = await seedParent({
      writebacks: [{ summary: '运行时不可用时的遗留 writeback', at: Date.parse('2026-01-01T00:05:00.000Z') }],
    });
    const { client } = makePiClient({ ensureRuntimeError: new Error('pi_session_runtime_unavailable') });

    try {
      expect(await finalizeForcedRuntimeReclaim({ db, sessionId: SESSION, disposedAt: DISPOSED_AT, piClient: client })).toBe(true);
      const events = await readReclaimEvents(db);
      expect(events[0]).toMatchObject({
        result: 'converged',
        stranded_writebacks: 1,
        wake_result: 'failed',
        skip_reason: 'retries_exhausted',
      });
    } finally {
      if (previousRetry === undefined) delete process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS;
      else process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS = previousRetry;
      if (previousAttempts === undefined) delete process.env.PIPLUS_FORCED_RECLAIM_REPLAY_ATTEMPTS;
      else process.env.PIPLUS_FORCED_RECLAIM_REPLAY_ATTEMPTS = previousAttempts;
      clearIdleRuntimeCleanup(SESSION);
    }
  });

  test('skipped_newer_run：不覆盖新 run、不补投递，但写审计事件', async () => {
    const newerRunStartedAt = new Date(DISPOSED_AT + 60_000);
    const { db } = await seedParent({
      lastRunAt: newerRunStartedAt,
      writebacks: [{ summary: '旧 run 窗口内的 writeback', at: Date.parse('2026-01-01T00:05:00.000Z') }],
    });
    const { client, state } = makePiClient();

    try {
      expect(await finalizeForcedRuntimeReclaim({ db, sessionId: SESSION, disposedAt: DISPOSED_AT, piClient: client })).toBe(false);
      expect(await confirmNever(() => state.sent.length > 0)).toBe(true);

      const [session] = await db.select().from(sessions).where(eq(sessions.id, SESSION)).limit(1);
      expect(session?.runtimeStatus).toBe('running');
      expect(session?.lastRunAt?.toISOString()).toBe(newerRunStartedAt.toISOString());

      const events = await readReclaimEvents(db);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ result: 'skipped_newer_run', stranded_writebacks: null, wake_result: 'not_attempted' });
    } finally {
      clearIdleRuntimeCleanup(SESSION);
    }
  });

  // ─── 审查发现 L1：会话已 idle（旧 run 的 doCleanup 抢先收敛，hook 慢到）时也必须补投 ───
  test('会话已被旧 run 的 doCleanup 抢先收敛为 idle：仍补投递（不能由「谁先落 idle」决定是否补投）', async () => {
    const { db } = await seedParent({
      runtimeStatus: 'idle',
      writebacks: [{ summary: 'doCleanup 抢先收敛时被困住的 writeback', at: Date.parse('2026-01-01T00:05:00.000Z') }],
    });
    const { client, state } = makePiClient();

    try {
      // 会话已 idle → 不收敛（返回 false），但补投递照常发生
      expect(await finalizeForcedRuntimeReclaim({ db, sessionId: SESSION, disposedAt: DISPOSED_AT, piClient: client })).toBe(false);
      expect(await waitUntil(() => state.sent.some((s) => s.sessionId === SESSION))).toBe(true);
      expect(state.sent[0].content).toContain('补投递');
      expect(state.sent[0].content).toContain('doCleanup 抢先收敛时被困住的 writeback');

      const events = await readReclaimEvents(db);
      expect(events[0]).toMatchObject({ result: 'skipped_not_running', stranded_writebacks: 1, wake_result: 'started' });
    } finally {
      clearIdleRuntimeCleanup(SESSION);
    }
  });

  test('会话已 idle 但已被更新的 run 接管（lastRunAt > disposedAt）：不补投，让位给新 run', async () => {
    const newerRunStartedAt = new Date(DISPOSED_AT + 60_000);
    const { db } = await seedParent({
      runtimeStatus: 'idle',
      lastRunAt: newerRunStartedAt,
      writebacks: [{ summary: '新 run 窗口内、不属于旧 run 的写回', at: DISPOSED_AT + 120_000 }],
    });
    const { client, state } = makePiClient();

    try {
      expect(await finalizeForcedRuntimeReclaim({ db, sessionId: SESSION, disposedAt: DISPOSED_AT, piClient: client })).toBe(false);
      expect(await confirmNever(() => state.sent.length > 0)).toBe(true);
      const events = await readReclaimEvents(db);
      expect(events[0]).toMatchObject({ result: 'skipped_not_running', stranded_writebacks: null, wake_result: 'not_attempted' });
    } finally {
      clearIdleRuntimeCleanup(SESSION);
    }
  });

  // ─── 审查发现 L3：一次 session_busy 不得丢掉整包被困回写 ───
  test('并发认领导致 session_busy 时有界重试：第二次成功投出', async () => {
    const previousRetry = process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS;
    process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS = '5';
    const { db } = await seedParent({
      writebacks: [{ summary: 'busy 之后仍应被投出的 writeback', at: Date.parse('2026-01-01T00:05:00.000Z') }],
    });
    const { client, state } = makePiClient();
    let ensureCalls = 0;
    const baseEnsure = client.ensureRuntime.bind(client);
    client.ensureRuntime = async (sessionId: string, options: Parameters<typeof baseEnsure>[1]) => {
      ensureCalls += 1;
      // 第一次模拟「原子认领被并发 runner 抢到」→ startSessionRun 抛 session_busy 被吞成 skipped
      if (ensureCalls === 1) throw new Error('session_busy');
      return baseEnsure(sessionId, options);
    };

    try {
      expect(await finalizeForcedRuntimeReclaim({ db, sessionId: SESSION, disposedAt: DISPOSED_AT, piClient: client })).toBe(true);
      expect(await waitUntil(() => state.sent.some((s) => s.sessionId === SESSION))).toBe(true);
      expect(ensureCalls).toBe(2);
      expect(state.sent[0].content).toContain('busy 之后仍应被投出的 writeback');
      const events = await readReclaimEvents(db);
      expect(events[0]).toMatchObject({ result: 'converged', stranded_writebacks: 1, wake_result: 'started' });
    } finally {
      if (previousRetry === undefined) delete process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS;
      else process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS = previousRetry;
      clearIdleRuntimeCleanup(SESSION);
    }
  });

  test('重试耗尽仍 busy：审计 wake_result=skipped（不静默丢失，可从 session_events 发现）', async () => {
    const previousRetry = process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS;
    const previousAttempts = process.env.PIPLUS_FORCED_RECLAIM_REPLAY_ATTEMPTS;
    process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS = '5';
    process.env.PIPLUS_FORCED_RECLAIM_REPLAY_ATTEMPTS = '2';
    const { db } = await seedParent({
      writebacks: [{ summary: '始终 busy 的 writeback', at: Date.parse('2026-01-01T00:05:00.000Z') }],
    });
    const { client, state } = makePiClient();
    let ensureCalls = 0;
    client.ensureRuntime = async () => {
      ensureCalls += 1;
      throw new Error('session_busy');
    };

    try {
      expect(await finalizeForcedRuntimeReclaim({ db, sessionId: SESSION, disposedAt: DISPOSED_AT, piClient: client })).toBe(true);
      expect(await confirmNever(() => state.sent.length > 0)).toBe(true);
      // 有界：尝试次数 = env attempts
      expect(ensureCalls).toBe(2);
      const events = await readReclaimEvents(db);
      expect(events[0]).toMatchObject({
        result: 'converged',
        stranded_writebacks: 1,
        wake_result: 'skipped',
        skip_reason: 'retries_exhausted',
      });
    } finally {
      if (previousRetry === undefined) delete process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS;
      else process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS = previousRetry;
      if (previousAttempts === undefined) delete process.env.PIPLUS_FORCED_RECLAIM_REPLAY_ATTEMPTS;
      else process.env.PIPLUS_FORCED_RECLAIM_REPLAY_ATTEMPTS = previousAttempts;
      clearIdleRuntimeCleanup(SESSION);
    }
  });

  // R1 [major] 回归：并发 run（用户消息 / 其它 writeback 的 auto-wake）正占着会话时，
  // 旧实现第一次 gate 检查就 return skipped（整包丢弃）；现在让位并继续重试，会话释放后投出。
  test('会话被并发 run 占用时让位重试，释放后投出（不再一次 busy 丢弃整包）', async () => {
    const previousRetry = process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS;
    const previousAttempts = process.env.PIPLUS_FORCED_RECLAIM_REPLAY_ATTEMPTS;
    process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS = '30';
    process.env.PIPLUS_FORCED_RECLAIM_REPLAY_ATTEMPTS = '5';
    const { db } = await seedParent({
      writebacks: [{ summary: '并发 run 释放后应投出的 writeback', at: Date.parse('2026-01-01T00:05:00.000Z') }],
    });
    const { client, state } = makePiClient();
    let releasedResolve!: () => void;
    const released = new Promise<void>((resolve) => { releasedResolve = resolve; });

    try {
      const converged = await finalizeForcedRuntimeReclaim({
        db,
        sessionId: SESSION,
        disposedAt: DISPOSED_AT,
        piClient: client,
        // 收敛 idle 广播的这一刻模拟「另一个 run 抢先把会话认领走」，并在 ~10ms 后释放
        onRuntimeStatusChange: async () => {
          await db.update(sessions)
            .set({ runtimeStatus: 'running', lastRunAt: new Date(), updatedAt: new Date() })
            .where(eq(sessions.id, SESSION));
          setTimeout(() => {
            void db.update(sessions)
              .set({ runtimeStatus: 'idle', updatedAt: new Date() })
              .where(eq(sessions.id, SESSION))
              .then(() => releasedResolve());
          }, 10);
        },
      });
      expect(converged).toBe(true);
      await released;

      // 让位后重试命中：内容最终投出（旧实现会在第一次 gate 就 return skipped）
      expect(await waitUntil(() => state.sent.some((s) => s.sessionId === SESSION))).toBe(true);
      expect(state.sent[0].content).toContain('并发 run 释放后应投出的 writeback');

      const events = await readReclaimEvents(db);
      expect(events[0]).toMatchObject({
        result: 'converged',
        stranded_writebacks: 1,
        wake_result: 'started',
        skip_reason: null,
      });
    } finally {
      if (previousRetry === undefined) delete process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS;
      else process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS = previousRetry;
      if (previousAttempts === undefined) delete process.env.PIPLUS_FORCED_RECLAIM_REPLAY_ATTEMPTS;
      else process.env.PIPLUS_FORCED_RECLAIM_REPLAY_ATTEMPTS = previousAttempts;
      clearIdleRuntimeCleanup(SESSION);
    }
  });

  test('整个预算内会话都被占用：审计 skip_reason=session_not_idle（与 retries_exhausted 区分）', async () => {
    const previousRetry = process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS;
    const previousAttempts = process.env.PIPLUS_FORCED_RECLAIM_REPLAY_ATTEMPTS;
    process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS = '5';
    process.env.PIPLUS_FORCED_RECLAIM_REPLAY_ATTEMPTS = '2';
    const { db } = await seedParent({
      writebacks: [{ summary: '全程被占用时被困的 writeback', at: Date.parse('2026-01-01T00:05:00.000Z') }],
    });
    const { client, state } = makePiClient();

    try {
      // 收敛广播这一刻起会话一直被并发 run 占用（模拟用户消息/其它 auto-wake 长期占着）
      expect(await finalizeForcedRuntimeReclaim({
        db,
        sessionId: SESSION,
        disposedAt: DISPOSED_AT,
        piClient: client,
        onRuntimeStatusChange: async () => {
          await db.update(sessions)
            .set({ runtimeStatus: 'running', lastRunAt: new Date(), updatedAt: new Date() })
            .where(eq(sessions.id, SESSION));
        },
      })).toBe(true);

      expect(await confirmNever(() => state.sent.length > 0)).toBe(true);
      const events = await readReclaimEvents(db);
      expect(events[0]).toMatchObject({
        result: 'converged',
        stranded_writebacks: 1,
        wake_result: 'skipped',
        skip_reason: 'session_not_idle',
      });
    } finally {
      if (previousRetry === undefined) delete process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS;
      else process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS = previousRetry;
      if (previousAttempts === undefined) delete process.env.PIPLUS_FORCED_RECLAIM_REPLAY_ATTEMPTS;
      else process.env.PIPLUS_FORCED_RECLAIM_REPLAY_ATTEMPTS = previousAttempts;
      clearIdleRuntimeCleanup(SESSION);
    }
  });

  test('审计两阶段写：补投递进行中就能查到 pending 行（进程重启不丢「何时强杀过」的证据）', async () => {
    const { db } = await seedParent({
      writebacks: [{ summary: '两阶段审计用例的 writeback', at: Date.parse('2026-01-01T00:05:00.000Z') }],
    });
    const { client, state } = makePiClient();
    let releaseEnsure!: () => void;
    const ensureGate = new Promise<void>((resolve) => { releaseEnsure = resolve; });
    const baseEnsure = client.ensureRuntime.bind(client);
    let ensureEntered = false;
    client.ensureRuntime = async (sessionId: string, options: Parameters<typeof baseEnsure>[1]) => {
      ensureEntered = true;
      await ensureGate; // 把补投递 run 卡在启动阶段，以便观测 pending 行
      return baseEnsure(sessionId, options);
    };

    try {
      const finalizePromise = finalizeForcedRuntimeReclaim({
        db, sessionId: SESSION, disposedAt: DISPOSED_AT, piClient: client,
      });
      expect(await waitUntil(() => ensureEntered)).toBe(true);

      // 补投递尚未完成：审计行已存在且是 pending
      const during = await readReclaimEvents(db);
      expect(during).toHaveLength(1);
      expect(during[0]).toMatchObject({ result: 'converged', wake_result: 'pending' });

      releaseEnsure();
      expect(await finalizePromise).toBe(true);

      // 完成后同一行被更新为最终结果（不新增第二行）
      const after = await readReclaimEvents(db);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({
        result: 'converged',
        stranded_writebacks: 1,
        wake_result: 'started',
        skip_reason: null,
      });
      expect(await waitUntil(() => state.sent.some((s) => s.sessionId === SESSION))).toBe(true);
    } finally {
      clearIdleRuntimeCleanup(SESSION);
    }
  });

});

/**
 * L2 闭环：run 结束（收敛 idle）时回扫「本次 run 期间到达、却没有任何消费者」的 writeback 并补投。
 * 覆盖：wait=false 子会话在父忙时 writeback、wait 循环已退出后子才 writeback 等
 * ——旧实现里这些写回永久搁置（无 wait 循环匹配、auto-wake 因父非 idle 跳过、此后无人回看）。
 */
describe('run 结束回扫未消费 writeback（L2 闭环）', () => {
  const PARENT = 'session_test_runtime';
  const CHILD = 'session_child_l2';

  async function seedChild(db: TestDb) {
    const now = new Date('2026-01-01T00:00:00.000Z');
    await db.insert(sessions).values({
      id: CHILD,
      projectId: 'project_test_runtime',
      parentSessionId: PARENT,
      rootSessionId: PARENT,
      depth: 1,
      roleTemplateId: 'rt_blank',
      piSessionId: 'pi_session_child_l2',
      piSessionLocatorJson: stringifyLocator({ piSessionId: 'pi_session_child_l2', sessionFile: '/tmp/pi-child-l2.jsonl' }),
      requestedByMessageId: null,
      title: 'Child',
      titleSource: 'default',
      status: 'active',
      runtimeStatus: 'idle',
      currentModelProvider: null,
      currentModelId: null,
      lastActivityAt: now,
      lastRunAt: null,
      lastStopAt: null,
      lastRuntimeError: null,
      createdBy: 'user_seed',
      archivedAt: null,
      archivedBy: null,
      createdAt: now,
      updatedAt: now,
      roleBasePromptSnapshot: 'base',
      userSuppliedPrompt: '',
      parentSuppliedPrompt: '',
      compiledPrompt: 'compiled',
    } as any);
  }

  async function readConsumedMarkers(db: TestDb) {
    const rows = await db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, PARENT));
    return rows
      .filter((e) => e.type === 'writeback_consumed')
      .map((e) => JSON.parse(e.payload) as { message_id: string; via: string });
  }

  test('父忙时到达的 writeback 在 run 结束时被补投 + 写消费标记（旧实现下永久搁置）', async () => {
    const { db } = await setupSession();
    await seedChild(db);
    const { client, state } = makePiClient();
    let injected = false;
    const baseSend = client.sendMessage.bind(client);
    client.sendMessage = async (sessionId: string, content: string, options?: Parameters<typeof baseSend>[2]) => {
      // 第一次 sendMessage = 「本轮 run 自己」；在其执行期间模拟子会话 writeback 到达
      // （走真实 writebackToParent：父非 idle → auto-wake 跳过 → 旧实现此后无人消费）
      if (!injected) {
        injected = true;
        await createRoleManagerService(db, client).writebackToParent({
          childSessionId: CHILD,
          summary: 'L2：父忙期间到达的 writeback',
        });
      }
      return baseSend(sessionId, content, options);
    };

    try {
      await startSessionRun({
        db,
        piClient: client,
        sessionId: PARENT,
        userId: 'user_seed',
        content: 'parent busy run',
      });

      // run 结束（doCleanup 收敛 idle）→ 回扫发现未被消费的 writeback → 补投
      expect(await waitUntil(() => state.sent.length >= 2)).toBe(true);
      const replay = state.sent[1];
      expect(replay.sessionId).toBe(PARENT);
      expect(replay.content).toContain('补投递');
      expect(replay.content).toContain('L2：父忙期间到达的 writeback');
      expect(replay.content).toContain(CHILD);

      // 持久消费标记（via=run_end_rescan）
      const markers = await readConsumedMarkers(db);
      expect(markers).toHaveLength(1);
      expect(markers[0].via).toBe('run_end_rescan');
      const [wbRow] = await db.select().from(messages).where(eq(messages.sessionId, PARENT));
      expect(markers[0].message_id).toBe(wbRow.id);

      // 审计行（found>0 才写）：线上可查「找到但没投出」
      const rescanEvents = (await db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, PARENT)))
        .filter((e) => e.type === 'writeback_rescan')
        .map((e) => JSON.parse(e.payload) as Record<string, unknown>);
      expect(rescanEvents).toHaveLength(1);
      expect(rescanEvents[0]).toMatchObject({ found: 1, delivered: true, wake_result: 'started', skip_reason: null });

      // 无循环：补投 run 自己结束时不会再投一次（已标记 + 窗口外）
      expect(await confirmNever(() => state.sent.length > 2, 300)).toBe(true);
    } finally {
      clearIdleRuntimeCleanup(PARENT);
      clearIdleRuntimeCleanup(CHILD);
    }
  });

  test('已标记消费的 writeback 不会被回扫重复投递（正常 wait=true 流程不会出现两条结果）', async () => {
    const { db } = await setupSession();
    await seedChild(db);
    const { client, state } = makePiClient();
    let injected = false;
    const baseSend = client.sendMessage.bind(client);
    client.sendMessage = async (sessionId: string, content: string, options?: Parameters<typeof baseSend>[2]) => {
      if (!injected) {
        injected = true;
        await createRoleManagerService(db, client).writebackToParent({
          childSessionId: CHILD,
          summary: '已被 wait 循环消费过的 writeback',
        });
        // 模拟 wait 循环已经把它交给本轮 run：写持久消费标记
        const [row] = await db.select().from(messages).where(eq(messages.sessionId, PARENT));
        await markWritebackConsumed(db, {
          sessionId: PARENT,
          messageId: row.id,
          childSessionId: CHILD,
          requestId: row.requestId,
          via: 'wait_loop',
        });
      }
      return baseSend(sessionId, content, options);
    };

    try {
      await startSessionRun({
        db,
        piClient: client,
        sessionId: PARENT,
        userId: 'user_seed',
        content: 'parent run with consumed writeback',
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      // 只有本轮 run 自己那一条 sendMessage：回扫因消费标记而跳过
      expect(state.sent).toHaveLength(1);
      const markers = await readConsumedMarkers(db);
      expect(markers).toHaveLength(1);
      expect(markers[0].via).toBe('wait_loop');
    } finally {
      clearIdleRuntimeCleanup(PARENT);
      clearIdleRuntimeCleanup(CHILD);
    }
  });

  // 审查发现（必须修）：回扫的 wake 若因瞬态原因（上一次 run 的 agent 尚未收尾 → isStreaming
  // 守卫 session_busy）被跳过，旧实现既不重试也不标记、且下一轮 run 的窗口不含更早回写 → 永久搁置。
  test('回扫投出被瞬态 session_busy 挤掉时会重试并成功（不再一次失败就永久搁置）', async () => {
    const previousRetry = process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS;
    const previousAttempts = process.env.PIPLUS_FORCED_RECLAIM_REPLAY_ATTEMPTS;
    process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS = '5';
    process.env.PIPLUS_FORCED_RECLAIM_REPLAY_ATTEMPTS = '3';
    const { db } = await setupSession();
    await seedChild(db);
    const { client, state } = makePiClient();
    let injected = false;
    let ensureCalls = 0;
    const baseSend = client.sendMessage.bind(client);
    const baseEnsure = client.ensureRuntime.bind(client);
    client.ensureRuntime = async (sessionId: string, options: Parameters<typeof baseEnsure>[1]) => {
      ensureCalls += 1;
      // 第 2 次 = 回扫的补投 run：模拟「上一次 run 的 agent 尚未收尾」的 session_busy
      if (ensureCalls === 2) throw new Error('session_busy');
      return baseEnsure(sessionId, options);
    };
    client.sendMessage = async (sessionId: string, content: string, options?: Parameters<typeof baseSend>[2]) => {
      if (!injected) {
        injected = true;
        await createRoleManagerService(db, client).writebackToParent({
          childSessionId: CHILD,
          summary: 'busy 之后仍应被回扫投出的 writeback',
        });
      }
      return baseSend(sessionId, content, options);
    };

    try {
      await startSessionRun({ db, piClient: client, sessionId: PARENT, userId: 'user_seed', content: 'run 1' });

      // 重试命中：内容最终投出，并写了消费标记 + 审计 delivered=true
      expect(await waitUntil(() => state.sent.length >= 2)).toBe(true);
      expect(state.sent[1].content).toContain('busy 之后仍应被回扫投出的 writeback');
      expect(ensureCalls).toBeGreaterThanOrEqual(3);
      const markers = await readConsumedMarkers(db);
      expect(markers).toHaveLength(1);
      expect(markers[0].via).toBe('run_end_rescan');
      const rescanEvents = (await db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, PARENT)))
        .filter((e) => e.type === 'writeback_rescan')
        .map((e) => JSON.parse(e.payload) as Record<string, unknown>);
      expect(rescanEvents.some((e) => e.delivered === true)).toBe(true);
    } finally {
      if (previousRetry === undefined) delete process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS;
      else process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS = previousRetry;
      if (previousAttempts === undefined) delete process.env.PIPLUS_FORCED_RECLAIM_REPLAY_ATTEMPTS;
      else process.env.PIPLUS_FORCED_RECLAIM_REPLAY_ATTEMPTS = previousAttempts;
      clearIdleRuntimeCleanup(PARENT);
      clearIdleRuntimeCleanup(CHILD);
    }
  });

  test('预算用尽仍未投出：写审计（delivered=false + skip_reason）且不写消费标记（留待结构性修法后的机制）', async () => {
    const previousRetry = process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS;
    const previousAttempts = process.env.PIPLUS_FORCED_RECLAIM_REPLAY_ATTEMPTS;
    process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS = '5';
    process.env.PIPLUS_FORCED_RECLAIM_REPLAY_ATTEMPTS = '2';
    const { db } = await setupSession();
    await seedChild(db);
    const { client, state } = makePiClient();
    let injected = false;
    let rescanEnsureCalls = 0;
    const baseSend = client.sendMessage.bind(client);
    client.ensureRuntime = async () => {
      rescanEnsureCalls += 1;
      // 第 1 次是 run1 自己的 ensureRuntime；其后（回扫的补投 run）始终 busy
      if (rescanEnsureCalls > 1) throw new Error('session_busy');
    };
    client.sendMessage = async (sessionId: string, content: string, options?: Parameters<typeof baseSend>[2]) => {
      if (!injected) {
        injected = true;
        await createRoleManagerService(db, client).writebackToParent({
          childSessionId: CHILD,
          summary: '始终投不出的 writeback',
        });
      }
      return baseSend(sessionId, content, options);
    };

    try {
      await startSessionRun({ db, piClient: client, sessionId: PARENT, userId: 'user_seed', content: 'run 1' });
      await new Promise((resolve) => setTimeout(resolve, 80));

      // 未投出：只有 run1 自己那一条 sendMessage；无消费标记
      // （注意：下一次 run 的回扫窗口 [其 startedAt, now] 按构造不含这批回写，
      //   结构性闭环需放宽窗口下界 + 给 auto-wake 补 via='auto_wake' 标记，见 docs 0.3 已知残余）
      const rescanRow = () => db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, PARENT))
        .then((rows) => rows.filter((e) => e.type === 'writeback_rescan'));
      expect(await waitUntil(async () => (await rescanRow()).length === 1)).toBe(true);
      expect(state.sent).toHaveLength(1);
      expect(await readConsumedMarkers(db)).toHaveLength(0);

      const rescanEvents = (await rescanRow())
        .map((e) => JSON.parse(e.payload) as Record<string, unknown>);
      expect(rescanEvents).toHaveLength(1);
      expect(rescanEvents[0]).toMatchObject({ found: 1, delivered: false, wake_result: 'skipped', skip_reason: 'retries_exhausted' });
    } finally {
      if (previousRetry === undefined) delete process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS;
      else process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS = previousRetry;
      if (previousAttempts === undefined) delete process.env.PIPLUS_FORCED_RECLAIM_REPLAY_ATTEMPTS;
      else process.env.PIPLUS_FORCED_RECLAIM_REPLAY_ATTEMPTS = previousAttempts;
      clearIdleRuntimeCleanup(PARENT);
      clearIdleRuntimeCleanup(CHILD);
    }
  });

  test('worker 会话：回扫投出补投 run 时跳过立即回收（否则可能在 microtask 窗口 dispose 掉它）；未投出时照常回收', async () => {
    const workerRoleTmplId = 'rt_worker_l2';
    const parent = 'session_worker_l2';
    const child = 'session_child_l2_worker';
    const previousAttempts = process.env.PIPLUS_FORCED_RECLAIM_REPLAY_ATTEMPTS;
    const previousRetry = process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS;

    async function runWorkerCase(options: { rescanSucceeds: boolean }) {
      const { db } = await setupSession({ sessionId: parent, roleTemplateId: workerRoleTmplId });
      await db.insert(roleTemplates).values({
        id: workerRoleTmplId,
        key: 'worker',
        version: '1',
        name: 'Worker',
        description: 'Worker role',
        basePrompt: 'Do work.',
        configJson: '{}',
        createdBy: 'system',
        ownerType: 'system',
        visibility: 'public',
        isBuiltin: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
      await db.update(sessions).set({ roleTemplateId: workerRoleTmplId }).where(eq(sessions.id, parent));
      const now = new Date();
      await db.insert(sessions).values({
        id: child, projectId: 'project_test_runtime', parentSessionId: parent, rootSessionId: parent,
        depth: 1, roleTemplateId: 'rt_blank', piSessionId: 'pi_child_l2_worker',
        piSessionLocatorJson: stringifyLocator({ piSessionId: 'pi_child_l2_worker', sessionFile: '/tmp/pi-child-l2-worker.jsonl' }),
        requestedByMessageId: null, title: 'Child', titleSource: 'default', status: 'active', runtimeStatus: 'idle',
        currentModelProvider: null, currentModelId: null, lastActivityAt: now, lastRunAt: null, lastStopAt: null,
        lastRuntimeError: null, createdBy: 'user_seed', archivedAt: null, archivedBy: null, createdAt: now, updatedAt: now,
        roleBasePromptSnapshot: 'base', userSuppliedPrompt: '', parentSuppliedPrompt: '', compiledPrompt: 'compiled',
      } as any);

      const { client, state } = makePiClient();
      let injected = false;
      let ensureCalls = 0;
      let sendCalls = 0;
      let releaseReplaySend: (() => void) | undefined;
      const replaySendGate = new Promise<void>((resolve) => { releaseReplaySend = resolve; });
      const baseSend = client.sendMessage.bind(client);
      const baseEnsure = client.ensureRuntime.bind(client);
      client.ensureRuntime = async (sessionId: string, opts: Parameters<typeof baseEnsure>[1]) => {
        ensureCalls += 1;
        // 第 1 次 = worker run 自己；其后（回扫的补投 run）按场景决定成功或始终 busy
        if (!(options.rescanSucceeds) && ensureCalls > 1) throw new Error('session_busy');
        if (options.rescanSucceeds && ensureCalls === 2) throw new Error('session_busy');
        return baseEnsure(sessionId, opts);
      };
      client.sendMessage = async (sessionId: string, content: string, opts?: Parameters<typeof baseSend>[2]) => {
        sendCalls += 1;
        if (!injected) {
          injected = true;
          await createRoleManagerService(db, client).writebackToParent({ childSessionId: child, summary: 'worker 会话的 writeback' });
        } else if (options.rescanSucceeds && sendCalls === 2) {
          // 场景 A：把补投 run 挂起（模拟它正在跑），否则它自己的 doCleanup 也会调 closeRuntime，
          // 无法区分「本次 cleanup 因回扫投出而跳过回收」与「补投 run 正常结束后的回收」。
          await replaySendGate;
        }
        return baseSend(sessionId, content, opts);
      };

      await startSessionRun({ db, piClient: client, sessionId: parent, userId: 'user_seed', content: 'worker run' });
      return { db, state, releaseReplaySend: () => releaseReplaySend?.() };
    }

    try {
      process.env.PIPLUS_FORCED_RECLAIM_REPLAY_ATTEMPTS = '3';
      process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS = '5';

      const rescanAudit = (db: TestDb) => db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, parent))
        .then((rows) => rows.filter((e) => e.type === 'writeback_rescan').map((e) => JSON.parse(e.payload) as Record<string, unknown>));

      // 场景 A：回扫投出成功（补投 run 的 sendMessage 被挂起 → run 未结束）
      // → 本次 cleanup 不得立即回收（交给该 run 自己的 doCleanup）
      const a = await runWorkerCase({ rescanSucceeds: true });
      expect(await waitUntil(async () => (await rescanAudit(a.db)).some((e) => e.delivered === true))).toBe(true);
      expect(a.state.closeRuntimeCalls).not.toContain(parent);
      a.releaseReplaySend();

      // 场景 B：预算用尽未投出 → 照常立即回收（避免 worker runtime 泄漏）
      const b = await runWorkerCase({ rescanSucceeds: false });
      expect(await waitUntil(() => b.state.closeRuntimeCalls.includes(parent))).toBe(true);
      b.releaseReplaySend();
    } finally {
      if (previousAttempts === undefined) delete process.env.PIPLUS_FORCED_RECLAIM_REPLAY_ATTEMPTS;
      else process.env.PIPLUS_FORCED_RECLAIM_REPLAY_ATTEMPTS = previousAttempts;
      if (previousRetry === undefined) delete process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS;
      else process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS = previousRetry;
      clearIdleRuntimeCleanup(parent);
      clearIdleRuntimeCleanup(child);
    }
  });
});

