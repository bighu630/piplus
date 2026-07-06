import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createDb } from '@piplus/db/client';
import { createSeedDb } from '@piplus/db/init';
import { messages, projects, sessions } from '@piplus/db/schema';
import { getRequestContext } from '../session/request-context';
import { buildRoleManagerToolDefs, invokeRoleManagerTool } from './role-manager-tools';

function makeDbPath() {
  return `/tmp/piplus-role-tools-${crypto.randomUUID()}.sqlite`;
}

function makeCatalog(roles: Array<{ key: string; name: string; description: string }>) {
  return {
    roles: roles.map((role) => ({ ...role, source: 'builtin' as const })),
  };
}

describe('role manager tools', () => {
  test('spawn_session description lists available roles from catalog', () => {
    const catalog = makeCatalog([
      { key: 'worker', name: 'Worker', description: 'Executes tasks.' },
      { key: 'reviewer', name: 'Reviewer', description: 'Reviews output.' },
    ]);

    const defs = buildRoleManagerToolDefs(catalog);
    const spawn = defs.find((d) => d.name === 'spawn_session');
    expect(spawn).toBeDefined();
    expect(spawn!.description).toContain('worker');
    expect(spawn!.description).toContain('Executes tasks.');
    expect(spawn!.description).toContain('reviewer');
    expect(spawn!.description).toContain('Reviews output.');
  });

  test('spawn_session includes A-style parameters', () => {
    const catalog = makeCatalog([{ key: 'worker', name: 'Worker', description: 'Executes tasks.' }]);
    const defs = buildRoleManagerToolDefs(catalog);
    const spawn = defs.find((d) => d.name === 'spawn_session');
    const props = (spawn!.parameters as Record<string, unknown>).properties as Record<string, unknown>;

    expect(props.role).toBeDefined();
    expect(props.objective).toBeDefined();
    expect(props.scope).toBeDefined();
    expect(props.task).toBeDefined();
    expect(props.constraints).toBeDefined();
  });


test('spawn_session wait=false auto-starts with empty content', async () => {
    const dbPath = makeDbPath();
    createSeedDb(dbPath);
    const db = createDb(`file:${dbPath}`);
    const state = {
      created: [] as Array<{ sessionId: string; cwd?: string; prompt: string; title?: string; model?: { provider: string; id: string } }>,
      restored: [] as Array<{ sessionId: string; cwd?: string }>,
      ensureRuntime: [] as Array<{ sessionId: string; cwd?: string }>,
      setModel: [] as Array<{ sessionId: string; provider: string; id: string; cwd?: string }>,
      bound: [] as Array<{ sessionId: string; cwd?: string }>,
      sent: [] as Array<{ sessionId: string; content: string }>,
    };

    const piClient = {
      async createSession(input: { title?: string; prompt: string; cwd?: string; model?: { provider: string; id: string } }) {
        const sessionId = `pi_${crypto.randomUUID().slice(0, 8)}`;
        state.created.push({ sessionId, cwd: input.cwd, prompt: input.prompt, title: input.title, model: input.model });
        return {
          sessionId,
          locator: {
            piSessionId: sessionId,
            sessionFile: `/tmp/${sessionId}.jsonl`,
          },
          model: input.model ? { provider: input.model.provider, id: input.model.id, label: `${input.model.provider}/${input.model.id}` } : undefined,
        };
      },
      async restoreRuntime(sessionId: string, _locator: unknown, cwd?: string) {
        state.restored.push({ sessionId, cwd: cwd ?? '' });
      },
      async subscribeSession() { return () => {}; },
      async getHistory() { return { messages: [], nextCursor: null }; },
      async sendMessage(sessionId: string, content: string) {
        state.sent.push({ sessionId, content });
        return { sessionId, runId: 'run' };
      },
      async stopSession() { return { status: 'stopped' as const }; },
      async closeRuntime() { return; },
      async ensureRuntime(sessionId: string, options: { locator: unknown; cwd?: string; tools: unknown[]; toolHandler: unknown }) {
        state.ensureRuntime.push({ sessionId, cwd: options.cwd ?? '' });
      },
      async injectPromptIfNeeded() { return; },
      isFirstConversation() { return false; },
      getRuntimeState() { return null; },
      async bindToolRuntime(sessionId: string, _tools: unknown[], _handler: unknown, cwd?: string) {
        state.bound.push({ sessionId, cwd: cwd ?? '' });
      },
      async listAvailableModels() { return []; },
      async getCurrentModel() { return null; },
      async setSessionModel(sessionId: string, _locator: unknown, modelRef: { provider: string; id: string }, cwd?: string) {
        state.setModel.push({ sessionId, provider: modelRef.provider, id: modelRef.id, cwd: cwd ?? '' });
        return { provider: modelRef.provider, id: modelRef.id, label: `${modelRef.provider}/${modelRef.id}` };
      },
    } as any;

    const parentProjectId = 'project_role_tools';
    const parentSessionId = 'session_parent_tools';
    const now = new Date();
    await db.insert(projects).values({
      id: parentProjectId,
      name: 'Role Tools Project',
      createdBy: 'user_seed',
      status: 'active',
      projectPath: '',
      sourceType: 'existing',
      sourceUrl: '',
      archivedAt: null,
      archivedBy: null,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    } as any);

    await db.insert(sessions).values({
      id: parentSessionId,
      projectId: parentProjectId,
      parentSessionId: null,
      rootSessionId: parentSessionId,
      depth: 0,
      roleTemplateId: 'rt_planner',
      piSessionId: 'pi_parent',
      piSessionLocatorJson: JSON.stringify({ piSessionId: 'pi_parent', sessionFile: '/tmp/pi-parent.jsonl' }),
      requestedByMessageId: null,
      title: 'Parent',
      titleSource: 'default',
      status: 'active',
      runtimeStatus: 'idle',
      currentModelProvider: 'anthropic',
      currentModelId: 'claude-sonnet-4-20250514',
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

    // wait defaults to false — still auto-starts, no kickoff message
    const onSessionCreatedCalls: Array<{ sessionId: string; projectId: string }> = [];
    const result = await invokeRoleManagerTool('spawn_session', {
      role: 'worker',
      objective: 'fix runtime status',
      scope: 'apps/api',
      task: 'reuse the normal state transition',
      constraints: ['be precise'],
    }, {
      db,
      piClient,
      sessionId: parentSessionId,
      userId: 'user_seed',
      onSessionCreated: (p) => { onSessionCreatedCalls.push(p); },
    });

    expect(result).toMatchObject({ status: 'created', session_id: expect.any(String) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Session is created in DB
    expect(state.created).toHaveLength(1);
    const [child] = await db.select().from(sessions).where(eq(sessions.parentSessionId, parentSessionId)).limit(1);
    expect(child).toBeDefined();

    // Runtime operations DID happen (all roles auto-start)
    expect(state.ensureRuntime[0]?.sessionId).toBe(child!.id);
    expect(state.setModel[0]?.sessionId).toBe(child!.id);

    // No extra kickoff message — empty string
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]?.sessionId).toBe(child!.id);
    expect(state.sent[0]?.content).toBe('');

    // onSessionCreated callback was invoked with the child session
    expect(onSessionCreatedCalls).toHaveLength(1);
    expect(onSessionCreatedCalls[0].sessionId).toBe(child!.id);
    expect(onSessionCreatedCalls[0].projectId).toBeDefined();

    const [updatedChild] = await db.select().from(sessions).where(eq(sessions.id, child!.id)).limit(1);
    expect(updatedChild?.runtimeStatus).toBe('idle');
    expect(updatedChild?.lastRunAt).toBeTruthy();
    expect(updatedChild?.lastRuntimeError).toBeNull();
  });

  test('spawn_session wait=true auto-starts and waits for writeback', async () => {
    const dbPath = makeDbPath();
    createSeedDb(dbPath);
    const db = createDb(`file:${dbPath}`);
    const state = {
      created: [] as Array<{ sessionId: string; cwd?: string; prompt: string; title?: string; model?: { provider: string; id: string } }>,
      restored: [] as Array<{ sessionId: string; cwd?: string }>,
      ensureRuntime: [] as Array<{ sessionId: string; cwd?: string }>,
      setModel: [] as Array<{ sessionId: string; provider: string; id: string; cwd?: string }>,
      bound: [] as Array<{ sessionId: string; cwd?: string }>,
      sent: [] as Array<{ sessionId: string; content: string }>,
    };

    const piClient = {
      async createSession(input: { title?: string; prompt: string; cwd?: string; model?: { provider: string; id: string } }) {
        const sessionId = `pi_${crypto.randomUUID().slice(0, 8)}`;
        state.created.push({ sessionId, cwd: input.cwd, prompt: input.prompt, title: input.title, model: input.model });
        return {
          sessionId,
          locator: {
            piSessionId: sessionId,
            sessionFile: `/tmp/${sessionId}.jsonl`,
          },
          model: input.model ? { provider: input.model.provider, id: input.model.id, label: `${input.model.provider}/${input.model.id}` } : undefined,
        };
      },
      async restoreRuntime(sessionId: string, _locator: unknown, cwd?: string) {
        state.restored.push({ sessionId, cwd });
      },
      async subscribeSession() { return () => {}; },
      async getHistory() { return { messages: [], nextCursor: null }; },
      async stopSession() { return { status: 'stopped' as const }; },
      async closeRuntime() { return; },
      async listAvailableModels() { return []; },
      async getCurrentModel() { return null; },
      // sendMessage: records the call AND injects a writeback from the request context
      async sendMessage(sessionId: string, content: string) {
        state.sent.push({ sessionId, content });
        const reqCtx = getRequestContext(sessionId);
        if (reqCtx?.requestId) {
          await db.insert(messages).values({
            id: `msg_${crypto.randomUUID().slice(0, 8)}`,
            sessionId: 'session_parent_tools_wait',
            piMessageId: null,
            messageKind: 'writeback',
            sourceSessionId: sessionId,
            role: 'assistant',
            contentText: 'task done',
            contentBlocksJson: null,
            contentVersion: 1,
            requestId: reqCtx.requestId,
            createdAt: new Date(),
          } as any);
        }
        return { sessionId, runId: 'run' };
      },
      async ensureRuntime(sessionId: string, options: { locator: unknown; cwd?: string; tools: unknown[]; toolHandler: unknown }) {
        state.ensureRuntime.push({ sessionId, cwd: options.cwd ?? '' });
      },
      async injectPromptIfNeeded() { return; },
      isFirstConversation() { return false; },
      getRuntimeState() { return null; },
      async bindToolRuntime(sessionId: string, _tools: unknown[], _handler: unknown, cwd?: string) {
        state.bound.push({ sessionId, cwd });
      },
      async setSessionModel(sessionId: string, _locator: unknown, modelRef: { provider: string; id: string }, cwd?: string) {
        state.setModel.push({ sessionId, provider: modelRef.provider, id: modelRef.id, cwd: cwd ?? '' });
        return { provider: modelRef.provider, id: modelRef.id, label: `${modelRef.provider}/${modelRef.id}` };
      },
    } as any;

    const parentProjectId = 'project_role_tools_wait';
    const parentSessionId = 'session_parent_tools_wait';
    const now = new Date();
    await db.insert(projects).values({
      id: parentProjectId,
      name: 'Role Tools Project',
      createdBy: 'user_seed',
      status: 'active',
      projectPath: '',
      sourceType: 'existing',
      sourceUrl: '',
      archivedAt: null,
      archivedBy: null,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    } as any);

    await db.insert(sessions).values({
      id: parentSessionId,
      projectId: parentProjectId,
      parentSessionId: null,
      rootSessionId: parentSessionId,
      depth: 0,
      roleTemplateId: 'rt_planner',
      piSessionId: 'pi_parent',
      piSessionLocatorJson: JSON.stringify({ piSessionId: 'pi_parent', sessionFile: '/tmp/pi-parent.jsonl' }),
      requestedByMessageId: null,
      title: 'Parent',
      titleSource: 'default',
      status: 'active',
      runtimeStatus: 'idle',
      currentModelProvider: 'anthropic',
      currentModelId: 'claude-sonnet-4-20250514',
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

    const onSessionCreatedCalls: Array<{ sessionId: string; projectId: string }> = [];
    const result = await invokeRoleManagerTool('spawn_session', {
      role: 'worker',
      objective: 'fix runtime status',
      scope: 'apps/api',
      task: 'reuse the normal state transition',
      constraints: ['be precise'],
      wait: true,
    }, {
      db,
      piClient,
      sessionId: parentSessionId,
      userId: 'user_seed',
      onSessionCreated: (p) => { onSessionCreatedCalls.push(p); },
    });

    expect(state.created).toHaveLength(1);
    expect(state.created[0]?.prompt).toContain('writeback_to_parent');
    const [child] = await db.select().from(sessions).where(eq(sessions.parentSessionId, parentSessionId)).limit(1);
    expect(child).toBeDefined();
    expect(child?.parentSuppliedPrompt).toContain('writeback_to_parent');

    // Result resolves with writeback summary
    expect(result).toMatchObject({
      status: 'completed',
      session_id: child!.id,
      summary: 'task done',
    });

    // Runtime operations happened (auto-started)
    expect(state.ensureRuntime[0]?.sessionId).toBe(child!.id);
    expect(state.setModel[0]?.sessionId).toBe(child!.id);

    // Content is empty — no extra kickoff message
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]?.sessionId).toBe(child!.id);
    expect(state.sent[0]?.content).toBe('');

    // onSessionCreated callback was invoked with the child session
    expect(onSessionCreatedCalls).toHaveLength(1);
    expect(onSessionCreatedCalls[0].sessionId).toBe(child!.id);
    expect(onSessionCreatedCalls[0].projectId).toBeDefined();

    const [updatedChild] = await db.select().from(sessions).where(eq(sessions.id, child!.id)).limit(1);
    expect(updatedChild?.lastRuntimeError).toBeNull();
  });

  test('spawn_session wait=true reminds idle child and reuses requestId', async () => {
    const dbPath = makeDbPath();
    createSeedDb(dbPath);
    const db = createDb(`file:${dbPath}`);
    const originalNow = Date.now;
    let nowMs = originalNow();
    const state = {
      sent: [] as Array<{ sessionId: string; content: string; requestId: string | null }>,
    };
    let firstRequestId: string | null = null;
    let parentSessionId = 'session_parent_tools_reminder';

    const piClient = {
      async createSession(input: { title?: string; prompt: string; cwd?: string; model?: { provider: string; id: string } }) {
        const sessionId = `pi_${crypto.randomUUID().slice(0, 8)}`;
        return {
          sessionId,
          locator: {
            piSessionId: sessionId,
            sessionFile: `/tmp/${sessionId}.jsonl`,
          },
          model: input.model ? { provider: input.model.provider, id: input.model.id, label: `${input.model.provider}/${input.model.id}` } : undefined,
        };
      },
      async restoreRuntime() { return; },
      async subscribeSession() { return () => {}; },
      async getHistory() { return { messages: [], nextCursor: null }; },
      async stopSession() { return { status: 'stopped' as const }; },
      async closeRuntime() { return; },
      async listAvailableModels() { return []; },
      async getCurrentModel() { return null; },
      async ensureRuntime() { return; },
      async injectPromptIfNeeded() { return; },
      isFirstConversation() { return false; },
      getRuntimeState() { return null; },
      async bindToolRuntime() { return; },
      async setSessionModel(_sessionId: string, _locator: unknown, modelRef: { provider: string; id: string }) {
        return { provider: modelRef.provider, id: modelRef.id, label: `${modelRef.provider}/${modelRef.id}` };
      },
      async sendMessage(sessionId: string, content: string) {
        const reqCtx = getRequestContext(sessionId);
        state.sent.push({ sessionId, content, requestId: reqCtx?.requestId ?? null });
        if (!firstRequestId) {
          firstRequestId = reqCtx?.requestId ?? null;
          setTimeout(async () => {
            await db.update(sessions).set({ runtimeStatus: 'idle', updatedAt: new Date(nowMs) }).where(eq(sessions.id, sessionId));
            nowMs += 61_000;
          }, 0);
        } else if (reqCtx?.requestId) {
          await db.insert(messages).values({
            id: `msg_${crypto.randomUUID().slice(0, 8)}`,
            sessionId: parentSessionId,
            piMessageId: null,
            messageKind: 'writeback',
            sourceSessionId: sessionId,
            role: 'assistant',
            contentText: 'task done after reminder',
            contentBlocksJson: null,
            contentVersion: 1,
            requestId: reqCtx.requestId,
            createdAt: new Date(nowMs),
          } as any);
        }
        return { sessionId, runId: 'run' };
      },
    } as any;

    Date.now = () => nowMs;
    const now = new Date(nowMs);
    await db.insert(projects).values({
      id: 'project_role_tools_reminder',
      name: 'Role Tools Reminder Project',
      createdBy: 'user_seed',
      status: 'active',
      projectPath: '',
      sourceType: 'existing',
      sourceUrl: '',
      archivedAt: null,
      archivedBy: null,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    } as any);

    await db.insert(sessions).values({
      id: parentSessionId,
      projectId: 'project_role_tools_reminder',
      parentSessionId: null,
      rootSessionId: parentSessionId,
      depth: 0,
      roleTemplateId: 'rt_planner',
      piSessionId: 'pi_parent',
      piSessionLocatorJson: JSON.stringify({ piSessionId: 'pi_parent', sessionFile: '/tmp/pi-parent.jsonl' }),
      requestedByMessageId: null,
      title: 'Parent',
      titleSource: 'default',
      status: 'active',
      runtimeStatus: 'idle',
      currentModelProvider: 'anthropic',
      currentModelId: 'claude-sonnet-4-20250514',
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

    try {
      const result = await invokeRoleManagerTool('spawn_session', {
        role: 'worker',
        objective: 'wait for reminder',
        wait: true,
      }, {
        db,
        piClient,
        sessionId: parentSessionId,
        userId: 'user_seed',
      });

      expect(result).toMatchObject({
        status: 'completed',
        summary: 'task done after reminder',
      });
      expect(state.sent).toHaveLength(2);
      expect(state.sent[0]?.content).toBe('');
      expect(state.sent[1]?.content).toContain('writeback_to_parent');
      expect(state.sent[1]?.content).toContain('requestId');
      expect(state.sent[0]?.requestId).toBeTruthy();
      expect(state.sent[1]?.requestId).toBe(state.sent[0]?.requestId);
    } finally {
      Date.now = originalNow;
    }
  });

  test('spawn_session wait=true stops waiting when parent session enters stopping', async () => {
    const dbPath = makeDbPath();
    createSeedDb(dbPath);
    const db = createDb(`file:${dbPath}`);

    const piClient = {
      async createSession(input: { title?: string; prompt: string; cwd?: string; model?: { provider: string; id: string } }) {
        const sessionId = `pi_${crypto.randomUUID().slice(0, 8)}`;
        return {
          sessionId,
          locator: {
            piSessionId: sessionId,
            sessionFile: `/tmp/${sessionId}.jsonl`,
          },
          model: input.model ? { provider: input.model.provider, id: input.model.id, label: `${input.model.provider}/${input.model.id}` } : undefined,
        };
      },
      async restoreRuntime() { return; },
      async subscribeSession() { return () => {}; },
      async getHistory() { return { messages: [], nextCursor: null }; },
      async stopSession() { return { status: 'stopped' as const }; },
      async closeRuntime() { return; },
      async listAvailableModels() { return []; },
      async getCurrentModel() { return null; },
      async sendMessage() { return { sessionId: 'child', runId: 'run' }; },
      async ensureRuntime() { return; },
      async injectPromptIfNeeded() { return; },
      isFirstConversation() { return false; },
      getRuntimeState() { return null; },
      async bindToolRuntime() { return; },
      async setSessionModel(_sessionId: string, _locator: unknown, modelRef: { provider: string; id: string }) {
        return { provider: modelRef.provider, id: modelRef.id, label: `${modelRef.provider}/${modelRef.id}` };
      },
    } as any;

    const parentProjectId = 'project_role_tools_wait_stop';
    const parentSessionId = 'session_parent_tools_wait_stop';
    const now = new Date();
    await db.insert(projects).values({
      id: parentProjectId,
      name: 'Role Tools Project',
      createdBy: 'user_seed',
      status: 'active',
      projectPath: '',
      sourceType: 'existing',
      sourceUrl: '',
      archivedAt: null,
      archivedBy: null,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    } as any);

    await db.insert(sessions).values({
      id: parentSessionId,
      projectId: parentProjectId,
      parentSessionId: null,
      rootSessionId: parentSessionId,
      depth: 0,
      roleTemplateId: 'rt_planner',
      piSessionId: 'pi_parent',
      piSessionLocatorJson: JSON.stringify({ piSessionId: 'pi_parent', sessionFile: '/tmp/pi-parent.jsonl' }),
      requestedByMessageId: null,
      title: 'Parent',
      titleSource: 'default',
      status: 'active',
      runtimeStatus: 'idle',
      currentModelProvider: 'anthropic',
      currentModelId: 'claude-sonnet-4-20250514',
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

    const waitPromise = invokeRoleManagerTool('spawn_session', {
      role: 'worker',
      objective: 'long running task',
      wait: true,
    }, {
      db,
      piClient,
      sessionId: parentSessionId,
      userId: 'user_seed',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    await db.update(sessions).set({ runtimeStatus: 'stopping', updatedAt: new Date() }).where(eq(sessions.id, parentSessionId));

    const result = await waitPromise;
    expect(result).toMatchObject({
      status: 'cancelled',
      message: '父会话正在停止，已取消等待子会话结果',
    });
  });
});
