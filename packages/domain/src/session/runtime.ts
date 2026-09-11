import { messages, projects, roleTemplates, sessionEvents, sessions } from '@piplus/db/schema';
import { and, eq, gte, lte, ne } from 'drizzle-orm';
import type { PiClient, PiImageInput, PiSessionStreamEvent } from '@piplus/pi-client';
import { NON_WORKER_IDLE_RUNTIME_TTL_MS } from '@piplus/pi-client/constants';
import { parseLocator } from '@piplus/pi-client/locator';
import type { RoleManagerDb } from '../role-manager/service';
import { buildAllToolDefs, invokePlatformTool } from '../extensions/registry';
import { ASK_QUESTION_SYSTEM_PROMPT, isAskQuestionPendingForSession } from '../extensions/ask-question';
import { setRequestContext, clearRequestContext, isCrossProjectWaiting, clearCrossProjectWait, isWaitingOnChild, isWaitedOnByParent, clearWaitingOnChild } from './request-context';
import { isAskPending as isPiAskPending } from '@piplus/pi-client/ask-pending';

// TTL 单一来源：与 client 层定时器共用 @piplus/pi-client/constants（值导入走 /constants 子路径，
// 避免拉起整个 client.ts 模块及其 ModelRuntime 初始化副作用）。

// 豁免 4（子会话豁免）的连续豁免次数上限：约 3×10 分钟 = 30 分钟。
// running 卡死（无事件、无自身标记）的子会话只有豁免 4 一条管理路径——默认配置下父 wait 循环
// deadline=null 无限轮询，若豁免无上限则永不超时；达到上限后强制超时回收。合法静默（嵌套 wait /
// 跨项目等待）由豁免 1/3 覆盖不会走到这里，只有连续静默窗口才累积计数。
const MAX_MANAGED_CHILD_EXEMPTIONS = 3;

const idleRuntimeCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function clearIdleRuntimeCleanup(sessionId: string): void {
  const timer = idleRuntimeCleanupTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    idleRuntimeCleanupTimers.delete(sessionId);
  }
}

export function scheduleIdleRuntimeCleanup(piClient: PiClient, sessionId: string, ttlMs = NON_WORKER_IDLE_RUNTIME_TTL_MS): void {
  clearIdleRuntimeCleanup(sessionId);
  const timer = setTimeout(() => {
    piClient.closeRuntime(sessionId).catch((err) => {
      console.error('[session-runtime] idle runtime cleanup failed', { sessionId, err });
    });
    idleRuntimeCleanupTimers.delete(sessionId);
  }, ttlMs);
  idleRuntimeCleanupTimers.set(sessionId, timer);
}

// 用户主动停止后等待 agent 真正 idle 的兜底超时（可被 PIPLUS_STOP_TIMEOUT_MS 覆盖，默认 15s）。
function resolveStopCompletionTimeout(): number {
  const raw = typeof process !== 'undefined' ? process.env.PIPLUS_STOP_TIMEOUT_MS?.trim() : undefined;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 15 * 1000;
}
const STOP_COMPLETION_TIMEOUT_MS = resolveStopCompletionTimeout();

export type StartSessionRunInput = {
  db: RoleManagerDb;
  piClient: PiClient;
  sessionId: string;
  userId: string;
  content: string;
  images?: PiImageInput[];
  candidateModels?: Array<{
    provider: string;
    id: string;
    thinkingLevel?: string | null;
  }>;
  requestId?: string;
  startedAt?: Date;
  safetyTimeoutMs?: number;
  onStreamEvent?: (event: PiSessionStreamEvent) => void | Promise<void>;
  onRuntimeStatusChange?: (payload: {
    sessionId: string;
    projectId: string;
    runtimeStatus: 'running' | 'idle';
    error: string | null;
  }) => void | Promise<void>;
  onToolSessionCreated?: (payload: { sessionId: string; projectId: string }) => void | Promise<void>;
};

function formatRuntimeError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'unknown_runtime_error';
  }
}

async function persistRuntimeError(db: RoleManagerDb, sessionId: string, error: string) {
  try {
    await db.insert(sessionEvents).values({
      id: `event_runtime_err_${crypto.randomUUID().slice(0, 12)}`,
      sessionId,
      type: 'chat_runtime_error',
      payload: JSON.stringify({ error, timestamp: new Date().toISOString() }),
      parentMessageId: null,
      sequence: 1,
      createdAt: new Date(),
    } as any);
  } catch (insertErr) {
    console.error('[session-runtime] failed to persist runtime error event', { sessionId, error, insertErr });
  }
}

export async function markSessionRunning(db: RoleManagerDb, sessionId: string, timestamp: Date) {
  await db.update(sessions).set({
    runtimeStatus: 'running',
    lastActivityAt: timestamp,
    lastRunAt: timestamp,
    lastRuntimeError: null,
    updatedAt: timestamp,
  }).where(eq(sessions.id, sessionId));
}

export async function markSessionIdle(db: RoleManagerDb, sessionId: string, timestamp: Date, error: string | null = null) {
  await db.update(sessions).set({
    runtimeStatus: 'idle',
    lastRuntimeError: error,
    updatedAt: timestamp,
  }).where(eq(sessions.id, sessionId));
}

/**
 * 条件收敛 idle（带 run 所有权护栏）：仅当会话仍为 running 且本 run 仍是所有者
 * （lastRunAt <= runStartedAt，自身 run 满足相等）时写入并返回 true。
 *
 * 为什么用 lastRunAt 而不是 updated_at：lastRunAt 是「哪个 run 认领了会话」的可靠标记
 * —— 由 run 的原子认领与 markSessionRunning 写同一个值，以及 chat 路由 vision 中转的
 * 占位认领（同样显式写自己时刻的 lastRunAt，否则它会被旧 run 的迟到 cleanup 误判为自己所有）；
 * updated_at 会被 writeback/活动消息刷新，用它判定会把已被新 run 接管的会话误判给旧 run。
 *
 * lastRunAt IS NULL 的处理（刻意保持「不视为本 run 所有」）：
 * SQL 的 `NULL <= ?` 不成立 → 返回 false，调用方走「同一 run 但状态已非 running」的保守出口
 * （不写 idle、不广播 idle，仅回收 runtime）。不变量（由 startSessionRun 保证）：
 * running 会话的 lastRunAt 必然非 NULL——认领（idle→running 的条件 UPDATE）就同刻写入
 * lastRunAt，而 doCleanup 永远在认领与 markSessionRunning 之后才可能执行；markSessionRunning
 * 抛错时认领已被 catch 复位 idle 并抛出，不会带着 NULL 停在 running。
 * 因此该分支在当前的写者集合（run 认领 + vision 占位认领）下基本不可达，只可能命中历史脏数据；
 * 此时无法证明所有权。刻意**不**把它当成本 run 所有（不用 `or(isNull(...), lte(...))`）：
 * NULL 意味着「没有认领者」，若一律判定为所有者，任何忘记写 lastRunAt 的未来写者都会重新
 * 打开「旧 run 误判新 run 为自己的」窗口——正是本护栏要堵住的事故类别。宁可保守
 * （交给停止收尾/重启 recoverStuckSessions 兜底），也不冒误覆盖的风险。
 */
export async function markSessionIdleIfRunOwned(
  db: RoleManagerDb,
  sessionId: string,
  runStartedAt: Date,
  timestamp: Date,
  error: string | null = null,
): Promise<boolean> {
  const claimed = await db.update(sessions).set({
    runtimeStatus: 'idle',
    lastRuntimeError: error,
    updatedAt: timestamp,
  }).where(and(
    eq(sessions.id, sessionId),
    eq(sessions.runtimeStatus, 'running'),
    lte(sessions.lastRunAt, runStartedAt),
  )).returning({ id: sessions.id });
  return claimed.length > 0;
}

/**
 * 旧 run 的 cleanup 是否已被更新的 run 接管（lastRunAt 被推进到 runStartedAt 之后）。
 * 会话不存在（被删/归档）不算接管：runtime 仍应由本次 cleanup 正常回收，避免泄漏。
 * lastRunAt IS NULL（没有任何 run 认领过）也不算接管——NULL 不是「更新的 run」；
 * 与 markSessionIdleIfRunOwned 的保守语义一致（详该函数 JSDoc 的不变量说明）。
 */
async function isSessionOwnedByNewerRun(db: RoleManagerDb, sessionId: string, runStartedAt: Date): Promise<boolean> {
  const [row] = await db.select({ lastRunAt: sessions.lastRunAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row) return false;
  return row.lastRunAt !== null && row.lastRunAt.getTime() > runStartedAt.getTime();
}

/**
 * ② 强杀审计事件：强制回收原先只打 stdout 日志（线上日志未必落在文件里），
 * 落一条 session_events 便于事后直接从 DB 查「哪个会话何时、为何被强杀」。
 * 与 persistRuntimeError 同策略：审计写入失败绝不影响善后主流程。
 */
async function persistForcedReclaimEvent(
  db: RoleManagerDb,
  sessionId: string,
  payload: Record<string, unknown>,
  existingEventId?: string,
) {
  try {
    if (existingEventId) {
      await db.update(sessionEvents)
        .set({ payload: JSON.stringify(payload) })
        .where(eq(sessionEvents.id, existingEventId));
      return existingEventId;
    }
    const eventId = `event_forced_reclaim_${crypto.randomUUID().slice(0, 12)}`;
    await db.insert(sessionEvents).values({
      id: eventId,
      sessionId,
      type: 'runtime_forced_reclaim',
      payload: JSON.stringify(payload),
      parentMessageId: null,
      sequence: 1,
      createdAt: new Date(),
    } as any);
    return eventId;
  } catch (insertErr) {
    console.error('[session-runtime] failed to persist forced reclaim audit event', { sessionId, insertErr });
    return existingEventId;
  }
}

/**
 * 用一段内容拉起会话消费（writeback auto-wake 与强杀补投递共用同一实现）。
 * 原子 idle→running 认领保证幂等：并发重复拉起抛 session_busy，这里吞掉即视为没拉起；
 * 其他错误只 warn 不抛 —— 调用方（writeback 落库 / 强杀善后）不得因拉起失败而失败。
 */
export type WakeSessionWithContentInput = {
  db: RoleManagerDb;
  piClient: PiClient;
  sessionId: string;
  userId: string;
  content: string;
  requestId: string;
  /** 仅日志标签（如 'writeback-auto-wake' / 'forced-reclaim-rescan'） */
  reason: string;
  onRuntimeStatusChange?: StartSessionRunInput['onRuntimeStatusChange'];
};

export async function wakeSessionWithContent(
  input: WakeSessionWithContentInput,
): Promise<'started' | 'skipped' | 'failed'> {
  try {
    await startSessionRun({
      db: input.db,
      piClient: input.piClient,
      sessionId: input.sessionId,
      userId: input.userId,
      content: input.content,
      requestId: input.requestId,
      onRuntimeStatusChange: input.onRuntimeStatusChange,
    });
    console.log('[session-runtime] session woken with content', { sessionId: input.sessionId, reason: input.reason });
    return 'started';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('session_busy') || msg.includes('session_not_found')) {
      console.log('[session-runtime] wake skipped', { sessionId: input.sessionId, reason: input.reason, error: msg });
      return 'skipped';
    }
    console.warn('[session-runtime] wake failed', { sessionId: input.sessionId, reason: input.reason, error: msg });
    return 'failed';
  }
}

type StrandedWritebackRow = {
  id: string;
  sourceSessionId: string | null;
  contentText: string | null;
  contentBlocksJson: string | null;
  createdAt: Date;
};

/** 扫描 [from, to] 窗口内发给该会话的 writeback —— 强杀补投递的候选集。 */
async function findStrandedWritebacks(
  db: RoleManagerDb,
  sessionId: string,
  from: Date,
  to: Date,
): Promise<StrandedWritebackRow[]> {
  return await db.select({
    id: messages.id,
    sourceSessionId: messages.sourceSessionId,
    contentText: messages.contentText,
    contentBlocksJson: messages.contentBlocksJson,
    createdAt: messages.createdAt,
  })
    .from(messages)
    .where(and(
      eq(messages.sessionId, sessionId),
      eq(messages.messageKind, 'writeback'),
      gte(messages.createdAt, from),
      lte(messages.createdAt, to),
    ))
    .orderBy(messages.createdAt);
}

/**
 * 补投递内容：醒目标记 + 逐条来源/时间 + summary(+blocks)。
 *
 * 为什么要醒目标记：窗口内的 writeback 可能在强杀前已被 wait 循环「匹配」过，
 * 但「匹配到」≠「内容真的落进上下文」（事故里 Worker A 那条就是匹配后交给被杀 agent 吞掉的），
 * DB 侧没有可靠信号区分两者，因此策略是**一律补投**——宁可偶发重复摘要，也不让结果永久丢失；
 * 标记让模型/用户能识别这是一次补投递并自行核对。
 */
// 补投递（强杀善后）的有界重试参数：会话恰好被并发认领（用户消息/其它 auto-wake）而 session_busy 时，
// 不因一次失败就丢掉**整包**被困回写（L3）。调用时读 env，便于测试用极小值驱动重试。
const DEFAULT_REPLAY_ATTEMPTS = 3;
// 间隔取 30s（而非秒级）：补投递最常见的竞争是「用户消息 / 其它 auto-wake 的 run 正占着会话」，
// 这些 run 通常是几十秒级；太短的间隔只会在同一个 busy 窗口里空转，白耗重试预算。
// 两个 resolver 均在调用时读 env（attempts 取正整数；retry ms 取 >=0，便于测试用极小值驱动重试）。
const DEFAULT_REPLAY_RETRY_MS = 30_000;

function resolveReplayAttempts(): number {
  const raw = typeof process !== 'undefined' ? process.env.PIPLUS_FORCED_RECLAIM_REPLAY_ATTEMPTS?.trim() : undefined;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return DEFAULT_REPLAY_ATTEMPTS;
}

function resolveReplayRetryMs(): number {
  const raw = typeof process !== 'undefined' ? process.env.PIPLUS_FORCED_RECLAIM_REPLAY_RETRY_MS?.trim() : undefined;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_REPLAY_RETRY_MS;
}

function buildReplayContent(items: StrandedWritebackRow[]): string {
  const header = `【平台补投递】上一轮 run 因长时间无进展被强制回收，以下 ${items.length} 条子会话写回结果未能进入会话上下文（可能已被消费过，若重复请忽略）。`;
  const body = items.map((item, index) => {
    let blocksPart = '';
    if (item.contentBlocksJson) {
      try {
        blocksPart = `\n\n${JSON.stringify(JSON.parse(item.contentBlocksJson), null, 2)}`;
      } catch {
        blocksPart = `\n\n${item.contentBlocksJson}`;
      }
    }
    return `--- ${index + 1}/${items.length} 来自 ${item.sourceSessionId ?? '未知子会话'}（${item.createdAt.toISOString()}）---\n${item.contentText ?? ''}${blocksPart}`;
  }).join('\n\n');
  return `${header}\n\n${body}`;
}

type ReplayOutcome = {
  /** 窗口内扫描到的被困 writeback 数；null = 未扫描（如无 piClient / 无 lastRunAt） */
  stranded: number | null;
  wakeResult: 'started' | 'skipped' | 'failed' | 'not_attempted';
  /**
   * wakeResult='skipped' 时的原因（审计用，区分「正常让位」与「需要关注」）：
   * - `session_not_idle`：重试期间会话始终被并发 run 占用；
   * - `retries_exhausted`：重试预算用尽仍未投出；
   * - `not_replayable`：会话不可补投（已归档，或缺少 createdBy 等无法拉起的数据异常）；
   * - `session_missing`：会话行已被删。
   * 投出成功或未尝试（无候选）时为 null。
   */
  skipReason: 'session_not_idle' | 'retries_exhausted' | 'not_replayable' | 'session_missing' | null;
};

/**
 * ① 补投递：重扫窗口 [lastRunAt, windowEnd] 内的 writeback 并补投给会话（内容带醒目标记）。
 *
 * 两个调用点：
 * - 收敛路径：强杀后由本函数把状态落为 idle，随后必然 idle → 可被拉起；
 * - 非收敛路径（旧 run 的 doCleanup 抢先收敛为 idle，hook 慢到）：状态已 idle 同样可被拉起。
 *   此时若不补投，同一条被困 writeback 就永久搁置（审查发现 L1）；调用方已用
 *   lastRunAt <= disposedAt 护栏保证会话没有被更新的 run 接管。
 *
 * 有界重试：唤醒靠原子 idle→running 认领，会话恰好被并发认领（用户消息 / 其它 writeback
 * 的 auto-wake）时会 session_busy；不重试就会把**整包**被困回写一并丢掉（L3）。
 * 每次重试前只重新确认「会话仍空闲可用」（idle + active）——一旦有新 run 在跑就让位（不抢）。
 */
async function replayStrandedWritebacks(input: {
  db: RoleManagerDb;
  piClient: PiClient;
  sessionId: string;
  userId: string;
  lastRunAt: Date;
  windowEnd: Date;
  onRuntimeStatusChange?: StartSessionRunInput['onRuntimeStatusChange'];
}): Promise<ReplayOutcome> {
  const stranded = await findStrandedWritebacks(input.db, input.sessionId, input.lastRunAt, input.windowEnd);
  if (stranded.length === 0) return { stranded: 0, wakeResult: 'not_attempted', skipReason: null };

  const content = buildReplayContent(stranded);
  const attempts = resolveReplayAttempts();
  let lastWakeResult: 'skipped' | 'failed' = 'skipped';
  // 最近一次尝试是否只是「让位」（会话被并发 run 占用）——预算用尽时据此区分
  // session_not_idle（全程被占用，正常让位）与 retries_exhausted（尝试过但未投出/失败）。
  let lastAttemptWasDefer = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, resolveReplayRetryMs()));

    // 每次尝试前重新确认「会话空闲可用」：仍 idle 且未归档。
    // 刻意**不**在这里再比 lastRunAt 与 disposedAt：上一次失败的尝试自身会写
    // lastRunAt = 自己的 startedAt（认领即写 run 身份），那会把「我们自己的失败」
    // 误判成「被更新的 run 接管」而放弃重试。"通知是否仍然相关"（lastRunAt <= disposedAt）
    // 由调用方在进入补投递之前判定一次；这里只保证不打断/不抢正在跑的 run。
    const [row] = await input.db
      .select({ runtimeStatus: sessions.runtimeStatus, status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, input.sessionId))
      .limit(1);
    if (!row) return { stranded: stranded.length, wakeResult: 'skipped', skipReason: 'session_missing' };
    if (row.status !== 'active') return { stranded: stranded.length, wakeResult: 'skipped', skipReason: 'not_replayable' };
    if (row.runtimeStatus !== 'idle') {
      // 会话正被并发 run 占用：让位但**继续重试**（不抢在跑的 run，也不能一次 busy 就丢掉整包）。
      // 常见触发：用户消息或其它 writeback 的 auto-wake 抢在重扫前认领。
      console.log('[session-runtime] forced reclaim replay deferred — session busy', {
        sessionId: input.sessionId,
        attempt: attempt + 1,
        attempts,
        count: stranded.length,
      });
      lastWakeResult = 'skipped';
      lastAttemptWasDefer = true;
      continue;
    }

    const wakeResult = await wakeSessionWithContent({
      db: input.db,
      piClient: input.piClient,
      sessionId: input.sessionId,
      userId: input.userId,
      content,
      requestId: `wbreplay_${crypto.randomUUID().slice(0, 12)}`,
      reason: 'forced-reclaim-rescan',
      onRuntimeStatusChange: input.onRuntimeStatusChange,
    });
    console.log('[session-runtime] forced reclaim replay attempt', {
      sessionId: input.sessionId,
      attempt: attempt + 1,
      count: stranded.length,
      result: wakeResult,
    });
    if (wakeResult === 'started') return { stranded: stranded.length, wakeResult, skipReason: null };
    // 'skipped'（并发认领 / session_not_found）与 'failed'（含 SQLITE_BUSY、runtime 暂不可用、
    // 模型绑定失败等瞬态错误；失败路径已把会话复位 idle，重试不会重复认领）都继续消耗重试预算，
    // 预算用尽后以最后一次的结果 + skip_reason 记账。
    lastWakeResult = wakeResult;
    lastAttemptWasDefer = false;
  }
  return {
    stranded: stranded.length,
    wakeResult: lastWakeResult,
    skipReason: lastAttemptWasDefer ? 'session_not_idle' : 'retries_exhausted',
  };
}

export type FinalizeForcedRuntimeReclaimInput = {
  db: RoleManagerDb;
  sessionId: string;
  /** 强杀时刻（hook 传入，ms epoch） */
  disposedAt: number;
  /** 仅日志 */
  attempts?: number;
  /** 仅日志 */
  noProgressMs?: number;
  /**
   * 强杀补投递（①）所需的客户端：把被杀 run 窗口 [lastRunAt, disposedAt] 内已落库、
   * 却因 run 被杀而失去消费者的 writeback 重新投给该会话。缺省则只收敛、不补投。
   */
  piClient?: PiClient;
  onRuntimeStatusChange?: (payload: {
    sessionId: string;
    projectId: string;
    /** 'idle' = 收敛广播；'running' = 补投递 run 拉起后（与普通 run 同形，供前端刷新状态） */
    runtimeStatus: 'idle' | 'running';
    error: string | null;
  }) => void | Promise<void>;
};

/**
 * B1：pi-client 卡死兜底强杀（forced runtime dispose）后的状态收敛。
 *
 * 被强杀的在途 run 不会再走到 doCleanup 的正常出口，若不收敛，会话会永久停在 running，
 * 迟到的子会话 writeback 因「父会话非 idle」跳过 auto-wake，结果永久躺在 DB 里（线上事故）。
 * 本函数戴着 lastRunAt 护栏做幂等条件收敛：只有「会话仍 running 且被强杀时刻不早于本次 run 的
 * 认领时刻（lastRunAt <= disposedAt）」才置 idle——若期间用户已发新消息且新 run 认领
 * （lastRunAt 推进到 disposedAt 之后），绝不能覆盖新 run。
 *
 * domain 不直接依赖 socketHub：广播通过 onRuntimeStatusChange 回调交给调用方（api 层）。
 *
 * 除了状态收敛，本函数还负责两件善后：
 * ① **补投递**：重扫被杀 run 窗口 [lastRunAt, 收敛落库后的当前时刻] 内发给本会话的 writeback，
 *    有则用 wakeSessionWithContent 重新拉起会话消费（附醒目标记，会话 busy 时有界重试）。
 *    上界取「收敛落库之后」而不是 disposedAt：强杀（disposedAt）到收敛落库之间存在时间差
 *    （hook 是 fire-and-forget），这段时间内落库的 writeback 的 auto-wake 会看到 DB 仍 running
 *    而跳过，若不计入窗口就会永久丢失。取收敛后的时刻后，不变式为：
 *    「收敛之后落库的写回，其 auto-wake 必然看到 idle → 由它负责；收敛之前的，一律补投」，
 *    两条路径即使竞争也由原子 idle→running 认领保证只投一次（输的一方 session_busy 跳过/重试）。
 *    会话已经 idle（旧 run 的 doCleanup 抢先收敛、hook 慢到）时同样补投——否则 "hook 与
 *    doCleanup 谁先落 idle" 会静默决定补投递是否发生（审查发现 L1）。
 * ② **审计事件**：落一条 session_events(type='runtime_forced_reclaim')，含 result / 窗口 /
 *    stranded_writebacks / wake_result，便于事后从 DB 审计强杀与补投递是否真的投出。
 */
export async function finalizeForcedRuntimeReclaim(input: FinalizeForcedRuntimeReclaimInput): Promise<boolean> {
  const [session] = await input.db.select({
    id: sessions.id,
    projectId: sessions.projectId,
    status: sessions.status,
    createdBy: sessions.createdBy,
    runtimeStatus: sessions.runtimeStatus,
    lastRunAt: sessions.lastRunAt,
  }).from(sessions).where(eq(sessions.id, input.sessionId)).limit(1);

  const auditBase = {
    disposed_at: new Date(input.disposedAt).toISOString(),
    attempts: input.attempts ?? null,
    no_progress_ms: input.noProgressMs ?? null,
    last_run_at: session?.lastRunAt?.toISOString() ?? null,
  };

  if (!session) {
    console.warn('[session-runtime] forced reclaim finalization skipped — session not found', {
      sessionId: input.sessionId,
      disposedAt: input.disposedAt,
    });
    await persistForcedReclaimEvent(input.db, input.sessionId, {
      ...auditBase, result: 'session_missing', stranded_writebacks: null, wake_result: 'not_attempted', skip_reason: null,
    });
    return false;
  }

  /** 非收敛出口的补投递：仅当会话已 idle、未归档、且未被更新的 run 接管（lastRunAt <= disposedAt）。 */
  const replayOnAlreadyIdle = async (): Promise<ReplayOutcome> => {
    const notTakenOver = session.lastRunAt !== null && session.lastRunAt.getTime() <= input.disposedAt;
    if (!input.piClient || !session.lastRunAt || session.runtimeStatus !== 'idle' || session.status !== 'active' || !session.createdBy || !notTakenOver) {
      return { stranded: null, wakeResult: 'not_attempted', skipReason: null };
    }
    try {
      return await replayStrandedWritebacks({
        db: input.db,
        piClient: input.piClient,
        sessionId: input.sessionId,
        userId: session.createdBy,
        lastRunAt: session.lastRunAt,
        windowEnd: new Date(),
        onRuntimeStatusChange: input.onRuntimeStatusChange,
      });
    } catch (err) {
      console.warn('[session-runtime] forced reclaim replay failed (already-idle path)', {
        sessionId: input.sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
      return { stranded: null, wakeResult: 'failed', skipReason: null };
    }
  };

  if (session.runtimeStatus !== 'running') {
    console.log('[session-runtime] forced reclaim finalization skipped — session not running', {
      sessionId: input.sessionId,
      runtimeStatus: session.runtimeStatus,
    });
    // 会话已经 idle：旧 run 的 doCleanup 抢先收敛（hook 慢到）时，窗口内的被困 writeback
    // 同样需要补投，否则「谁先落 idle」会静默决定补投递是否发生（L1）。
    // 审计两阶段写：先落 pending（重试预算最长可达 ~1 分钟，"发生过强杀"的证据不能拖到重试结束才落库），
    // 补投递结束后更新同一行为最终结果。
    const notRunningAuditId = await persistForcedReclaimEvent(input.db, input.sessionId, {
      ...auditBase, result: 'skipped_not_running', stranded_writebacks: null, wake_result: 'pending', skip_reason: null,
    });
    const outcome = await replayOnAlreadyIdle();
    await persistForcedReclaimEvent(input.db, input.sessionId, {
      ...auditBase, result: 'skipped_not_running', stranded_writebacks: outcome.stranded, wake_result: outcome.wakeResult, skip_reason: outcome.skipReason,
    }, notRunningAuditId ?? undefined);
    return false;
  }

  const disposedAt = new Date(input.disposedAt);
  const claimed = await input.db.update(sessions).set({
    runtimeStatus: 'idle',
    lastRuntimeError: null,
    updatedAt: new Date(),
  }).where(and(
    eq(sessions.id, input.sessionId),
    eq(sessions.runtimeStatus, 'running'),
    // lastRunAt 护栏：绝不覆盖在强杀之后才认领会话的新 run
    lte(sessions.lastRunAt, disposedAt),
  )).returning({ id: sessions.id });

  if (claimed.length === 0) {
    console.log('[session-runtime] forced reclaim finalization skipped — session taken over by a newer run', {
      sessionId: input.sessionId,
      disposedAt: input.disposedAt,
      lastRunAt: session.lastRunAt?.toISOString() ?? null,
    });
    await persistForcedReclaimEvent(input.db, input.sessionId, {
      ...auditBase, result: 'skipped_newer_run', stranded_writebacks: null, wake_result: 'not_attempted', skip_reason: null,
    });
    return false;
  }

  console.log('[session-runtime] forced reclaim converged session to idle', {
    sessionId: input.sessionId,
    attempts: input.attempts ?? null,
    noProgressMs: input.noProgressMs ?? null,
  });

  await input.onRuntimeStatusChange?.({
    sessionId: input.sessionId,
    projectId: session.projectId,
    runtimeStatus: 'idle',
    error: null,
  });

  // ① 补投递：被杀 run 窗口内已落库但失去消费者的 writeback（事故里 Worker A 那条）。
  // 窗口上界取「收敛落库之后」：强杀到收敛之间落库的 writeback 的 auto-wake 会因 DB 仍 running
  // 而跳过，不计入窗口就会丢失；收敛之后落库的则由其 auto-wake（看到 idle）负责。
  const replayWindowEnd = new Date();
  // 审计两阶段写：pending 行先落（进程在重试窗口内重启也不会丢掉「何时强杀过」的证据），
  // 补投递结束后更新同一行。
  const convergedAuditId = await persistForcedReclaimEvent(input.db, input.sessionId, {
    ...auditBase, result: 'converged', stranded_writebacks: null, wake_result: 'pending', skip_reason: null,
  });
  let outcome: ReplayOutcome = { stranded: null, wakeResult: 'not_attempted', skipReason: null };
  if (input.piClient && session.lastRunAt) {
    try {
      if (session.status === 'active' && session.createdBy) {
        outcome = await replayStrandedWritebacks({
          db: input.db,
          piClient: input.piClient,
          sessionId: input.sessionId,
          userId: session.createdBy,
          lastRunAt: session.lastRunAt,
          windowEnd: replayWindowEnd,
          onRuntimeStatusChange: input.onRuntimeStatusChange,
        });
      } else {
        // 归档/无 createdBy：扫一眼只为如实记账，不尝试拉起
        const stranded = await findStrandedWritebacks(input.db, input.sessionId, session.lastRunAt, replayWindowEnd);
        outcome = {
          stranded: stranded.length,
          wakeResult: 'not_attempted',
          skipReason: 'not_replayable',
        };
        console.log('[session-runtime] forced reclaim replay skipped — session not replayable', {
          sessionId: input.sessionId,
          status: session.status,
          count: stranded.length,
        });
      }
    } catch (err) {
      // 补投递失败绝不影响强杀善后（状态已收敛、审计仍要落）
      console.warn('[session-runtime] forced reclaim replay failed', {
        sessionId: input.sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
      outcome = { stranded: null, wakeResult: 'failed', skipReason: null };
    }
  }

  await persistForcedReclaimEvent(input.db, input.sessionId, {
    ...auditBase, result: 'converged', stranded_writebacks: outcome.stranded, wake_result: outcome.wakeResult, skip_reason: outcome.skipReason,
  }, convergedAuditId ?? undefined);
  return true;
}

export type FinalizeSessionStopInput = {
  db: RoleManagerDb;
  piClient: PiClient;
  sessionId: string;
  projectId: string;
  timeoutMs?: number;
  onRuntimeStatusChange?: (payload: {
    sessionId: string;
    projectId: string;
    runtimeStatus: 'idle';
  }) => void | Promise<void>;
};

export async function finalizeSessionStop(input: FinalizeSessionStopInput): Promise<void> {
  const timeoutMs = input.timeoutMs ?? STOP_COMPLETION_TIMEOUT_MS;
  let converged = false;
  try {
    converged = await input.piClient.waitForSessionIdle(input.sessionId, timeoutMs);
  } catch (err) {
    console.warn('[session-runtime] waitForSessionIdle failed during stop — forcing idle', { sessionId: input.sessionId, err });
  }
  if (!converged) {
    console.warn('[session-runtime] stop completion timed out — forcing idle', { sessionId: input.sessionId, timeoutMs });
  }

  // 条件复位：仅当会话仍为 stopping 时才复位 idle。
  // 若期间 doCleanup 已复位 idle 且新 run 又认领为 running，则跳过，绝不覆盖进行中的 run。
  const claimed = await input.db.update(sessions)
    .set({ runtimeStatus: 'idle', lastRuntimeError: null, updatedAt: new Date() })
    .where(and(eq(sessions.id, input.sessionId), eq(sessions.runtimeStatus, 'stopping')))
    .returning({ id: sessions.id });
  if (claimed.length === 0) {
    console.log('[session-runtime] stop finalization skipped — session no longer stopping', { sessionId: input.sessionId });
    return;
  }

  await input.onRuntimeStatusChange?.({
    sessionId: input.sessionId,
    projectId: input.projectId,
    runtimeStatus: 'idle',
  });
}

/** planner 首条消息时注入角色提示词与用户内容之间的分隔串（api 层剥离前缀时引用，勿单独改动） */
export const MERGED_USER_MESSAGE_SEPARATOR = '\n\n请尊重用户的语言习惯，现在用户说：\n\n';

export async function startSessionRun(input: StartSessionRunInput) {
  const startedAt = input.startedAt ?? new Date();
  const safetyTimeoutMs = input.safetyTimeoutMs ?? (() => {
    const raw = typeof process !== 'undefined' ? process.env.PIPLUS_SESSION_TIMEOUT_MS?.trim() : undefined;
    if (raw !== undefined && raw !== '') {
      const n = Number(raw);
      if (Number.isFinite(n)) return n;
    }
    return 10 * 60 * 1000;
  })();

  // Cancel any pending idle cleanup timer for this session
  clearIdleRuntimeCleanup(input.sessionId);

  const [session] = await input.db.select().from(sessions)
    .where(eq(sessions.id, input.sessionId))
    .limit(1);
  if (!session) throw new Error('session_not_found');

  const [project] = await input.db.select({ id: projects.id, projectPath: projects.projectPath, createdBy: projects.createdBy })
    .from(projects)
    .where(and(eq(projects.id, session.projectId), eq(projects.createdBy, input.userId)))
    .limit(1);
  if (!project) throw new Error('session_not_found');

  const locator = parseLocator(session.piSessionLocatorJson);

  // Load the role template key to determine which tools to expose
  const [roleTmpl] = await input.db
    .select({ key: roleTemplates.key })
    .from(roleTemplates)
    .where(eq(roleTemplates.id, session.roleTemplateId))
    .limit(1);
  const roleKey = roleTmpl?.key ?? null;

  let toolDefs = await buildAllToolDefs(input.db, project.id);
  // Planner is a root node — it coordinates children via spawn_session only.
  // It does NOT call writeback_to_parent (reports directly to user) and
  // does NOT call send_message_to_session (feature_lead/bugfix_lead interact independently).
  if (roleKey === 'planner') {
    toolDefs = toolDefs.filter(t => t.name !== 'writeback_to_parent' && t.name !== 'send_message_to_session');
  }

  // ask_question 使用指引注入：工具暴露时随 ensureRuntime 的 extensionFactories 注册
  // before_agent_start 处理器，每 turn 向 systemPrompt 追加一次（SDK 链式语义，不累积）。
  const askQuestionSystemPrompt = toolDefs.some((t) => t.name === 'ask_question')
    ? ASK_QUESTION_SYSTEM_PROMPT
    : undefined;

  // Check first-conversation state from session file BEFORE ensureRuntime,
  // so we can merge the role prompt with user content in a single turn.
  const isFirst = input.piClient.isFirstConversation(input.sessionId);
  let hadOutput = false;

  // 原子认领（idle→running）。路由层 busy 检查是非原子读，两个并发 POST 可同时通过；
  // 此条件更新保证同一时刻只有一个 run 启动（认领失败方抛 session_busy）。
  // 'stopping' 等非 idle 状态同样认领失败，与原 busy 检查行为一致。
  // run 身份 = 认领即写 lastRunAt：所有权判据（markSessionIdleIfRunOwned / isSessionOwnedByNewerRun）
  // 只看 lastRunAt，若等到下文 markSessionRunning 才写，就存在「认领已生效、lastRunAt 仍是旧 run 值」
  // 的窗口——旧 run 的迟到 cleanup 落在窗口里会被误判为新 run 的所有者，从而 abort 新 run、
  // 广播陈旧 idle、写陈旧 chat_runtime_error。认领与身份写入必须原子同刻，窗口才不存在。
  // markSessionRunning 仍会写入同一值（幂等，兼作 lastActivityAt/错误字段复位）。
  // 认领前只做只读步骤（parseLocator/roleTmpl/buildAllToolDefs/isFirstConversation）：
  // 它们抛错时无状态变更，会话保持 idle（与旧行为一致）；
  // 认领之后任何失败都必须复位 idle（下方 try/catch 与 markSessionRunning 的 catch）。
  const claimed = await input.db.update(sessions)
    .set({ runtimeStatus: 'running', lastRunAt: startedAt, updatedAt: startedAt })
    .where(and(eq(sessions.id, input.sessionId), eq(sessions.runtimeStatus, 'idle')))
    .returning({ id: sessions.id });
  if (claimed.length === 0) {
    throw new Error('session_busy');
  }

  // 认领（idle→running）之后到 markSessionRunning 之间的代码包进 try/catch：
  // 任一步抛错（ensureRuntime 失败、模型绑定失败等）都必须把会话复位为 idle，
  // 否则会话会卡死在 running，只能等重启 recoverStuckSessions 兜底。
  let finalContent = input.content;
  try {
    console.log('[session-runtime] ensureRuntime start', {
      sessionId: input.sessionId,
      projectId: project.id,
      locatorFile: locator.sessionFile,
      dbModelProvider: session.currentModelProvider,
      dbModelId: session.currentModelId,
    });
    await input.piClient.ensureRuntime(input.sessionId, {
      locator,
      cwd: project.projectPath,
      tools: toolDefs,
      systemPrompt: askQuestionSystemPrompt,
      toolHandler: async (toolName, args) => {
        return invokePlatformTool(toolName, args, {
          db: input.db,
          piClient: input.piClient,
          sessionId: input.sessionId,
          userId: input.userId,
          onSessionCreated: input.onToolSessionCreated,
          onRuntimeStatusChange: input.onRuntimeStatusChange,
        });
      },
    });

    // Get runtimeState AFTER ensureRuntime — the prompt is stored under piSessionId,
    // and ensureRuntime's restoreRuntime migrates it to the domain sessionId.
    // Reading it before ensureRuntime would return null for spawn_session cases.
    const runtimeState = input.piClient.getRuntimeState(input.sessionId);

    // safety timeout 的 abort 是 fire-and-forget：DB 已 idle 但 agent 可能仍在收尾。
    // 此时拒绝新 run（干净 session_busy），并重新武装 domain 定时器让陈旧 runtime 最终被回收。
    if (runtimeState?.isStreaming) {
      scheduleIdleRuntimeCleanup(input.piClient, input.sessionId);
      throw new Error('session_busy');
    }

    // Merge role prompt with user content for first conversation.
    // Replaces the old injectPromptIfNeeded approach which sent the prompt
    // as a separate LLM turn, breaking the single-turn merge semantics.
    if (isFirst && runtimeState?.prompt && input.content) {
      finalContent = `${runtimeState.prompt}${MERGED_USER_MESSAGE_SEPARATOR}${input.content}`;
      console.log('[session-runtime] merged prompt + user message (first conversation)', { sessionId: input.sessionId });
    } else if (isFirst && runtimeState?.prompt) {
      // spawn_session: content is empty, just inject prompt
      finalContent = runtimeState.prompt;
      console.log('[session-runtime] injecting role prompt only (spawn session)', { sessionId: input.sessionId });
    }

    if (session.currentModelProvider && session.currentModelId) {
      console.log('[session-runtime] enforce model from db', {
        sessionId: input.sessionId,
        provider: session.currentModelProvider,
        id: session.currentModelId,
      });
      await input.piClient.setSessionModel(
        input.sessionId,
        locator,
        { provider: session.currentModelProvider, id: session.currentModelId },
        project.projectPath,
      );
    } else {
      console.log('[session-runtime] no db model to enforce', { sessionId: input.sessionId });
    }

    const runtimeModel = await input.piClient.getCurrentModel(input.sessionId);
    console.log('[session-runtime] runtime model after ensureRuntime', {
      sessionId: input.sessionId,
      provider: runtimeModel?.provider ?? null,
      id: runtimeModel?.id ?? null,
    });

    const boundRuntimeModel = await input.piClient.getCurrentModel(input.sessionId);
    console.log('[session-runtime] runtime model after ensureRuntime', {
      sessionId: input.sessionId,
      provider: boundRuntimeModel?.provider ?? null,
      id: boundRuntimeModel?.id ?? null,
    });
  } catch (err) {
    // 释放认领：runtime 未就绪，不能让会话停在 running（否则只能等重启 recoverStuckSessions）
    await markSessionIdle(input.db, input.sessionId, new Date(), null).catch(() => {});
    throw err;
  }

  let cleanupDone = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let timeoutStartedAt: number | null = null;
  // 豁免 4 的 per-run 连续豁免计数：只在流事件重置计时器时归零（resetTimeout），
  // 因此只有连续静默窗口才累积，达到 MAX_MANAGED_CHILD_EXEMPTIONS 后强制超时。
  let managedExemptionCount = 0;

  const doCleanup = async (error: unknown = null) => {
    if (cleanupDone) return;
    cleanupDone = true;
    // 捕获超时窗口起点（下方会清空 timeoutStartedAt），供超时日志统计
    const lastActivityAt = timeoutStartedAt;
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
      timeoutStartedAt = null;
    }

    // Internal safety timeout: agent produced zero events for too long.
    // This is not a real agent loop error — don't surface it to the user.
    const isSafetyTimeout = error instanceof Error && error.message === 'session_run_timeout';

    if (isSafetyTimeout) {
      console.warn('[session-runtime] safety timeout fired — session produced no stream events for the full window', {
        sessionId: input.sessionId,
        roleKey,
        safetyTimeoutMs,
        elapsedSinceLastActivityMs: lastActivityAt ? Date.now() - lastActivityAt : null,
      });
    }

    const runtimeError = (error && !isSafetyTimeout) ? formatRuntimeError(error) : null;

    // 所有权判定（必须先于一切副作用）：只有本 run 仍是会话所有者（lastRunAt <= startedAt）
    // 才收敛 idle。B1 让被强杀会话提前变 idle 后，用户可能马上发新消息；被强杀旧 run 的迟到
    // cleanup（线上实测可迟到 5 分钟）若发现会话已被更新的 run 接管，必须完全退出：
    // 否则 stopSession(abort) 会打断新 run 的在途生成、clearRequestContext/clearWaitingOnChild
    // 会清掉新 run 的内存标记、closeRuntime 会回收新 run 的 runtime——都是同一个「连坐」问题。
    let convergedToIdle = false;
    let supersededByNewerRun = false;
    // listener 生命周期到本判定结束：无论收敛结果如何都不再需要订阅，抛错也不得泄漏。
    try {
      convergedToIdle = await markSessionIdleIfRunOwned(input.db, input.sessionId, startedAt, new Date(), runtimeError);
      supersededByNewerRun = !convergedToIdle && await isSessionOwnedByNewerRun(input.db, input.sessionId, startedAt);
    } finally {
      unsubscribe();
    }

    if (supersededByNewerRun) {
      console.log('[session-runtime] cleanup skipped idle convergence — session owned by a newer run', {
        sessionId: input.sessionId,
        runStartedAt: startedAt.toISOString(),
      });
      // 不 abort 新 run、不写错误事件、不清新 run 的内存标记、不广播 idle、也不做 runtime 回收
      return;
    }

    // Abort the running agent if cleanup was triggered by error or timeout.
    // The agent may still be generating; abort fires in background to avoid blocking.
    // When the prompt promise later settles, cleanupDone guards against re-entry.
    // 位置在所有权判定之后：被新 run 接管的迟到 cleanup 绝不能 abort 新 run 的在途生成。
    if (error) {
      input.piClient.stopSession(input.sessionId).catch((abortErr) => {
        console.error('[session-runtime] abort during cleanup failed', { sessionId: input.sessionId, abortErr });
      });
    }

    // Only surface real agent errors (not internal safety timeouts) to the user.
    if (runtimeError) {
      await persistRuntimeError(input.db, input.sessionId, runtimeError);
    }
    clearRequestContext(input.sessionId);
    clearCrossProjectWait(input.sessionId);
    clearWaitingOnChild(input.sessionId);

    if (convergedToIdle) {
      await input.onRuntimeStatusChange?.({
        sessionId: input.sessionId,
        projectId: project.id,
        runtimeStatus: 'idle',
        error: runtimeError,
      });
    } else {
      // 同一 run 但状态已非 running（用户 stop 后的 stopping / 已被停止收尾收敛 / 会话被删）：
      // idle 广播由停止收尾路径负责，这里不重复广播，但仍按原逻辑回收 runtime（避免泄漏）。
      console.log('[session-runtime] cleanup idle convergence skipped — session no longer running (same run)', {
        sessionId: input.sessionId,
      });
    }

    if (roleKey === 'worker') {
      // Worker: reclaim runtime immediately after completion
      clearIdleRuntimeCleanup(input.sessionId);
      input.piClient.closeRuntime(input.sessionId).catch((disposeErr) => {
        console.error('[session-runtime] closeRuntime during cleanup failed', { sessionId: input.sessionId, disposeErr });
      });
    } else {
      // Non-worker: schedule runtime reclamation after idle period
      scheduleIdleRuntimeCleanup(input.piClient, input.sessionId);
    }
  };

  // Safety timeout: fires when the session produces no stream events for
  // safetyTimeoutMs. 豁免顺序（自上而下）：
  // 0. ask_question 等待用户回答——无超时，用户可在任意时间回答；runtime 回收后重新激活仍可回答。
  // 1. 内存标记（主豁免）：父会话正处于 waitForChildWriteback 轮询——内存标记在 wait
  //    循环期间始终置位，不依赖子会话瞬时 DB 状态，对子 idle 窗口免疫（旧实现只有 DB
  //    查询，落在窗口内豁免失败会连坐杀父）。标记按 (父, 子) 多条目：并行等多个子会话时，
  //    任一 wait 循环退出只清自己那个子会话，父仍因其他子会话的条目被豁免。
  // 2. DB 子会话查询（次要兜底）：子会话 running/stopping 时豁免——覆盖 wait 循环置标记
  //    前 child 刚启动的微小窗口。
  // 3. 跨项目等待标记：目标项目会话是顶层会话（无 parentSessionId），DB 查不到，用内存标记豁免。
  // 4. 子会话豁免（精确匹配 + 连续次数上限）：自身有 parentSessionId 且父正在等**自己**——
  //    按 (父, 子) 精确匹配父标记，只豁免父正在等的那一个子会话（兄弟子会话不受
  //    牵连）；父的 reminder（15-45s）比硬杀更及时更有针对性，但连续豁免满 3 次（≈30 分钟）
  //    后强制超时——running 卡死（无事件、无自身标记）的子只有这条路径管理，默认配置下父 wait
  //    无限轮询（deadline=null），无上限会永不超时。合法静默（嵌套 wait / 跨项目等待）由豁免
  //    1/3 覆盖，不会走到这里累积计数。并行多子会话时每个 child 各自独立匹配自己的条目。
  // 5. 超时执行：无豁免（无标记、无子会话、无跨项目等待、父不在等自己）→ doCleanup。
  const scheduleTimeoutCheck = () => {
    if (cleanupDone) return;
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    timeoutStartedAt = Date.now();
    timeoutHandle = setTimeout(() => {
      void (async () => {
        if (cleanupDone) return;
        const startedAt = timeoutStartedAt;
        // 豁免 0：等待用户回答（ask_question）——无超时，即使 runtime 被回收后重新激活仍可回答。
        if (isAskQuestionPendingForSession(input.sessionId) || isPiAskPending(input.sessionId)) {
          console.log('[session-runtime] safety timeout exempted — waiting for user answer (ask_question)', { sessionId: input.sessionId });
          scheduleTimeoutCheck();
          return;
        }
        // 豁免 1（主豁免）：父会话正在 waitForChildWriteback 轮询等待子会话 writeback。
        // 父在 wait 期间自身不产生 stream 事件，但只要仍有任意子会话在被等即豁免——
        // 并行多子时一个 wait 循环退出不会取消其他等待的豁免。
        if (isWaitingOnChild(input.sessionId)) {
          console.log('[session-runtime] safety timeout exempted — parent waiting on child (in-memory marker)', { sessionId: input.sessionId });
          // Still waiting for the child writeback: restart the countdown and skip cleanup
          scheduleTimeoutCheck();
          return;
        }
        try {
          // 豁免 2（次要兜底）：任何直接子会话 active（running/stopping）时豁免——
          // 覆盖 wait 循环置标记前 child 刚启动的微小窗口。
          const [activeChild] = await input.db
            .select({ id: sessions.id })
            .from(sessions)
            .where(and(eq(sessions.parentSessionId, input.sessionId), ne(sessions.runtimeStatus, 'idle')))
            .limit(1);
          if (activeChild) {
            console.log('[session-runtime] safety timeout exempted — child session running', { sessionId: input.sessionId, childSessionId: activeChild.id });
            // Child still active: restart the countdown and skip cleanup
            scheduleTimeoutCheck();
            return;
          }
        } catch (queryErr) {
          // If the exemption query fails, fall through and enforce the timeout
          console.error('[session-runtime] safety timeout exemption query failed', { sessionId: input.sessionId, queryErr });
        }
        // Exempt while waiting for a cross-project reply: the target project's
        // session is a top-level session (no parentSessionId), so the child
        // query above can't see it — use the in-memory wait marker instead.
        if (isCrossProjectWaiting(input.sessionId)) {
          console.log('[session-runtime] safety timeout exempted — waiting for cross-project reply', { sessionId: input.sessionId });
          // Still waiting for the cross-project reply: restart the countdown and skip cleanup
          scheduleTimeoutCheck();
          return;
        }
        // 豁免 4（子会话豁免）：自身是子会话（有 parentSessionId）且父正在等**自己**——
        // 按 (父, 子) 精确匹配父标记，兄弟子会话（父没在等的）不受牵连；并行多子时
        // 每个 child 各自独立匹配自己的条目。
        // 命中后累计连续豁免次数：未达上限则 reschedule；达到上限则 warn 并 fall through
        // （不 return），继续走超时执行 doCleanup——running 卡死的子只有这条路径管理。
        try {
          const [selfRow] = await input.db
            .select({ parentSessionId: sessions.parentSessionId })
            .from(sessions)
            .where(eq(sessions.id, input.sessionId))
            .limit(1);
          const waitedOnByParent = selfRow?.parentSessionId
            ? isWaitedOnByParent(selfRow.parentSessionId, input.sessionId)
            : false;
          // 流事件可能已在此次查询期间重置计时器：过期 pass 不计入连续静默窗口
          if (timeoutStartedAt !== startedAt) return;
          if (selfRow?.parentSessionId && waitedOnByParent) {
            managedExemptionCount++;
            if (managedExemptionCount < MAX_MANAGED_CHILD_EXEMPTIONS) {
              console.log('[session-runtime] safety timeout exempted — managed by waiting parent', { sessionId: input.sessionId, parentSessionId: selfRow.parentSessionId, managedExemptionCount });
              scheduleTimeoutCheck();
              return;
            }
            console.warn('[session-runtime] managed-child exemption limit reached — enforcing safety timeout', { sessionId: input.sessionId, parentSessionId: selfRow.parentSessionId, managedExemptionCount });
            // fall through：连续豁免达上限，按超时执行 doCleanup
          }
        } catch (selfQueryErr) {
          // 查询失败则 log 并继续（fall through 到超时执行，与现有行为一致）
          console.error('[session-runtime] self parentSessionId query failed', { sessionId: input.sessionId, selfQueryErr });
        }
        // A stream event may have reset the timer while we were querying —
        // the fresh timer handles the check, don't clean up from a stale pass.
        if (timeoutStartedAt !== startedAt) return;
        await doCleanup(new Error('session_run_timeout'));
      })();
    }, safetyTimeoutMs);
  };

  const resetTimeout = () => {
    if (!timeoutHandle || cleanupDone) return;
    // 流事件 = 子会话恢复活动：连续静默窗口打断，豁免计数归零（只有连续静默才累积到上限）
    managedExemptionCount = 0;
    scheduleTimeoutCheck();
  };

  // markSessionRunning 失败也要复位：认领已把状态置为 running，
  // 这条失败路径是新暴露的（旧代码此时才首次写 running），不兜底同样会卡死会话。
  try {
    await markSessionRunning(input.db, input.sessionId, startedAt);
  } catch (err) {
    await markSessionIdle(input.db, input.sessionId, new Date(), null).catch(() => {});
    throw err;
  }

  // Bind request context for cross-session wait coordination
  if (input.requestId) {
    setRequestContext(input.sessionId, input.requestId);
    console.log('[session-runtime] bind request context', { sessionId: input.sessionId, requestId: input.requestId });
  }

  await input.onRuntimeStatusChange?.({
    sessionId: input.sessionId,
    projectId: project.id,
    runtimeStatus: 'running',
    error: null,
  });

  // Start the safety timeout before setting up the stream subscription,
  // so that any early events can reset the timer immediately.
  scheduleTimeoutCheck();

  // Activity-based timeout: reset on every stream event so the safety
  // timeout only fires when the agent is truly stuck (no events at all).
  // 安全计时器是 runtime 内部职责，不能依赖调用方传 onStreamEvent：
  // startChildSessionRun（spawn_session 的 worker 子会话）没有 UI 消费方、
  // 从不传 onStreamEvent，但流事件必须照样重置计时器，否则 10 分钟硬超时
  // 会误杀仍在正常思考/执行工具的子会话。onStreamEvent 仅为可选转发。
  const wrappedListener = (event: PiSessionStreamEvent) => {
    resetTimeout();
    // Track whether any output has been produced
    if (event.type === 'message_start' || event.type === 'text_delta') {
      hadOutput = true;
    }
    if (input.onStreamEvent) {
      try { void input.onStreamEvent(event); } catch { /* isolate async handler */ }
    }
  };

  const unsubscribe = await input.piClient.subscribeSession(input.sessionId, wrappedListener);

  const candidateModels = input.candidateModels ?? [];
  let currentCandidateIndex = 0;

  const attemptSend = async (): Promise<void> => {
    // Reset hadOutput for each retry — we only care about output from THIS attempt
    hadOutput = false;
    try {
      await input.piClient.sendMessage(input.sessionId, finalContent, input.images?.length ? { images: input.images } : undefined);
      // Success — cleanup normally
      await doCleanup();
    } catch (error) {
      if (isFirst && !hadOutput && currentCandidateIndex < candidateModels.length) {
        // Switch to next candidate model and retry
        const nextModel = candidateModels[currentCandidateIndex];
        currentCandidateIndex++;
        console.log('[session-runtime] fallback: switching to candidate model', {
          sessionId: input.sessionId,
          candidateIndex: currentCandidateIndex,
          provider: nextModel.provider,
          id: nextModel.id,
        });

        try {
          // Set candidate model on the session
          await input.piClient.setSessionModel(
            input.sessionId,
            locator,
            { provider: nextModel.provider, id: nextModel.id },
            project.projectPath,
          );

          // Set thinking level if provided
          if (nextModel.thinkingLevel && typeof nextModel.thinkingLevel === 'string') {
            await input.piClient.setThinkingLevel(input.sessionId, locator, nextModel.thinkingLevel, project.projectPath).catch((err: Error) => {
              console.warn('[session-runtime] fallback: failed to set thinking level', { sessionId: input.sessionId, error: err.message });
            });
          }
        } catch (switchErr) {
          console.warn('[session-runtime] fallback: failed to switch model, skipping candidate', {
            sessionId: input.sessionId,
            error: switchErr instanceof Error ? switchErr.message : String(switchErr),
          });
        }

        // Retry with the same content
        return attemptSend();
      }

      // Not eligible for fallback — proceed with error cleanup
      await doCleanup(error);
    }
  };

  void attemptSend();

  return {
    runId: `run_${crypto.randomUUID().slice(0, 10)}`,
    projectId: project.id,
    sessionId: input.sessionId,
  };
}

/**
 * Reload session runtimes for all active sessions in a project.
 * Called after project role configuration changes.
 * - Idle sessions: immediately reload with new tool definitions
 * - Running sessions: skipped — they pick up new tools on next startSessionRun
 */
export async function reloadProjectSessionRuntimes(db: RoleManagerDb, piClient: PiClient, projectId: string): Promise<void> {
  const activeSessions = await db
    .select({
      id: sessions.id,
      runtimeStatus: sessions.runtimeStatus,
      piSessionLocatorJson: sessions.piSessionLocatorJson,
      createdBy: sessions.createdBy,
    })
    .from(sessions)
    .where(and(
      eq(sessions.projectId, projectId),
      eq(sessions.status, 'active'),
    ));

  for (const session of activeSessions) {
    // Skip running/stopping sessions — next startSessionRun picks up fresh tools
    if (session.runtimeStatus === 'running' || session.runtimeStatus === 'stopping') {
      console.log('[session-runtime] skip reload — session is running', { sessionId: session.id });
      continue;
    }

    try {
      const toolDefs = await buildAllToolDefs(db, projectId);
      const locator = parseLocator(session.piSessionLocatorJson);

      // 与 startSessionRun 一致：ask_question 工具存在时同时注入使用指引
      const askQuestionSystemPrompt = toolDefs.some((t) => t.name === 'ask_question')
        ? ASK_QUESTION_SYSTEM_PROMPT
        : undefined;

      // Query project path for ensureRuntime
      const [proj] = await db
        .select({ projectPath: projects.projectPath })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);

      await piClient.ensureRuntime(session.id, {
        locator,
        cwd: proj?.projectPath ?? '',
        tools: toolDefs,
        systemPrompt: askQuestionSystemPrompt,
        toolHandler: async (toolName, args) => {
          return invokePlatformTool(toolName, args, {
            db,
            piClient,
            sessionId: session.id,
            userId: session.createdBy,
          });
        },
      });
      console.log('[session-runtime] reloaded session tools', { sessionId: session.id, projectId });
    } catch (err) {
      // Runtime may have been reclaimed (idle cleanup) — that's fine
      console.debug('[session-runtime] skip reload — runtime not available', {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
