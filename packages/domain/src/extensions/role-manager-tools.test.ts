import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createDb } from '@piplus/db/client';
import { createSeedDb } from '@piplus/db/init';
import { projects, sessions } from '@piplus/db/schema';
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


  test('spawn_session kickoff uses shared runtime flow', async () => {
    const dbPath = makeDbPath();
    createSeedDb(dbPath);
    const db = createDb(`file:${dbPath}`);
    const state = {
      created: [] as Array<{ sessionId: string; cwd?: string; prompt: string; title?: string; model?: { provider: string; id: string } }>,
      restored: [] as Array<{ sessionId: string; cwd?: string }>,
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
      async subscribeSession() {
        return () => {};
      },
      async getHistory() {
        return { messages: [], nextCursor: null };
      },
      async sendMessage(sessionId: string, content: string) {
        state.sent.push({ sessionId, content });
        return { sessionId, runId: 'run_shared' };
      },
      async stopSession() {
        return { status: 'stopped' as const };
      },
      async closeRuntime() {
        return;
      },
      async bindToolRuntime(sessionId: string, _tools: unknown[], _handler: unknown, cwd?: string) {
        state.bound.push({ sessionId, cwd });
      },
      async listAvailableModels() {
        return [];
      },
      async getCurrentModel() {
        return null;
      },
      async setSessionModel(sessionId: string, _locator: unknown, modelRef: { provider: string; id: string }, cwd?: string) {
        state.setModel.push({ sessionId, provider: modelRef.provider, id: modelRef.id, cwd });
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
    });

    expect(result).toMatchObject({ status: 'created', session_id: expect.any(String) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state.created).toHaveLength(1);
    const [child] = await db.select().from(sessions).where(eq(sessions.parentSessionId, parentSessionId)).limit(1);
    expect(child).toBeDefined();
    expect(state.restored[0]).toEqual({ sessionId: child!.id, cwd: '' });
    expect(state.setModel[0]).toEqual({ sessionId: child!.id, provider: 'anthropic', id: 'claude-sonnet-4-20250514', cwd: '' });
    expect(state.bound[0]).toEqual({ sessionId: child!.id, cwd: '' });
    expect(state.sent[0]?.sessionId).toBe(child!.id);
    expect(state.sent[0]?.content).toBe('Proceed with the assigned task.');

    const [updatedChild] = await db.select().from(sessions).where(eq(sessions.id, child!.id)).limit(1);
    expect(updatedChild?.runtimeStatus).toBe('idle');
    expect(updatedChild?.lastRunAt).toBeTruthy();
    expect(updatedChild?.lastRuntimeError).toBeNull();
  });
});
