import { projects, roleTemplates, sessionEvents, sessions } from '@piplus/db/schema';
import { and, eq } from 'drizzle-orm';
import type { PiClient, PiImageInput, PiSessionStreamEvent } from '@piplus/pi-client';
import { parseLocator } from '@piplus/pi-client/locator';
import type { RoleManagerDb } from '../role-manager/service';
import { buildAllToolDefs, invokePlatformTool } from '../extensions/registry';
import { setRequestContext, clearRequestContext } from './request-context';

const NON_WORKER_IDLE_RUNTIME_TTL_MS = 30 * 60 * 1000;

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

export async function startSessionRun(input: StartSessionRunInput) {
  const startedAt = input.startedAt ?? new Date();
  const safetyTimeoutMs = input.safetyTimeoutMs ?? 10 * 60 * 1000;

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

  if (session.runtimeStatus === 'running' || session.runtimeStatus === 'stopping') {
    throw new Error('session_busy');
  }

  const locator = parseLocator(session.piSessionLocatorJson);
  console.log('[session-runtime] restore start', {
    sessionId: input.sessionId,
    projectId: project.id,
    locatorFile: locator.sessionFile,
    dbModelProvider: session.currentModelProvider,
    dbModelId: session.currentModelId,
  });
  await input.piClient.restoreRuntime(input.sessionId, locator, project.projectPath);

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
  console.log('[session-runtime] runtime model before bind', {
    sessionId: input.sessionId,
    provider: runtimeModel?.provider ?? null,
    id: runtimeModel?.id ?? null,
  });

  // Load the role template key to determine which tools to expose
  const [roleTmpl] = await input.db
    .select({ key: roleTemplates.key })
    .from(roleTemplates)
    .where(eq(roleTemplates.id, session.roleTemplateId))
    .limit(1);
  const roleKey = roleTmpl?.key ?? null;

  let toolDefs = await buildAllToolDefs(input.db);
  // Planner is a root node — it coordinates children via spawn_session and send_message_to_session,
  // but does not call writeback_to_parent itself (it reports directly to the user).
  if (roleKey === 'planner') {
    toolDefs = toolDefs.filter(t => t.name !== 'writeback_to_parent');
  }
  await input.piClient.bindToolRuntime(input.sessionId, toolDefs, async (toolName, args) => {
    return invokePlatformTool(toolName, args, {
      db: input.db,
      piClient: input.piClient,
      sessionId: input.sessionId,
      userId: input.userId,
      onSessionCreated: input.onToolSessionCreated,
      onRuntimeStatusChange: input.onRuntimeStatusChange,
    });
  }, project.projectPath);

  const boundRuntimeModel = await input.piClient.getCurrentModel(input.sessionId);
  console.log('[session-runtime] runtime model after bind', {
    sessionId: input.sessionId,
    provider: boundRuntimeModel?.provider ?? null,
    id: boundRuntimeModel?.id ?? null,
  });

  let cleanupDone = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let timeoutStartedAt: number | null = null;

  const doCleanup = async (error: unknown = null) => {
    if (cleanupDone) return;
    cleanupDone = true;
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
      timeoutStartedAt = null;
    }

    // Internal safety timeout: agent produced zero events for too long.
    // This is not a real agent loop error — don't surface it to the user.
    const isSafetyTimeout = error instanceof Error && error.message === 'session_run_timeout';

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
    await markSessionIdle(input.db, input.sessionId, new Date(), runtimeError);
    await input.onRuntimeStatusChange?.({
      sessionId: input.sessionId,
      projectId: project.id,
      runtimeStatus: 'idle',
      error: runtimeError,
    });

    unsubscribe();

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

  const resetTimeout = () => {
    if (!timeoutHandle || cleanupDone) return;
    // Only reset if less than 5 minutes remain on the countdown.
    // During active streaming this avoids excessive
    // clearTimeout/setTimeout calls while still extending near-expiry.
    const remaining = safetyTimeoutMs - (Date.now() - (timeoutStartedAt ?? Date.now()));
    if (remaining > 5 * 60_000) return;
    clearTimeout(timeoutHandle);
    timeoutStartedAt = Date.now();
    timeoutHandle = setTimeout(() => {
      void doCleanup(new Error('session_run_timeout'));
    }, safetyTimeoutMs);
  };

  await markSessionRunning(input.db, input.sessionId, startedAt);

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
  timeoutStartedAt = Date.now();
  timeoutHandle = setTimeout(() => {
    void doCleanup(new Error('session_run_timeout'));
  }, safetyTimeoutMs);

  // Activity-based timeout: reset on every stream event so the safety
  // timeout only fires when the agent is truly stuck (no events at all).
  const wrappedListener = input.onStreamEvent
    ? (event: PiSessionStreamEvent) => {
        resetTimeout();
        try { void input.onStreamEvent!(event); } catch { /* isolate async handler */ }
      }
    : undefined;

  const unsubscribe = wrappedListener
    ? await input.piClient.subscribeSession(input.sessionId, wrappedListener)
    : () => {};

  const sendPromise = input.piClient.sendMessage(input.sessionId, input.content, input.images?.length ? { images: input.images } : undefined);
  void sendPromise.then(() => doCleanup()).catch((error) => doCleanup(error));

  return {
    runId: `run_${crypto.randomUUID().slice(0, 10)}`,
    projectId: project.id,
    sessionId: input.sessionId,
  };
}
