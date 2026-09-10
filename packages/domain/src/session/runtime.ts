import { projects, roleTemplates, sessionEvents, sessions } from '@piplus/db/schema';
import { and, eq, lte, ne } from 'drizzle-orm';
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
 * 为什么用 lastRunAt 而不是 updated_at：lastRunAt 仅由「run 认领」写入（startSessionRun 的
 * 原子认领与 markSessionRunning 写同一个值），是「哪个 run 认领了会话」的可靠标记；
 * updated_at 会被 writeback/活动消息刷新，用它判定会把已被新 run 接管的会话误判给旧 run。
 *
 * lastRunAt IS NULL 的处理（刻意保持「不视为本 run 所有」）：
 * SQL 的 `NULL <= ?` 不成立 → 返回 false，调用方走「同一 run 但状态已非 running」的保守出口
 * （不写 idle、不广播 idle，仅回收 runtime）。不变量（由 startSessionRun 保证）：
 * running 会话的 lastRunAt 必然非 NULL——认领（idle→running 的条件 UPDATE）就同刻写入
 * lastRunAt，而 doCleanup 永远在认领与 markSessionRunning 之后才可能执行；markSessionRunning
 * 抛错时认领已被 catch 复位 idle 并抛出，不会带着 NULL 停在 running。
 * 因此该分支只在「非 run 的临时 running 写者」（如 chat 路由 vision 中转的原子占位，finally
 * 自行复位）或历史脏数据下可达；此时无法证明所有权。刻意**不**把它当成本 run 所有
 * （不用 `or(isNull(...), lte(...))`）：NULL 意味着「没有 run 认领过」，若一律判定为所有者，
 * 任何忘记写 lastRunAt 的未来/现有写者都会重新打开「旧 run 误判新 run 为自己的」窗口——
 * 正是本护栏要堵住的事故类别。宁可保守（交给停止收尾/重启 recoverStuckSessions 兜底），
 * 也不冒误覆盖的风险。
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

export type FinalizeForcedRuntimeReclaimInput = {
  db: RoleManagerDb;
  sessionId: string;
  /** 强杀时刻（hook 传入，ms epoch） */
  disposedAt: number;
  /** 仅日志 */
  attempts?: number;
  /** 仅日志 */
  noProgressMs?: number;
  onRuntimeStatusChange?: (payload: {
    sessionId: string;
    projectId: string;
    runtimeStatus: 'idle';
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
 */
export async function finalizeForcedRuntimeReclaim(input: FinalizeForcedRuntimeReclaimInput): Promise<boolean> {
  const [session] = await input.db.select({
    id: sessions.id,
    projectId: sessions.projectId,
    runtimeStatus: sessions.runtimeStatus,
    lastRunAt: sessions.lastRunAt,
  }).from(sessions).where(eq(sessions.id, input.sessionId)).limit(1);

  if (!session) {
    console.warn('[session-runtime] forced reclaim finalization skipped — session not found', {
      sessionId: input.sessionId,
      disposedAt: input.disposedAt,
    });
    return false;
  }
  if (session.runtimeStatus !== 'running') {
    console.log('[session-runtime] forced reclaim finalization skipped — session not running', {
      sessionId: input.sessionId,
      runtimeStatus: session.runtimeStatus,
    });
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
