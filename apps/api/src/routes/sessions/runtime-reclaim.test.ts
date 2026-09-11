import { afterEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createDb } from '@piplus/db/client';
import { createSeedDb } from '@piplus/db/init';
import { messages, projects, sessionEvents, sessions } from '@piplus/db/schema';
import type { PiClient } from '@piplus/pi-client';
import { stringifyLocator } from '@piplus/pi-client/locator';
import { clearForcedRuntimeDisposeHandlers, notifyForcedRuntimeDispose } from '@piplus/pi-client/runtime-lifecycle-hooks';
import { clearIdleRuntimeCleanup, createRoleManagerService } from '@piplus/domain';
import { createApp } from '../../app';
import { socketHub } from '../../ws/server';

/**
 * 端到端自愈链（线上事故的直接证明）：
 *
 * 父会话并行 spawn_session(wait=true) 等两个 worker 时被 pi-client 的卡死兜底强杀
 * （closeRuntime 无进展 → dispose 在途 turn），旧实现下父会话 DB 永远停在 running，
 * 迟到的子会话 writeback 因「父非 idle」跳过 auto-wake，结果永久躺在 DB 里
 * （父会话 jsonl 中 spawn_session 之后没有任何 toolResult）。
 *
 * 本文件证明三段接线合起来能自愈：
 *   1) forced runtime dispose hook（app.ts 里 registerRuntimeReclaimHook 注册）
 *   2) finalizeForcedRuntimeReclaim：戴着 lastRunAt 护栏把父会话收敛回 idle（DB + WS 广播）
 *   3) writebackToParent 的 auto-wake：迟到的 writeback 立刻把父会话拉起（idle→running）
 */

type MockSocket = {
  sent: string[];
  send(data: string): void;
};

function createMockSocket(): MockSocket {
  return {
    sent: [],
    send(data: string) {
      this.sent.push(data);
    },
  };
}

function makeDbPath(label: string) {
  return `/tmp/piplus-${label}-${crypto.randomUUID()}.sqlite`;
}

const PARENT_ID = 'sess_reclaim_parent';
const CHILD_ID = 'sess_reclaim_child';
const PROJECT_ID = 'proj_reclaim';

/** 轻量 piClient 桩：sendMessage 挂起（deferred），让 auto-wake 的 run 停在 running 以断言。 */
function makeStubPiClient() {
  let releaseSend!: () => void;
  const sendGate = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  const state = {
    ensured: [] as string[],
    sent: [] as Array<{ sessionId: string; content: string }>,
    closed: [] as string[],
  };

  const client = {
    async createSession() {
      throw new Error('not_implemented');
    },
    async restoreRuntime() {
      return;
    },
    async ensureRuntime(sessionId: string) {
      state.ensured.push(sessionId);
    },
    isFirstConversation() {
      return false;
    },
    getRuntimeState() {
      return null;
    },
    async injectPromptIfNeeded() {
      return;
    },
    async subscribeSession() {
      return () => {};
    },
    async getHistory() {
      return { messages: [], nextCursor: null };
    },
    async sendMessage(sessionId: string, content: string) {
      state.sent.push({ sessionId, content });
      // 挂起直到测试主动释放：模拟「新 run 仍在生成」，保证 auto-wake 后会话保持 running
      await sendGate;
      return { sessionId, runId: 'run_stub' };
    },
    async stopSession() {
      return { status: 'stopped' as const };
    },
    async waitForSessionIdle() {
      return true;
    },
    async closeRuntime(sessionId: string) {
      state.closed.push(sessionId);
    },
    async disposeSession() {
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
    async bindToolRuntime() {
      return;
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
      throw new Error('not_implemented');
    },
  } as unknown as PiClient;

  return { client, state, releaseSend };
}

async function seedParentAndChild(dbPath: string, options: { parentLastRunAt: Date }) {
  const db = createDb(`file:${dbPath}`);
  const now = new Date('2026-01-01T00:00:00.000Z');

  await db.insert(projects).values({
    id: PROJECT_ID,
    name: 'Reclaim Project',
    createdBy: 'user_seed',
    status: 'active',
    projectPath: '/tmp/reclaim-project',
    sourceType: 'existing',
    sourceUrl: '',
    archivedAt: null,
    archivedBy: null,
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
  } as any);

  // 父会话：模拟被强杀时仍停在 running，lastRunAt = 被强杀的那个 run 的认领时刻
  await db.insert(sessions).values({
    id: PARENT_ID,
    projectId: PROJECT_ID,
    parentSessionId: null,
    rootSessionId: PARENT_ID,
    depth: 0,
    roleTemplateId: 'rt_blank',
    piSessionId: 'pi_reclaim_parent',
    piSessionLocatorJson: stringifyLocator({ piSessionId: 'pi_reclaim_parent', sessionFile: '/tmp/pi-reclaim-parent.jsonl' }),
    requestedByMessageId: null,
    title: 'Reclaim Parent',
    titleSource: 'default',
    status: 'active',
    runtimeStatus: 'running',
    currentModelProvider: null,
    currentModelId: null,
    lastActivityAt: now,
    lastRunAt: options.parentLastRunAt,
    lastStopAt: null,
    lastRuntimeError: 'aborted_by_forced_reclaim',
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

  await db.insert(sessions).values({
    id: CHILD_ID,
    projectId: PROJECT_ID,
    parentSessionId: PARENT_ID,
    rootSessionId: PARENT_ID,
    depth: 1,
    roleTemplateId: 'rt_blank',
    piSessionId: 'pi_reclaim_child',
    piSessionLocatorJson: stringifyLocator({ piSessionId: 'pi_reclaim_child', sessionFile: '/tmp/pi-reclaim-child.jsonl' }),
    requestedByMessageId: null,
    title: 'Reclaim Child',
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

describe('forced runtime reclaim → idle 收敛 → 迟到 writeback auto-wake', () => {
  const originalDatabaseUrl = Bun.env.DATABASE_URL;
  let attached: MockSocket[] = [];

  afterEach(() => {
    for (const socket of attached) {
      socketHub.detach(socket as never);
    }
    attached = [];
    clearForcedRuntimeDisposeHandlers();
    clearIdleRuntimeCleanup(PARENT_ID);
    if (originalDatabaseUrl === undefined) delete Bun.env.DATABASE_URL;
    else Bun.env.DATABASE_URL = originalDatabaseUrl;
  });

  test('强杀 hook 收敛父会话 idle（DB + WS），随后迟到的 writeback 立即 auto-wake 父会话', async () => {
    const dbPath = makeDbPath('runtime-reclaim');
    createSeedDb(dbPath);
    Bun.env.DATABASE_URL = `file:${dbPath}`;

    // 被强杀 run 的认领时刻（disposedAt 晚于它 → lastRunAt 护栏放行）
    const parentLastRunAt = new Date('2026-01-01T00:00:00.000Z');
    const disposedAt = Date.parse('2026-01-01T00:10:00.000Z');
    const { db } = await seedParentAndChild(dbPath, { parentLastRunAt });

    // createApp() 走 app.ts 的生产接线（registerRuntimeReclaimHook）
    createApp();
    const socket = createMockSocket();
    attached.push(socket);
    socketHub.attach(socket as never);

    await notifyForcedRuntimeDispose({
      sessionId: PARENT_ID,
      disposedAt,
      attempts: 4,
      noProgressMs: 1_800_000,
    });

    // 1) DB 收敛：running → idle，错误清理
    const [parentAfterReclaim] = await db.select().from(sessions).where(eq(sessions.id, PARENT_ID)).limit(1);
    expect(parentAfterReclaim?.runtimeStatus).toBe('idle');
    expect(parentAfterReclaim?.lastRuntimeError).toBeNull();

    // 2) WS 广播：与 chat.ts 同形（session.runtime_status_changed + project/session scope）
    const frames = socket.sent.map((raw) => JSON.parse(raw) as {
      kind: string;
      type?: string;
      payload?: { runtime_status?: string; error?: string | null };
      scope?: { project_id?: string; session_id?: string };
    });
    expect(frames.some((f) =>
      f.kind === 'event'
      && f.type === 'session.runtime_status_changed'
      && f.payload?.runtime_status === 'idle'
      && f.payload?.error === null
      && f.scope?.project_id === PROJECT_ID
      && f.scope?.session_id === PARENT_ID,
    )).toBe(true);

    // 3) 迟到 writeback：父会话已 idle → 必须被 auto-wake 拉起（idle→running）
    const { client, state, releaseSend } = makeStubPiClient();
    const roleManager = createRoleManagerService(db, client);
    try {
      const result = await roleManager.writebackToParent({
        childSessionId: CHILD_ID,
        summary: 'late writeback content',
      });
      expect(result.parentSessionId).toBe(PARENT_ID);

      const [parentAfterWriteback] = await db.select().from(sessions).where(eq(sessions.id, PARENT_ID)).limit(1);
      expect(parentAfterWriteback?.runtimeStatus).toBe('running');

      // 拉起的新 run 消费的正是迟到 writeback 的内容
      expect(state.sent).toEqual([{ sessionId: PARENT_ID, content: 'late writeback content' }]);

      // writeback 结果确实落库到父会话（不再是「永久躺在 DB 里」）
      const parentMessages = await db.select().from(messages).where(eq(messages.sessionId, PARENT_ID));
      expect(parentMessages.some((m) => m.messageKind === 'writeback' && m.contentText === 'late writeback content')).toBe(true);
    } finally {
      // 释放挂起的 run（让 doCleanup 正常收尾，避免遗留 pending promise / 定时器）
      releaseSend();
      await new Promise((resolve) => setTimeout(resolve, 0));
      clearIdleRuntimeCleanup(PARENT_ID);
    }
  });

  /**
   * ① 强杀补投递（线上事故里 Worker A 那条 writeback 的回归）：
   * writeback 在强杀**之前**落库（父会话当时仍 running，其消费者=当时那次 wait 循环），
   * 父会话随后被杀 → 旧实现没有任何代码会再读这条 → 永久搁置。
   * 新实现：强杀收敛时重扫窗口 [lastRunAt, 收敛落库时刻] 并补投给父会话（带醒目标记）。
   */
  test('强杀补投递：被杀 run 窗口内已落库的 writeback 被重扫补投给父会话（+审计事件）', async () => {
    const dbPath = makeDbPath('runtime-reclaim-replay');
    createSeedDb(dbPath);
    Bun.env.DATABASE_URL = `file:${dbPath}`;

    const parentLastRunAt = new Date('2026-01-01T00:00:00.000Z');
    const disposedAt = Date.parse('2026-01-01T00:10:00.000Z');
    const { db } = await seedParentAndChild(dbPath, { parentLastRunAt });

    // 事故时序：writeback 在被强杀之前落库
    await db.insert(messages).values({
      id: 'msg_stranded_before_kill',
      sessionId: PARENT_ID,
      piMessageId: null,
      messageKind: 'writeback',
      sourceSessionId: CHILD_ID,
      role: 'assistant',
      contentText: 'Worker A 在被强杀之前落库的 writeback',
      contentBlocksJson: null,
      contentVersion: 1,
      requestId: 'req_stranded_before_kill',
      createdAt: new Date('2026-01-01T00:05:00.000Z'),
    } as any);

    // 生产接线：createApp 把 piClient 注入给 reclaim hook（补投递用它拉起会话）
    const { client, state, releaseSend } = makeStubPiClient();
    createApp({ piClient: client });
    const socket = createMockSocket();
    attached.push(socket);
    socketHub.attach(socket as never);

    try {
      await notifyForcedRuntimeDispose({
        sessionId: PARENT_ID,
        disposedAt,
        attempts: 40,
        noProgressMs: 1_800_000,
      });

      // 补投递生效：父会话被拉起，消费内容含醒目标记与被困住的 writeback
      const [parentAfterReplay] = await db.select().from(sessions).where(eq(sessions.id, PARENT_ID)).limit(1);
      expect(parentAfterReplay?.runtimeStatus).toBe('running');
      expect(state.sent).toHaveLength(1);
      expect(state.sent[0].sessionId).toBe(PARENT_ID);
      expect(state.sent[0].content).toContain('补投递');
      expect(state.sent[0].content).toContain('Worker A 在被强杀之前落库的 writeback');
      expect(state.sent[0].content).toContain(CHILD_ID);

      // ② 审计事件可查（旧实现只有 stdout 日志）
      const events = await db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, PARENT_ID));
      const audit = events
        .filter((e) => e.type === 'runtime_forced_reclaim')
        .map((e) => JSON.parse(e.payload) as Record<string, unknown>);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        result: 'converged',
        stranded_writebacks: 1,
        wake_result: 'started',
        attempts: 40,
        no_progress_ms: 1_800_000,
      });

      // 补投递 run 的前端可见性：hooks 把 onRuntimeStatusChange 透传给 wake，
      // 因此除收敛时广播的 idle 外，还应看到补投递 run 的 running（否则前端停在 idle）。
      const frames = socket.sent.map((raw) => JSON.parse(raw) as {
        kind: string;
        type?: string;
        payload?: { runtime_status?: string };
      });
      expect(frames.some((f) => f.type === 'session.runtime_status_changed' && f.payload?.runtime_status === 'idle')).toBe(true);
      expect(frames.some((f) => f.type === 'session.runtime_status_changed' && f.payload?.runtime_status === 'running')).toBe(true);
    } finally {
      releaseSend();
      await new Promise((resolve) => setTimeout(resolve, 0));
      clearIdleRuntimeCleanup(PARENT_ID);
    }
  });
});
