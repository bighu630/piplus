import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createDb } from '@piplus/db/client';
import { createSeedDb } from '@piplus/db/init';
import { projects, roleTemplates, sessionEvents, sessions } from '@piplus/db/schema';
import { stringifyLocator } from '@piplus/pi-client/locator';
import type { PiClient, PiSessionStreamEvent, PiToolDef } from '@piplus/pi-client';
import { startSessionRun, clearIdleRuntimeCleanup, scheduleIdleRuntimeCleanup } from './runtime';

function makeDbPath() {
  return `/tmp/piplus-session-runtime-${crypto.randomUUID()}.sqlite`;
}

function makePiClient(options?: { sendError?: Error }) {
  const state: {
    restored: Array<{ sessionId: string; cwd?: string }>;
    bound: Array<{ sessionId: string; cwd?: string; tools: PiToolDef[] }>;
    subscribed: string[];
    unsubscribed: string[];
    sent: Array<{ sessionId: string; content: string }>;
    closeRuntimeCalls: string[];
  } = {
    restored: [],
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
    async restoreRuntime(sessionId, _locator, cwd) {
      state.restored.push({ sessionId, cwd });
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
      if (options?.sendError) throw options.sendError;
      return { sessionId, runId: 'run_pi' };
    },
    async stopSession() {
      return { status: 'stopped' as const };
    },
    async closeRuntime(sessionId: string) {
      state.closeRuntimeCalls.push(sessionId);
      return;
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
    async bindToolRuntime(sessionId, tools, _handler, cwd) {
      state.bound.push({ sessionId, cwd, tools });
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
    expect(state.restored).toEqual([{ sessionId: 'session_test_runtime', cwd: '/tmp/runtime-project' }]);
    expect(state.bound).toHaveLength(1);
    expect(state.bound[0]?.cwd).toBe('/tmp/runtime-project');
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
});
