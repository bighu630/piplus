import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createDb } from '@piplus/db/client';
import { createSeedDb } from '@piplus/db/init';
import { messages, projects, roleTemplates, sessions } from '@piplus/db/schema';
import { createRoleManagerService } from './service';

function makeDbPath() {
  return `/tmp/piplus-domain-${crypto.randomUUID()}.sqlite`;
}

function makeRecordingPiClient() {
  const state: {
    createSessionInput: unknown;
    createdSessionId: string | null;
    locatorSessionFile: string | null;
    setSessionModelInput: { sessionId: string; provider: string; id: string; cwd?: string } | null;
  } = {
    createSessionInput: null,
    createdSessionId: null,
    locatorSessionFile: null,
    setSessionModelInput: null,
  };

  return {
    state,
    async createSession(input: { title?: string; prompt: string; tools?: unknown[]; metadata?: Record<string, unknown>; cwd?: string; model?: { provider: string; id: string } }) {
      state.createSessionInput = input;
      state.createdSessionId = `pi_${crypto.randomUUID().slice(0, 8)}`;
      state.locatorSessionFile = `/tmp/pi-${crypto.randomUUID()}.jsonl`;
      return {
        sessionId: state.createdSessionId,
        locator: {
          piSessionId: state.createdSessionId,
          sessionFile: state.locatorSessionFile,
        },
        model: input.model
          ? { provider: input.model.provider, id: input.model.id, label: `${input.model.provider}/${input.model.id}` }
          : undefined,
      };
    },
    async restoreRuntime() {
      return;
    },
    async ensureRuntime() {
      return;
    },
    async injectPromptIfNeeded() {
      return;
    },
    isFirstConversation() {
      return true;
    },
    getRuntimeState() {
      return null;
    },
    async subscribeSession() {
      return () => {};
    },
    async getHistory() {
      return { messages: [], nextCursor: null };
    },
    async sendMessage() {
      return { sessionId: 'pi_stub', runId: 'run_stub' };
    },
    async stopSession() {
      return { status: 'stopped' as const };
    },
    async closeRuntime() {
      return;
    },
    async reloadIdleRuntimes() {
      return 0;
    },
    async bindToolRuntime() {
      return;
    },
    async listAvailableModels() {
      return [{ provider: 'stub', id: 'stub', label: 'Stub Model' }];
    },
    async getCurrentModel() {
      const input = state.createSessionInput as { model?: { provider: string; id: string } } | null;
      if (input?.model) {
        return {
          provider: input.model.provider,
          id: input.model.id,
          label: `${input.model.provider}/${input.model.id}`,
        };
      }
      return null;
    },
    async setSessionModel(sessionId: string, _locator: unknown, modelRef: { provider: string; id: string }, cwd?: string) {
      state.setSessionModelInput = { sessionId, provider: modelRef.provider, id: modelRef.id, cwd };
      return { provider: modelRef.provider, id: modelRef.id, label: 'Stub Model' };
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
    async getThinkingLevel() {
      return null;
    },
    async getAvailableThinkingLevels() {
      return [];
    },
    async setThinkingLevel() {
      return 'medium';
    },
  };
}

async function setupDomain() {
  const dbPath = makeDbPath();
  createSeedDb(dbPath);
  const db = createDb(`file:${dbPath}`);
  const piClient = makeRecordingPiClient();
  const roleManager = createRoleManagerService(db, piClient);
  return { db, dbPath, piClient, roleManager };
}

describe('role manager service', () => {
  test('creates a project and auto-spawns a planner session with requested model', async () => {
    const { db, roleManager, piClient } = await setupDomain();

    const result = await roleManager.createProjectWithPlanner({
      name: 'Launch Plan',
      createdBy: 'user_seed',
      plannerModel: { provider: 'openai', id: 'gpt-4.1' },
    });

    expect(result.projectId).toMatch(/^project_/);
    expect(result.sessionId).toMatch(/^session_/);
    expect(result.piSessionId).toMatch(/^pi_/);

    const [project] = await db.select().from(projects).where(eq(projects.id, result.projectId)).limit(1);
    const [session] = await db.select().from(sessions).where(eq(sessions.id, result.sessionId)).limit(1);
    const [template] = await db.select().from(roleTemplates).where(eq(roleTemplates.key, 'planner')).limit(1);

    expect(project?.name).toBe('Launch Plan');
    expect(session?.projectId).toBe(result.projectId);
    expect(session?.parentSessionId).toBeNull();
    expect(session?.rootSessionId).toBe(result.sessionId);
    expect(session?.depth).toBe(0);
    expect(session?.roleTemplateId).toBe(template?.id);
    expect(session?.title).toContain('负责人');
    expect(session?.compiledPrompt).toContain('project lead');
    expect(session?.currentModelProvider).toBe('openai');
    expect(session?.currentModelId).toBe('gpt-4.1');
    expect(session?.piSessionLocatorJson).toContain('sessionFile');
    expect(piClient.state.createSessionInput).toEqual({
      title: 'Launch Plan · 负责人',
      prompt: session?.compiledPrompt,
      cwd: '',
      model: { provider: 'openai', id: 'gpt-4.1' },
    });

    // Assert role_default_models is persisted
    expect(project?.roleDefaultModels).toBeTruthy();
    const parsed = JSON.parse(project?.roleDefaultModels ?? '{}');
    expect(parsed).toEqual({ planner: { provider: 'openai', id: 'gpt-4.1' } });
  });

  test('creates a top-level blank session with project planner model inheritance', async () => {
    const { db, roleManager, piClient } = await setupDomain();
    const { projectId } = await roleManager.createProjectWithPlanner({
      name: 'Inherited Model',
      createdBy: 'user_seed',
      plannerModel: { provider: 'openai', id: 'gpt-4.1' },
    });

    await roleManager.createTopLevelBlankSession({
      projectId,
      createdBy: 'user_seed',
    });

    expect(piClient.state.createSessionInput).toEqual({
      title: 'Blank Session',
      prompt: expect.any(String),
      cwd: '',
      model: { provider: 'openai', id: 'gpt-4.1' },
    });
    expect(piClient.state.setSessionModelInput).toBeNull();
  });

  test('spawns a child session inheriting the parent model', async () => {
    const { db, roleManager, piClient } = await setupDomain();
    const { projectId, sessionId: parentSessionId } = await roleManager.createProjectWithPlanner({
      name: 'Child Spawn',
      createdBy: 'user_seed',
      plannerModel: { provider: 'anthropic', id: 'claude-sonnet-4-20250514' },
    });

    const result = await roleManager.spawnSession({
      projectId,
      parentSessionId,
      createdBy: 'user_seed',
      role: 'reviewer',
      objective: 'review the API boundary',
      scope: 'apps/api/src/routes',
      task: 'identify any input validation gaps',
      constraints: ['keep it short', 'do not mention tree structure'],
    });

    const [parent] = await db.select().from(sessions).where(eq(sessions.id, parentSessionId)).limit(1);
    const [child] = await db.select().from(sessions).where(eq(sessions.id, result.sessionId)).limit(1);

    expect(piClient.state.createSessionInput).toEqual({
      title: 'review the API boundary',
      prompt: child?.compiledPrompt,
      cwd: '',
      model: { provider: 'anthropic', id: 'claude-sonnet-4-20250514' },
    });
    expect(child?.compiledPrompt).toContain('Objective:');
    expect(child?.compiledPrompt).toContain('review the API boundary');
    expect(child?.compiledPrompt).toContain('Scope:');
    expect(child?.compiledPrompt).toContain('Task:');
    expect((piClient.state.createSessionInput as { parentSessionId?: string } | null)?.parentSessionId).toBeUndefined();
    expect((piClient.state.createSessionInput as { role?: string } | null)?.role).toBeUndefined();
    expect((piClient.state.createSessionInput as { target?: string } | null)?.target).toBeUndefined();
    expect((piClient.state.createSessionInput as { constraints?: string[] } | null)?.constraints).toBeUndefined();
    expect(child?.parentSessionId).toBe(parentSessionId);
    expect(child?.rootSessionId).toBe(parent?.rootSessionId);
    expect(child?.depth).toBe((parent?.depth ?? 0) + 1);
    expect(child?.currentModelProvider).toBe('anthropic');
    expect(child?.currentModelId).toBe('claude-sonnet-4-20250514');
  });

  test('spawns a child session using role default model when configured', async () => {
    const { db, roleManager, piClient } = await setupDomain();
    const { projectId, sessionId: parentSessionId } = await roleManager.createProjectWithPlanner({
      name: 'Role Default Spawn',
      createdBy: 'user_seed',
    });

    // Manually set role_default_models for worker
    await db.update(projects).set({
      roleDefaultModels: JSON.stringify({ worker: { provider: 'custom', id: 'custom-model' } }),
    }).where(eq(projects.id, projectId));

    const result = await roleManager.spawnSession({
      projectId,
      parentSessionId,
      createdBy: 'user_seed',
      role: 'worker',
      objective: 'work task',
      constraints: [],
    });

    const [child] = await db.select().from(sessions).where(eq(sessions.id, result.sessionId)).limit(1);

    // Should use role default model, not inherit from parent (which has no model)
    expect(child?.currentModelProvider).toBe('custom');
    expect(child?.currentModelId).toBe('custom-model');
    expect(piClient.state.createSessionInput).toMatchObject({
      model: { provider: 'custom', id: 'custom-model' },
    });
  });

  test('spawns a child session falls back to parent model when no role default', async () => {
    const { db, roleManager, piClient } = await setupDomain();
    const { projectId, sessionId: parentSessionId } = await roleManager.createProjectWithPlanner({
      name: 'Fallback Spawn',
      createdBy: 'user_seed',
      plannerModel: { provider: 'openai', id: 'gpt-4.1' },
    });

    const result = await roleManager.spawnSession({
      projectId,
      parentSessionId,
      createdBy: 'user_seed',
      role: 'worker',
      objective: 'work task',
      constraints: [],
    });

    const [child] = await db.select().from(sessions).where(eq(sessions.id, result.sessionId)).limit(1);

    // No role default for 'worker', should inherit planner's model
    expect(child?.currentModelProvider).toBe('openai');
    expect(child?.currentModelId).toBe('gpt-4.1');
    expect(piClient.state.createSessionInput).toMatchObject({
      model: { provider: 'openai', id: 'gpt-4.1' },
    });
  });

  test('writes back to the resolved parent session internally', async () => {
    const { db, roleManager } = await setupDomain();
    const { projectId, sessionId: parentSessionId } = await roleManager.createProjectWithPlanner({
      name: 'Writeback',
      createdBy: 'user_seed',
    });
    const { sessionId: childSessionId } = await roleManager.spawnSession({
      projectId,
      parentSessionId,
      createdBy: 'user_seed',
      role: 'worker',
      objective: 'finish the task',
      constraints: ['be factual'],
    });

    const result = await roleManager.writebackToParent({
      childSessionId,
      summary: 'Task completed',
      blocks: [{ type: 'text', text: 'Task completed' }],
    });

    const [message] = await db.select().from(messages).where(eq(messages.id, result.messageId)).limit(1);

    expect(result.parentSessionId).toBe(parentSessionId);
    expect(message?.sessionId).toBe(parentSessionId);
    expect(message?.sourceSessionId).toBe(childSessionId);
    expect(message?.role).toBe('assistant');
    expect(message?.messageKind).toBe('writeback');
    expect(message?.contentText).toBe('Task completed');
  });
});
