import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createDb } from '@piplus/db/client';
import { createSeedDb } from '@piplus/db/init';
import { projects, roleTemplates, sessionEvents, sessions } from '@piplus/db/schema';
import { stringifyLocator } from '@piplus/pi-client/locator';
import type { PiClient, PiSessionStreamEvent, PiToolDef } from '@piplus/pi-client';
import { startSessionRun, clearIdleRuntimeCleanup, scheduleIdleRuntimeCleanup } from './runtime';
import { setCrossProjectWait, clearCrossProjectWait, setWaitingOnChild, clearWaitingOnChild, isWaitingOnChild } from './request-context';

function makeDbPath() {
  return `/tmp/piplus-session-runtime-${crypto.randomUUID()}.sqlite`;
}

function makePiClient(options?: { sendError?: Error; ensureRuntimeError?: Error; streaming?: boolean }) {
  const opts = options;
  const state: {
    runtimeEnsured: Array<{ sessionId: string; cwd?: string }>;
    promptsInjected: string[];
    bound: Array<{ sessionId: string; cwd?: string; tools: PiToolDef[] }>;
    subscribed: string[];
    unsubscribed: string[];
    sent: Array<{ sessionId: string; content: string }>;
    closeRuntimeCalls: string[];
  } = {
    runtimeEnsured: [],
    promptsInjected: [],
    bound: [],
    subscribed: [],
    unsubscribed: [],
    sent: [],
    closeRuntimeCalls: [],
  };

  const client: PiClient = {
    async createSession() {
      throw new Error('not_implemented');
    },
    async restoreRuntime(_sessionId, _locator, _cwd) {
      // restores runtime — called internally by ensureRuntime
    },
    async ensureRuntime(sessionId, options) {
      state.runtimeEnsured.push({ sessionId, cwd: options.cwd });
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
    async stopSession() {
      return { status: 'stopped' as const };
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
    expect(state.runtimeEnsured).toEqual([{ sessionId: 'session_test_runtime', cwd: '/tmp/runtime-project' }]);
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

      // Wait past the safety timeout — 内存标记豁免（子会话 idle 也不受影响）
      await Bun.sleep(400);

      const [parent] = await db.select().from(sessions).where(eq(sessions.id, 'session_wait_marker')).limit(1);
      expect(parent?.runtimeStatus).toBe('running');
      expect(parent?.lastRuntimeError).toBeNull();
      // No cleanup ran — stream subscription still active
      expect(state.unsubscribed).not.toContain('session_wait_marker');

      // Marker cleared — countdown resumes and the timeout finally fires
      clearWaitingOnChild('session_wait_marker');

      await Bun.sleep(400);

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
    expect(state.runtimeEnsured).toEqual([{ sessionId: 'session_streaming_guard', cwd: '/tmp/runtime-project' }]);
    // 守卫抛错后 #6 的 catch 复位 DB idle
    const [session] = await db.select().from(sessions).where(eq(sessions.id, 'session_streaming_guard')).limit(1);
    expect(session?.runtimeStatus).toBe('idle');
    expect(session?.lastRuntimeError).toBeNull();

    // 守卫重新武装了 domain 回收定时器（默认 30min），取消避免污染模块级 Map
    clearIdleRuntimeCleanup('session_streaming_guard');
  });
});
