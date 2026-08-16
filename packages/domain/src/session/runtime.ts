import { projects, roleTemplates, sessionEvents, sessions } from '@piplus/db/schema';
import { and, eq, ne } from 'drizzle-orm';
import type { PiClient, PiImageInput, PiSessionStreamEvent } from '@piplus/pi-client';
import { NON_WORKER_IDLE_RUNTIME_TTL_MS } from '@piplus/pi-client/constants';
import { parseLocator } from '@piplus/pi-client/locator';
import type { RoleManagerDb } from '../role-manager/service';
import { buildAllToolDefs, invokePlatformTool } from '../extensions/registry';
import { setRequestContext, clearRequestContext, isCrossProjectWaiting, clearCrossProjectWait, isWaitingOnChild, getWaitingOnChild, clearWaitingOnChild } from './request-context';

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

  // Check first-conversation state from session file BEFORE ensureRuntime,
  // so we can merge the role prompt with user content in a single turn.
  const isFirst = input.piClient.isFirstConversation(input.sessionId);
  let hadOutput = false;

  // 原子认领（idle→running）。路由层 busy 检查是非原子读，两个并发 POST 可同时通过；
  // 此条件更新保证同一时刻只有一个 run 启动（认领失败方抛 session_busy）。
  // 'stopping' 等非 idle 状态同样认领失败，与原 busy 检查行为一致。
  // 认领前只做只读步骤（parseLocator/roleTmpl/buildAllToolDefs/isFirstConversation）：
  // 它们抛错时无状态变更，会话保持 idle（与旧行为一致）；
  // 认领之后任何失败都必须复位 idle（下方 try/catch 与 markSessionRunning 的 catch）。
  const claimed = await input.db.update(sessions)
    .set({ runtimeStatus: 'running', updatedAt: startedAt })
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

    // Abort the running agent if cleanup was triggered by error or timeout.
    // The agent may still be generating; abort fires in background to avoid blocking.
    // When the prompt promise later settles, cleanupDone guards against re-entry.
    if (error) {
      input.piClient.stopSession(input.sessionId).catch((abortErr) => {
        console.error('[session-runtime] abort during cleanup failed', { sessionId: input.sessionId, abortErr });
      });
    }

    // Only surface real agent errors (not internal safety timeouts) to the user.
    const runtimeError = (error && !isSafetyTimeout) ? formatRuntimeError(error) : null;
    if (runtimeError) {
      await persistRuntimeError(input.db, input.sessionId, runtimeError);
    }
    clearRequestContext(input.sessionId);
    clearCrossProjectWait(input.sessionId);
    clearWaitingOnChild(input.sessionId);
    // markSessionIdle / onRuntimeStatusChange 抛错时也必须取消订阅，
    // 否则 listener 泄漏（子会话现已持有真实订阅）。
    try {
      await markSessionIdle(input.db, input.sessionId, new Date(), runtimeError);
      await input.onRuntimeStatusChange?.({
        sessionId: input.sessionId,
        projectId: project.id,
        runtimeStatus: 'idle',
        error: runtimeError,
      });
    } finally {
      unsubscribe();
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
  // 1. 内存标记（主豁免）：父会话正处于 waitForChildWriteback 轮询——内存标记在 wait
  //    循环期间始终置位，不依赖子会话瞬时 DB 状态，对子 idle 窗口免疫（旧实现只有 DB
  //    查询，落在窗口内豁免失败会连坐杀父）。
  // 2. DB 子会话查询（次要兜底）：子会话 running/stopping 时豁免——覆盖 wait 循环置标记
  //    前 child 刚启动的微小窗口。
  // 3. 跨项目等待标记：目标项目会话是顶层会话（无 parentSessionId），DB 查不到，用内存标记豁免。
  // 4. 子会话豁免（精确匹配 + 连续次数上限）：自身有 parentSessionId 且父正在等**自己**——
  //    读父标记中的 childSessionId 精确匹配，只豁免父正在等的那一个子会话（兄弟子会话不受
  //    牵连）；父的 reminder（15-45s）比硬杀更及时更有针对性，但连续豁免满 3 次（≈30 分钟）
  //    后强制超时——running 卡死（无事件、无自身标记）的子只有这条路径管理，默认配置下父 wait
  //    无限轮询（deadline=null），无上限会永不超时。合法静默（嵌套 wait / 跨项目等待）由豁免
  //    1/3 覆盖，不会走到这里累积计数。
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
        // 豁免 1（主豁免）：父会话正在 waitForChildWriteback 轮询等待子会话 writeback。
        // 父在 wait 期间自身不产生 stream 事件，但子会话活动意味着 agent 未卡死。
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
        // 读父标记中的 childSessionId 精确匹配，兄弟子会话（父没在等的）不受牵连。
        // 命中后累计连续豁免次数：未达上限则 reschedule；达到上限则 warn 并 fall through
        // （不 return），继续走超时执行 doCleanup——running 卡死的子只有这条路径管理。
        try {
          const [selfRow] = await input.db
            .select({ parentSessionId: sessions.parentSessionId })
            .from(sessions)
            .where(eq(sessions.id, input.sessionId))
            .limit(1);
          const waitEntry = selfRow?.parentSessionId ? getWaitingOnChild(selfRow.parentSessionId) : undefined;
          // 流事件可能已在此次查询期间重置计时器：过期 pass 不计入连续静默窗口
          if (timeoutStartedAt !== startedAt) return;
          if (selfRow?.parentSessionId && waitEntry?.childSessionId === input.sessionId) {
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
