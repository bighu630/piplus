import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { createDb } from '@piplus/db/client';
import { createSeedDb } from '@piplus/db/init';
import { messages, projects, sessions } from '@piplus/db/schema';
import { getRequestContext } from '../session/request-context';
import { buildRoleManagerToolDefs, invokeRoleManagerTool } from './role-manager-tools';

function makeDbPath() {
  return `/tmp/piplus-role-tools-${crypto.randomUUID()}.sqlite`;
}

function makeMinimalPiClient() {
  return {
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
    subscribeSession() { return () => {}; },
    async getHistory() { return { messages: [], nextCursor: null }; },
    async stopSession() { return { status: 'stopped' as const }; },
    async closeRuntime() { return; },
    async listAvailableModels() { return []; },
    async getCurrentModel() { return null; },
    async sendMessage() { return { sessionId: 'test', runId: 'run' }; },
    async ensureRuntime() { return; },
    async injectPromptIfNeeded() { return; },
    isFirstConversation() { return false; },
    getRuntimeState() { return null; },
    async bindToolRuntime() { return; },
    async setSessionModel() { return { provider: 'test', id: 'test', label: 'test/test' } },
  } as any;
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

  test('cross_project_ask - target project not found returns error', async () => {
    const dbPath = makeDbPath();
    createSeedDb(dbPath);
    const db = createDb(`file:${dbPath}`);

    const piClient = makeMinimalPiClient();

    const now = new Date();
    await db.insert(projects).values({
      id: 'project_source',
      name: 'Source Project',
      createdBy: 'user_seed',
      status: 'active',
      projectPath: '',
      sourceType: 'existing',
      sourceUrl: '',
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    } as any);

    await db.insert(sessions).values({
      id: 'session_source',
      projectId: 'project_source',
      parentSessionId: null,
      rootSessionId: 'session_source',
      depth: 0,
      roleTemplateId: 'rt_planner',
      piSessionId: 'pi_source',
      piSessionLocatorJson: JSON.stringify({ piSessionId: 'pi_source', sessionFile: '/tmp/pi-source.jsonl' }),
      title: 'Source',
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

    const result = await invokeRoleManagerTool('cross_project_ask', {
      projectName: 'NonExistentProject',
      question: 'Hello?',
    }, {
      db,
      piClient,
      sessionId: 'session_source',
      userId: 'user_seed',
    });

    expect(result).toMatchObject({
      status: 'error',
      message: expect.stringContaining('未找到匹配的项目'),
    });
  });

  test('cross_project_ask - same project returns error', async () => {
    const dbPath = makeDbPath();
    createSeedDb(dbPath);
    const db = createDb(`file:${dbPath}`);

    const piClient = makeMinimalPiClient();

    const now = new Date();
    await db.insert(projects).values({
      id: 'project_same',
      name: 'Same Project',
      createdBy: 'user_seed',
      status: 'active',
      projectPath: '',
      sourceType: 'existing',
      sourceUrl: '',
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    } as any);

    await db.insert(sessions).values({
      id: 'session_same',
      projectId: 'project_same',
      parentSessionId: null,
      rootSessionId: 'session_same',
      depth: 0,
      roleTemplateId: 'rt_planner',
      piSessionId: 'pi_same',
      piSessionLocatorJson: JSON.stringify({ piSessionId: 'pi_same', sessionFile: '/tmp/pi-same.jsonl' }),
      title: 'Same',
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

    const result = await invokeRoleManagerTool('cross_project_ask', {
      projectName: 'Same Project',
      question: 'Can you help?',
    }, {
      db,
      piClient,
      sessionId: 'session_same',
      userId: 'user_seed',
    });

    expect(result).toMatchObject({
      status: 'error',
      message: expect.stringContaining('不能向当前项目发起跨项目询问'),
    });
  });

  test('cross_project_ask - successfully asks and receives reply', async () => {
    const dbPath = makeDbPath();
    createSeedDb(dbPath);
    const db = createDb(`file:${dbPath}`);

    // Track piClient calls
    const state = {
      created: [] as Array<{ sessionId: string; cwd?: string; prompt: string; title?: string; model?: { provider: string; id: string } }>,
      ensureRuntime: [] as Array<{ sessionId: string; cwd?: string }>,
      setModel: [] as Array<{ sessionId: string; provider: string; id: string; cwd?: string }>,
      sent: [] as Array<{ sessionId: string; content: string }>,
    };

    // Source project + session
    const sourceProjectId = 'project_source_poll';
    const sourceSessionId = 'session_source_poll';

    // Target project
    const targetProjectId = 'project_target_poll';
    const targetProjectName = 'Target Project';

    const now = new Date();

    // Insert source project
    await db.insert(projects).values({
      id: sourceProjectId,
      name: 'Source Project',
      createdBy: 'user_seed',
      status: 'active',
      projectPath: '',
      sourceType: 'existing',
      sourceUrl: '',
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    } as any);

    // Insert target project
    await db.insert(projects).values({
      id: targetProjectId,
      name: targetProjectName,
      createdBy: 'user_seed',
      status: 'active',
      projectPath: '',
      sourceType: 'existing',
      sourceUrl: '',
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    } as any);

    // Insert source session
    await db.insert(sessions).values({
      id: sourceSessionId,
      projectId: sourceProjectId,
      parentSessionId: null,
      rootSessionId: sourceSessionId,
      depth: 0,
      roleTemplateId: 'rt_planner',
      piSessionId: 'pi_source_poll',
      piSessionLocatorJson: JSON.stringify({ piSessionId: 'pi_source_poll', sessionFile: '/tmp/pi-source-poll.jsonl' }),
      title: 'Source Poll',
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
      async restoreRuntime() { return; },
      subscribeSession() { return () => {}; },
      async getHistory() { return { messages: [], nextCursor: null }; },
      async stopSession() { return { status: 'stopped' as const }; },
      async closeRuntime() { return; },
      async listAvailableModels() { return []; },
      async getCurrentModel() { return null; },
      async sendMessage(sessionId: string, content: string) {
        state.sent.push({ sessionId, content });
        const reqCtx = getRequestContext(sessionId);
        if (reqCtx?.requestId) {
          // Simulate the target agent replying: write a cross_project_reply message
          // to the SOURCE session (ctx.sessionId = sourceSessionId)
          await db.insert(messages).values({
            id: `msg_reply_${crypto.randomUUID().slice(0, 8)}`,
            sessionId: sourceSessionId,
            piMessageId: null,
            messageKind: 'cross_project_reply',
            sourceSessionId: sessionId,
            role: 'assistant',
            contentText: '这是来自目标项目的回复',
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
      async bindToolRuntime() { return; },
      async setSessionModel(_sessionId: string, _locator: unknown, modelRef: { provider: string; id: string }, _cwd?: string) {
        state.setModel.push({ sessionId: _sessionId, provider: modelRef.provider, id: modelRef.id });
        return { provider: modelRef.provider, id: modelRef.id, label: `${modelRef.provider}/${modelRef.id}` };
      },
    } as any;

    const onSessionCreatedCalls: Array<{ sessionId: string; projectId: string }> = [];
    const result = await invokeRoleManagerTool('cross_project_ask', {
      projectName: targetProjectName,
      question: '你好，请帮我看一下这个代码？',
      briefDescription: '代码审查请求',
    }, {
      db,
      piClient,
      sessionId: sourceSessionId,
      userId: 'user_seed',
      onSessionCreated: (p) => { onSessionCreatedCalls.push(p); },
    });

    // Verify result contains the reply
    expect(result).toMatchObject({
      status: 'completed',
      summary: '这是来自目标项目的回复',
    });

    // Verify a session was created in the target project
    expect(state.created).toHaveLength(1);

    // Find the created session (all sessions minus the source)
    const allSessions = await db.select().from(sessions);
    const createdSession = allSessions.find(s => s.id !== sourceSessionId);
    expect(createdSession).toBeDefined();
    expect(createdSession!.projectId).toBe(targetProjectId);
    expect(createdSession!.title).toBe('询问：「代码审查请求」');
    expect(createdSession!.crossProjectSourceJson).toBeTruthy();

    const source = JSON.parse(createdSession!.crossProjectSourceJson!);
    expect(source.requestId).toBeTruthy();
    expect(source.fromProjectId).toBe(sourceProjectId);
    expect(source.fromSessionId).toBe(sourceSessionId);

    // Verify the question was sent with cross-project context
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].content).toContain('跨项目询问');
    expect(state.sent[0].content).toContain('代码审查请求');
    expect(state.sent[0].content).toContain('cross_project_reply');

    // Verify onSessionCreated was called
    expect(onSessionCreatedCalls).toHaveLength(1);
    expect(onSessionCreatedCalls[0].projectId).toBe(targetProjectId);
  });

  test('cross_project_reply - writes reply to source session', async () => {
    const dbPath = makeDbPath();
    createSeedDb(dbPath);
    const db = createDb(`file:${dbPath}`);

    const piClient = makeMinimalPiClient();

    const now = new Date();
    const sourceProjectId = 'project_reply_source';
    const sourceSessionId = 'session_reply_source';
    const targetSessionId = 'session_reply_target';

    // Create source project
    await db.insert(projects).values({
      id: sourceProjectId,
      name: 'Source Reply',
      createdBy: 'user_seed',
      status: 'active',
      projectPath: '',
      sourceType: 'existing',
      sourceUrl: '',
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    } as any);

    // Create source session (the one that asked)
    await db.insert(sessions).values({
      id: sourceSessionId,
      projectId: sourceProjectId,
      parentSessionId: null,
      rootSessionId: sourceSessionId,
      depth: 0,
      roleTemplateId: 'rt_planner',
      piSessionId: 'pi_source_reply',
      piSessionLocatorJson: JSON.stringify({ piSessionId: 'pi_source_reply', sessionFile: '/tmp/pi-source-reply.jsonl' }),
      title: 'Source Reply',
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

    // Create target session (the one that received the question, with crossProjectSourceJson)
    const requestId = 'req_test_reply_123';
    await db.insert(sessions).values({
      id: targetSessionId,
      projectId: sourceProjectId, // same project in this test
      parentSessionId: null,
      rootSessionId: targetSessionId,
      depth: 0,
      roleTemplateId: 'rt_blank',
      piSessionId: 'pi_target_reply',
      piSessionLocatorJson: JSON.stringify({ piSessionId: 'pi_target_reply', sessionFile: '/tmp/pi-target-reply.jsonl' }),
      title: 'Target Reply',
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
      crossProjectSourceJson: JSON.stringify({
        requestId,
        fromProjectId: sourceProjectId,
        fromSessionId: sourceSessionId,
      }),
    } as any);

    const result = await invokeRoleManagerTool('cross_project_reply', {
      summary: '这是对跨项目询问的回复',
      blocks: [{ type: 'code', content: 'console.log("hello")' }],
    }, {
      db,
      piClient,
      sessionId: targetSessionId,
      userId: 'user_seed',
    });

    expect(result).toMatchObject({
      ok: true,
      message: expect.stringContaining('跨项目回复已发送'),
    });

    // Verify the reply message was written to the source session
    const [reply] = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, sourceSessionId),
          eq(messages.messageKind, 'cross_project_reply'),
          eq(messages.requestId, requestId),
        ),
      )
      .limit(1);

    expect(reply).toBeDefined();
    expect(reply!.contentText).toBe('这是对跨项目询问的回复');
    expect(reply!.sourceSessionId).toBe(targetSessionId);
    expect(reply!.requestId).toBe(requestId);
    expect(reply!.contentBlocksJson).toBeTruthy();
  });

  test('cross_project_reply - no crossProjectSourceJson returns error', async () => {
    const dbPath = makeDbPath();
    createSeedDb(dbPath);
    const db = createDb(`file:${dbPath}`);

    const piClient = makeMinimalPiClient();

    const now = new Date();
    await db.insert(projects).values({
      id: 'project_no_source',
      name: 'No Source',
      createdBy: 'user_seed',
      status: 'active',
      projectPath: '',
      sourceType: 'existing',
      sourceUrl: '',
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    } as any);

    await db.insert(sessions).values({
      id: 'session_no_source',
      projectId: 'project_no_source',
      parentSessionId: null,
      rootSessionId: 'session_no_source',
      depth: 0,
      roleTemplateId: 'rt_blank',
      piSessionId: 'pi_no_source',
      piSessionLocatorJson: JSON.stringify({ piSessionId: 'pi_no_source', sessionFile: '/tmp/pi-no-source.jsonl' }),
      title: 'No Source',
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

    const result = await invokeRoleManagerTool('cross_project_reply', {
      summary: 'Reply without context',
    }, {
      db,
      piClient,
      sessionId: 'session_no_source',
      userId: 'user_seed',
    });

    expect(result).toMatchObject({
      status: 'error',
      message: expect.stringContaining('不是跨项目询问的目标会话'),
    });
  });

  test('cross_project_ask - stops waiting when source session enters stopping', async () => {
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
      subscribeSession() { return () => {}; },
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
      async setSessionModel() { return { provider: 'test', id: 'test', label: 'test/test' } },
    } as any;

    const sourceProjectId = 'project_source_stop';
    const sourceSessionId = 'session_source_stop';
    const targetProjectId = 'project_target_stop';
    const now = new Date();

    await db.insert(projects).values({
      id: sourceProjectId,
      name: 'Source Stop',
      createdBy: 'user_seed',
      status: 'active',
      projectPath: '',
      sourceType: 'existing',
      sourceUrl: '',
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    } as any);

    await db.insert(projects).values({
      id: targetProjectId,
      name: 'Target Stop',
      createdBy: 'user_seed',
      status: 'active',
      projectPath: '',
      sourceType: 'existing',
      sourceUrl: '',
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    } as any);

    await db.insert(sessions).values({
      id: sourceSessionId,
      projectId: sourceProjectId,
      parentSessionId: null,
      rootSessionId: sourceSessionId,
      depth: 0,
      roleTemplateId: 'rt_planner',
      piSessionId: 'pi_source_stop',
      piSessionLocatorJson: JSON.stringify({ piSessionId: 'pi_source_stop', sessionFile: '/tmp/pi-source-stop.jsonl' }),
      title: 'Source Stop',
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

    const waitPromise = invokeRoleManagerTool('cross_project_ask', {
      projectName: 'Target Stop',
      question: 'Are you there?',
    }, {
      db,
      piClient,
      sessionId: sourceSessionId,
      userId: 'user_seed',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    await db.update(sessions).set({ runtimeStatus: 'stopping', updatedAt: new Date() }).where(eq(sessions.id, sourceSessionId));

    const result = await waitPromise;
    expect(result).toMatchObject({
      status: 'cancelled',
    });
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
