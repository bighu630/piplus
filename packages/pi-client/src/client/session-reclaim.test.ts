import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { clearAskPending, markAskPending } from '../ask-pending';
import {
  clearForcedRuntimeDisposeHandlers,
  registerForcedRuntimeDisposeHandler,
  type ForcedRuntimeDisposeInfo,
} from '../runtime-lifecycle-hooks';
import {
  isSessionRuntimePinned,
  pinSessionRuntime,
  resetSessionRuntimePins,
  unpinSessionRuntime,
} from '../runtime-pins';
import { RuntimeRegistry, type ActiveSessionRuntime } from '../runtime-registry';
import type { PiSessionStreamEvent } from '../types';
import type { ClientDeps } from './deps';
import { subscribeSession } from './messaging';
import { closeRuntime, decideStreamingReclaim } from './session-lifecycle';

const RETRY_ENV = 'PIPLUS_CLOSE_RUNTIME_RETRY_MS';
const NO_PROGRESS_ENV = 'PIPLUS_FORCED_RECLAIM_NO_PROGRESS_MS';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await sleep(5);
  }
  return predicate();
}

type Harness = {
  registry: RuntimeRegistry;
  deps: ClientDeps;
  addStreamingSession: (sessionId: string) => { session: ActiveSessionRuntime; disposeCalls: number[] };
  cleanup: () => void;
};

function createHarness(): Harness {
  const registry = new RuntimeRegistry();
  const deps: ClientDeps = {
    runtimeRegistry: registry,
    modelRuntime: {} as never,
    modelRegistry: {} as never,
    ensureModel: async () => ({}) as never,
    client: undefined as unknown as ClientDeps['client'],
  };
  // 用真实 closeRuntime 作为 deps.client.closeRuntime：重试定时器因此走真实回收链路。
  deps.client = {
    closeRuntime: (sessionId: string) => closeRuntime(deps, sessionId),
  } as unknown as ClientDeps['client'];

  const sessions: ActiveSessionRuntime[] = [];
  const addStreamingSession = (sessionId: string) => {
    const session = registry.ensure(sessionId);
    const disposeCalls: number[] = [];
    session.agentSession = {
      isStreaming: true,
      dispose: () => {
        disposeCalls.push(Date.now());
      },
    } as never;
    sessions.push(session);
    return { session, disposeCalls };
  };

  const cleanup = () => {
    for (const session of sessions) {
      if (session.idleCleanupTimer) {
        clearTimeout(session.idleCleanupTimer);
        session.idleCleanupTimer = undefined;
      }
    }
  };

  return { registry, deps, addStreamingSession, cleanup };
}

const activeHarnesses: Harness[] = [];
function newHarness(): Harness {
  const harness = createHarness();
  activeHarnesses.push(harness);
  return harness;
}

describe('closeRuntime 无进展时长回收策略（idle runtime 强杀误杀回归）', () => {
  let logSpy: ReturnType<typeof spyOn>;
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of [RETRY_ENV, NO_PROGRESS_ENV]) savedEnv.set(key, process.env[key]);
    // 默认极小的回收参数，让重试循环在测试内快速推进；单个用例可覆盖。
    process.env[RETRY_ENV] = '5';
    process.env[NO_PROGRESS_ENV] = '25';
    resetSessionRuntimePins();
    clearForcedRuntimeDisposeHandlers();
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const harness of activeHarnesses.splice(0)) harness.cleanup();
    clearForcedRuntimeDisposeHandlers();
    resetSessionRuntimePins();
    logSpy.mockRestore();
    for (const key of [RETRY_ENV, NO_PROGRESS_ENV]) {
      const value = savedEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('有进展不强杀：持续刷新 lastStreamEventAt（工具活动），尝试次数远超旧 40 次上限也不 dispose、不通知', async () => {
    process.env[RETRY_ENV] = '10';
    process.env[NO_PROGRESS_ENV] = '200';
    const harness = newHarness();
    const sessionId = 'sess_progress_keepalive';
    const { session, disposeCalls } = harness.addStreamingSession(sessionId);
    const notified: ForcedRuntimeDisposeInfo[] = [];
    registerForcedRuntimeDisposeHandler((info) => {
      notified.push(info);
    });

    // 模拟 tool_execution_start / thinking_delta 等 mapped 事件持续到达
    const progressTimer = setInterval(() => {
      session.lastStreamEventAt = Date.now();
    }, 2);

    try {
      await closeRuntime(harness.deps, sessionId); // 启动流式重试循环
      const reachedOldCap = await waitFor(() => (session.closeRetries ?? 0) >= 45, 8000);
      expect(reachedOldCap).toBe(true);

      expect(disposeCalls).toHaveLength(0);
      expect(notified).toHaveLength(0);
      expect(session.agentSession).toBeDefined();
      expect(session.streamingSince).toBeNumber();
    } finally {
      clearInterval(progressTimer);
    }
  });

  test('无进展到阈值才强杀：dispose 且 hook 收到 {sessionId, disposedAt, attempts, noProgressMs}', async () => {
    const harness = newHarness();
    const sessionId = 'sess_stuck_force';
    const { session, disposeCalls } = harness.addStreamingSession(sessionId);
    const notified: ForcedRuntimeDisposeInfo[] = [];
    registerForcedRuntimeDisposeHandler((info) => {
      notified.push(info);
    });

    await closeRuntime(harness.deps, sessionId);

    expect(await waitFor(() => disposeCalls.length > 0)).toBe(true);
    expect(disposeCalls).toHaveLength(1);
    expect(session.agentSession).toBeUndefined();
    // 强杀后复位观察窗口与尝试计数
    expect(session.streamingSince).toBeUndefined();
    expect(session.closeRetries).toBe(0);

    expect(await waitFor(() => notified.length > 0, 1000)).toBe(true);
    expect(notified).toHaveLength(1);
    expect(notified[0].sessionId).toBe(sessionId);
    expect(typeof notified[0].disposedAt).toBe('number');
    expect(notified[0].attempts).toBeGreaterThanOrEqual(1);
    expect(notified[0].noProgressMs).toBeGreaterThanOrEqual(25);
  });

  test('窗口起点丢弃上个窗口的陈旧 lastStreamEventAt（陈旧进展不保护卡死流）', async () => {
    const harness = newHarness();
    const sessionId = 'sess_stale_progress';
    const { session, disposeCalls } = harness.addStreamingSession(sessionId);
    session.lastStreamEventAt = Date.now() - 60_000; // 上个窗口留下的陈旧进展

    await closeRuntime(harness.deps, sessionId);

    // 首次进入流式分支即清空陈旧进展时间，并从该刻起重新计时
    expect(session.lastStreamEventAt).toBeUndefined();
    expect(await waitFor(() => disposeCalls.length > 0)).toBe(true);
    expect(disposeCalls).toHaveLength(1);
  });

  test('pinned 完全豁免：超过阈值也不 dispose、不通知，且定时器继续武装', async () => {
    const harness = newHarness();
    const sessionId = 'sess_pinned_exempt';
    const { session, disposeCalls } = harness.addStreamingSession(sessionId);
    const notified: ForcedRuntimeDisposeInfo[] = [];
    registerForcedRuntimeDisposeHandler((info) => {
      notified.push(info);
    });

    pinSessionRuntime(sessionId);
    await closeRuntime(harness.deps, sessionId);

    // 25ms 阈值 + 5ms 重试：120ms 内已跨越阈值多次
    await sleep(120);

    expect(disposeCalls).toHaveLength(0);
    expect(notified).toHaveLength(0);
    expect(session.agentSession).toBeDefined();
    expect(isSessionRuntimePinned(sessionId)).toBe(true);
    // pin 路径按 retry interval 重新武装定时器（unpin 后才能恢复回收）
    expect(session.idleCleanupTimer).toBeDefined();
  });

  test('unpinSessionRuntime 后恢复可回收（pin 只豁免等待期间）', async () => {
    const harness = newHarness();
    const sessionId = 'sess_pin_then_unpin';
    const { disposeCalls } = harness.addStreamingSession(sessionId);
    const notified: ForcedRuntimeDisposeInfo[] = [];
    registerForcedRuntimeDisposeHandler((info) => {
      notified.push(info);
    });

    pinSessionRuntime(sessionId);
    await closeRuntime(harness.deps, sessionId);
    await sleep(60);
    expect(disposeCalls).toHaveLength(0);

    unpinSessionRuntime(sessionId);
    expect(await waitFor(() => disposeCalls.length > 0)).toBe(true);
    expect(disposeCalls).toHaveLength(1);
    expect(await waitFor(() => notified.length > 0, 1000)).toBe(true);
  });

  test('pin refcount：连续 pin 两次 + unpin 一次仍豁免，第二次 unpin 才恢复回收', async () => {
    const harness = newHarness();
    const sessionId = 'sess_pin_refcount';
    const { disposeCalls } = harness.addStreamingSession(sessionId);

    pinSessionRuntime(sessionId);
    pinSessionRuntime(sessionId);
    unpinSessionRuntime(sessionId);
    expect(isSessionRuntimePinned(sessionId)).toBe(true);

    await closeRuntime(harness.deps, sessionId);
    await sleep(60);
    expect(disposeCalls).toHaveLength(0);

    unpinSessionRuntime(sessionId);
    expect(await waitFor(() => disposeCalls.length > 0)).toBe(true);
    expect(disposeCalls).toHaveLength(1);
  });

  test('hook 抛错不影响 dispose，也不影响其它 handler', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const harness = newHarness();
    const sessionId = 'sess_hook_error_dispose';
    const { disposeCalls } = harness.addStreamingSession(sessionId);
    const notified: ForcedRuntimeDisposeInfo[] = [];
    registerForcedRuntimeDisposeHandler(() => {
      throw new Error('hook boom');
    });
    registerForcedRuntimeDisposeHandler((info) => {
      notified.push(info);
    });

    await closeRuntime(harness.deps, sessionId);

    expect(await waitFor(() => disposeCalls.length > 0)).toBe(true);
    expect(await waitFor(() => notified.length > 0, 1000)).toBe(true);
    expect(notified[0].sessionId).toBe(sessionId);
    errorSpy.mockRestore();
  });

  test('R1 minor：pin 豁免时长不计入无进展窗口：跨过阈值后解除 pin，首个 tick 不得强杀', async () => {
    process.env[RETRY_ENV] = '5';
    process.env[NO_PROGRESS_ENV] = '1000';
    const harness = newHarness();
    const sessionId = 'sess_pin_window_not_counted';
    const { session, disposeCalls } = harness.addStreamingSession(sessionId);

    // 首个 tick（非豁免）：检测到流式 → 建立观察窗口（streamingSince = T0）
    await closeRuntime(harness.deps, sessionId);
    expect(session.streamingSince).toBeNumber();
    const windowStartedAt = session.streamingSince!;

    // 平台长等待开始（domain pin）：豁免期远长于 1000ms 阈值
    pinSessionRuntime(sessionId);
    await sleep(1200);
    // 豁免期内：不得强杀，且旧窗口必须已被丢弃
    // （否则整段豁免时长会在解除后被算作无进展）
    const disposeCallsDuringExemption = [...disposeCalls];
    const windowAfterExemption = session.streamingSince;

    // 解除 pin：首个 tick 只能重建窗口，绝不能拿 T0 当基准立刻强杀。
    // 汇总断言：单次 diff 同时暴露「豁免期保留旧窗口」「解除后未重建窗口」「宽限期
    // （300ms < 1000ms 阈值）内被强杀」全部症状（分条 expect 只会报第一个）。
    const unpinnedAt = Date.now();
    unpinSessionRuntime(sessionId);
    const windowRebuilt = await waitFor(() => session.streamingSince !== undefined && session.streamingSince >= unpinnedAt);
    await sleep(300);
    expect({
      disposeCallsDuringExemption,
      windowAfterExemption,
      windowRebuilt,
      disposeCalls,
      agentSessionAlive: session.agentSession !== undefined,
    }).toEqual({
      disposeCallsDuringExemption: [],
      windowAfterExemption: undefined,
      windowRebuilt: true,
      disposeCalls: [],
      agentSessionAlive: true,
    });
    expect(session.streamingSince).toBeGreaterThanOrEqual(unpinnedAt);
    expect(session.streamingSince).toBeGreaterThan(windowStartedAt);

    // 豁免不改变僵尸兜底能力：新窗口走完阈值后仍会强杀
    expect(await waitFor(() => disposeCalls.length > 0, 5000)).toBe(true);
    expect(disposeCalls).toHaveLength(1);
  });

  test('既有 ask-pending 豁免行为不回归：pending 期间不回收，解除后恢复', async () => {
    const harness = newHarness();
    const sessionId = 'sess_ask_pending_guard';
    const { disposeCalls } = harness.addStreamingSession(sessionId);
    const notified: ForcedRuntimeDisposeInfo[] = [];
    registerForcedRuntimeDisposeHandler((info) => {
      notified.push(info);
    });

    markAskPending(sessionId);
    try {
      await closeRuntime(harness.deps, sessionId);
      await sleep(80);
      expect(disposeCalls).toHaveLength(0);
      expect(notified).toHaveLength(0);
    } finally {
      clearAskPending(sessionId);
    }

    expect(await waitFor(() => disposeCalls.length > 0)).toBe(true);
  });
});

describe('decideStreamingReclaim（纯函数判据）', () => {
  test('窗口刚建立且无事件：无进展为 0，不强杀', () => {
    const decision = decideStreamingReclaim({
      now: 1000,
      streamingSince: 1000,
      noProgressThresholdMs: 30,
    });
    expect(decision.lastProgressAt).toBe(1000);
    expect(decision.noProgressMs).toBe(0);
    expect(decision.shouldForceDispose).toBe(false);
  });

  test('近期有 mapped 事件：无论窗口多老都不强杀', () => {
    const decision = decideStreamingReclaim({
      now: 1000,
      streamingSince: 100,
      lastStreamEventAt: 990,
      noProgressThresholdMs: 30,
    });
    expect(decision.noProgressMs).toBe(10);
    expect(decision.shouldForceDispose).toBe(false);
  });

  test('无事件且超过阈值：强杀', () => {
    const decision = decideStreamingReclaim({
      now: 1000,
      streamingSince: 100,
      noProgressThresholdMs: 30,
    });
    expect(decision.noProgressMs).toBe(900);
    expect(decision.shouldForceDispose).toBe(true);
  });

  test('边界：无进展恰好等于阈值即强杀（>=）', () => {
    const decision = decideStreamingReclaim({
      now: 1000,
      streamingSince: 970,
      noProgressThresholdMs: 30,
    });
    expect(decision.noProgressMs).toBe(30);
    expect(decision.shouldForceDispose).toBe(true);
  });
});

// lastStreamEventAt 的**唯一生产写入点**在 subscribeSession 的包装器里（messaging.ts）：
// 卡死兜底判据「连续无进展时长」完全依赖它，但它此前没有任何测试覆盖。
// 本用例若该行被误删/改写，必须变红。
describe('subscribeSession 进度信号（lastStreamEventAt 唯一写入点）', () => {
  function makeSubscribeHarness() {
    const registry = new RuntimeRegistry();
    const deps: ClientDeps = {
      runtimeRegistry: registry,
      modelRuntime: {} as never,
      modelRegistry: {} as never,
      ensureModel: async () => ({}) as never,
      client: undefined as unknown as ClientDeps['client'],
    };
    const sessionId = 'sess_subscribe_progress';
    const session = registry.ensure(sessionId);
    let emit: ((event: unknown) => void) | undefined;
    session.agentSession = {
      subscribe: (callback: (event: unknown) => void) => {
        emit = callback;
        return () => {};
      },
    } as never;
    return { deps, sessionId, session, emit: (event: unknown) => emit?.(event) };
  }

  test('mapped 事件刷新 registry 条目的 lastStreamEventAt；unmapped 事件不刷新', async () => {
    const harness = makeSubscribeHarness();
    const received: PiSessionStreamEvent[] = [];
    const unsubscribe = await subscribeSession(harness.deps, harness.sessionId, (event) => {
      received.push(event);
    });

    // 订阅本身不是进展：窗口/基准都不得被订阅动作写入
    expect(harness.session.lastStreamEventAt).toBeUndefined();

    // mapped 的 activity 事件（tool_execution_start）既下发也刷新进度基准
    const beforeMapped = Date.now();
    harness.emit({ type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'bash', args: {} });
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('activity');
    expect(harness.session.lastStreamEventAt).toBeGreaterThanOrEqual(beforeMapped);
    const afterMapped = harness.session.lastStreamEventAt;

    // unmapped 事件（agent_start 无 UI/无进展语义）：不下发也不刷新进度基准
    harness.emit({ type: 'agent_start' });
    expect(received).toHaveLength(1);
    expect(harness.session.lastStreamEventAt).toBe(afterMapped);

    unsubscribe();
    expect(harness.session.listeners.size).toBe(0);
  });
});
