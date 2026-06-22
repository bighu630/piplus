import { projects, sessions } from '@piplus/db/schema';
import { and, eq } from 'drizzle-orm';
import type { PiClient, PiSessionStreamEvent } from '@piplus/pi-client';
import { parseLocator } from '@piplus/pi-client/locator';
import type { RoleManagerDb } from '../role-manager/service';
import { buildAllToolDefs, invokePlatformTool } from '../extensions/registry';

export type StartSessionRunInput = {
  db: RoleManagerDb;
  piClient: PiClient;
  sessionId: string;
  userId: string;
  content: string;
  startedAt?: Date;
  safetyTimeoutMs?: number;
  onStreamEvent?: (event: PiSessionStreamEvent) => void | Promise<void>;
  onRuntimeStatusChange?: (payload: {
    sessionId: string;
    projectId: string;
    runtimeStatus: 'running' | 'idle';
    error: string | null;
  }) => void | Promise<void>;
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
  const safetyTimeoutMs = input.safetyTimeoutMs ?? 5 * 60 * 1000;

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

  const toolDefs = await buildAllToolDefs(input.db);
  await input.piClient.bindToolRuntime(input.sessionId, toolDefs, async (toolName, args) => {
    return invokePlatformTool(toolName, args, {
      db: input.db,
      piClient: input.piClient,
      sessionId: input.sessionId,
      userId: input.userId,
    });
  }, project.projectPath);

  const boundRuntimeModel = await input.piClient.getCurrentModel(input.sessionId);
  console.log('[session-runtime] runtime model after bind', {
    sessionId: input.sessionId,
    provider: boundRuntimeModel?.provider ?? null,
    id: boundRuntimeModel?.id ?? null,
  });

  const unsubscribe = input.onStreamEvent
    ? await input.piClient.subscribeSession(input.sessionId, input.onStreamEvent)
    : () => {};

  let cleanupDone = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const doCleanup = async (error: unknown = null) => {
    if (cleanupDone) return;
    cleanupDone = true;
    if (timeoutHandle) clearTimeout(timeoutHandle);

    const runtimeError = error ? formatRuntimeError(error) : null;
    await markSessionIdle(input.db, input.sessionId, new Date(), runtimeError);
    await input.onRuntimeStatusChange?.({
      sessionId: input.sessionId,
      projectId: project.id,
      runtimeStatus: 'idle',
      error: runtimeError,
    });

    unsubscribe();
  };
  await markSessionRunning(input.db, input.sessionId, startedAt);
  await input.onRuntimeStatusChange?.({
    sessionId: input.sessionId,
    projectId: project.id,
    runtimeStatus: 'running',
    error: null,
  });

  timeoutHandle = setTimeout(() => {
    void doCleanup(new Error('session_run_timeout'));
  }, safetyTimeoutMs);

  const sendPromise = input.piClient.sendMessage(input.sessionId, input.content);
  void sendPromise.then(() => doCleanup()).catch((error) => doCleanup(error));

  return {
    runId: `run_${crypto.randomUUID().slice(0, 10)}`,
    projectId: project.id,
    sessionId: input.sessionId,
  };
}
