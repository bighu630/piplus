import { createDb } from '@piplus/db/client';
import { messages, projects, roleTemplates, sessionEvents, sessions } from '@piplus/db/schema';
import { eq } from 'drizzle-orm';
import type { PiClient } from '@piplus/pi-client';
import { stringifyLocator } from '@piplus/pi-client/locator';

export type RoleManagerDb = ReturnType<typeof createDb>;

export type CreateProjectInput = {
  name: string;
  createdBy: string;
  projectPath?: string;
  sourceType?: string;
  sourceUrl?: string;
};

export type CreateSessionInput = {
  projectId: string;
  createdBy: string;
  inheritModel?: {
    provider: string;
    id: string;
  } | null;
};

export type SpawnSessionInput = {
  projectId: string;
  parentSessionId: string;
  createdBy: string;
  role: string;
  objective: string;
  scope?: string;
  task?: string;
  constraints: string[];
};

export type WritebackToParentInput = {
  childSessionId: string;
  summary: string;
  blocks?: unknown[] | null;
};

type SessionTemplateRow = {
  id: string;
  key: string;
  basePrompt: string;
  name: string;
};

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
}

function now() {
  return new Date();
}

async function findRoleTemplate(db: RoleManagerDb, key: 'planner' | 'blank'): Promise<SessionTemplateRow> {
  const [template] = await db
    .select({ id: roleTemplates.id, key: roleTemplates.key, basePrompt: roleTemplates.basePrompt, name: roleTemplates.name })
    .from(roleTemplates)
    .where(eq(roleTemplates.key, key))
    .limit(1);

  if (!template) {
    throw new Error(`role_template_not_found:${key}`);
  }

  return template;
}

function compilePrompt(input: {
  roleBasePrompt: string;
  objective?: string;
  scope?: string;
  task?: string;
  parentSuppliedPrompt?: string;
  constraints?: string[];
}) {
  const parts = [input.roleBasePrompt];
  if (input.parentSuppliedPrompt) {
    parts.push(input.parentSuppliedPrompt);
  }
  const directive: string[] = [];
  if (input.objective) directive.push(`Objective:\n${input.objective}`);
  if (input.scope) directive.push(`Scope:\n${input.scope}`);
  if (input.task) directive.push(`Task:\n${input.task}`);
  if (directive.length) parts.push(directive.join('\n\n'));
  if (input.constraints?.length) {
    parts.push(`Constraints:\n- ${input.constraints.join('\n- ')}`);
  }
  return parts.filter(Boolean).join('\n\n');
}

async function insertSession(db: RoleManagerDb, input: {
  id: string;
  projectId: string;
  parentSessionId: string | null;
  rootSessionId: string;
  depth: number;
  roleTemplateId: string;
  piSessionId: string;
  piSessionLocatorJson: string;
  title: string;
  createdBy: string;
  roleBasePromptSnapshot: string;
  userSuppliedPrompt: string;
  parentSuppliedPrompt: string;
  compiledPrompt: string;
  currentModelProvider?: string | null;
  currentModelId?: string | null;
}) {
  const timestamp = now();
  await db.insert(sessions).values({
    id: input.id,
    projectId: input.projectId,
    parentSessionId: input.parentSessionId,
    rootSessionId: input.rootSessionId,
    depth: input.depth,
    roleTemplateId: input.roleTemplateId,
    piSessionId: input.piSessionId,
    piSessionLocatorJson: input.piSessionLocatorJson,
    requestedByMessageId: null,
    title: input.title,
    titleSource: 'default',
    status: 'active',
    runtimeStatus: 'idle',
    currentModelProvider: input.currentModelProvider ?? null,
    currentModelId: input.currentModelId ?? null,
    lastActivityAt: timestamp,
    lastRunAt: null,
    lastStopAt: null,
    lastRuntimeError: null,
    createdBy: input.createdBy,
    archivedAt: null,
    archivedBy: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    roleBasePromptSnapshot: input.roleBasePromptSnapshot,
    userSuppliedPrompt: input.userSuppliedPrompt,
    parentSuppliedPrompt: input.parentSuppliedPrompt,
    compiledPrompt: input.compiledPrompt,
  } as any);
}

async function touchProject(db: RoleManagerDb, projectId: string) {
  const timestamp = now();
  await db.update(projects).set({ lastActivityAt: timestamp, updatedAt: timestamp }).where(eq(projects.id, projectId));
}

export function createRoleManagerService(db: RoleManagerDb, piClient: PiClient) {
  return {
    async createProjectWithPlanner(input: CreateProjectInput) {
      const timestamp = now();
      const projectId = id('project');
      const plannerTemplate = await findRoleTemplate(db, 'planner');

      await db.insert(projects).values({
        id: projectId,
        name: input.name,
        createdBy: input.createdBy,
        status: 'active',
        projectPath: input.projectPath ?? '',
        sourceType: input.sourceType ?? 'existing',
        sourceUrl: input.sourceUrl ?? '',
        archivedAt: null,
        archivedBy: null,
        lastActivityAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      } as any);

      const { sessionId, piSessionId } = await this.createTopLevelPlannerSession({
        projectId,
        projectName: input.name,
        projectPath: input.projectPath ?? '',
        createdBy: input.createdBy,
        plannerTemplate,
      });

      return { projectId, sessionId, piSessionId };
    },

    async createTopLevelPlannerSession(input: { projectId: string; projectName: string; projectPath: string; createdBy: string; plannerTemplate?: SessionTemplateRow }) {
      const plannerTemplate = input.plannerTemplate ?? await findRoleTemplate(db, 'planner');
      const sessionId = id('session');
      const title = `${input.projectName} · 负责人`;
      const compiledPrompt = compilePrompt({
        roleBasePrompt: plannerTemplate.basePrompt,
      });
      const piSession = await piClient.createSession({
        title,
        prompt: compiledPrompt,
        cwd: input.projectPath,
      });
      const piSessionId = piSession.locator.piSessionId ?? piSession.sessionId;

      await insertSession(db, {
        id: sessionId,
        projectId: input.projectId,
        parentSessionId: null,
        rootSessionId: sessionId,
        depth: 0,
        roleTemplateId: plannerTemplate.id,
        piSessionId,
        piSessionLocatorJson: stringifyLocator(piSession.locator),
        title,
        createdBy: input.createdBy,
        roleBasePromptSnapshot: plannerTemplate.basePrompt,
        userSuppliedPrompt: '',
        parentSuppliedPrompt: '',
        compiledPrompt,
        currentModelProvider: piSession.model?.provider ?? null,
        currentModelId: piSession.model?.id ?? null,
      });

      await touchProject(db, input.projectId);
      return { sessionId, piSessionId };
    },

    async createTopLevelBlankSession(input: CreateSessionInput) {
      const blankTemplate = await findRoleTemplate(db, 'blank');
      const [project] = await db.select({ projectPath: projects.projectPath }).from(projects).where(eq(projects.id, input.projectId)).limit(1);
      const sessionId = id('session');
      const title = 'Blank Session';
      const compiledPrompt = compilePrompt({
        roleBasePrompt: blankTemplate.basePrompt,
      });
      const cwd = project?.projectPath ?? process.cwd();
      const piSession = await piClient.createSession({
        title,
        prompt: compiledPrompt,
        cwd,
      });
      const piSessionId = piSession.locator.piSessionId ?? piSession.sessionId;

      if (input.inheritModel) {
        await piClient.setSessionModel(piSessionId, piSession.locator, input.inheritModel, cwd);
      }

      // 读取 setSessionModel 更新后的模型（已在 registry 中缓存），或用 createSession 的默认模型
      const currentModel = await piClient.getCurrentModel(piSessionId);

      await insertSession(db, {
        id: sessionId,
        projectId: input.projectId,
        parentSessionId: null,
        rootSessionId: sessionId,
        depth: 0,
        roleTemplateId: blankTemplate.id,
        piSessionId,
        piSessionLocatorJson: stringifyLocator(piSession.locator),
        title,
        createdBy: input.createdBy,
        roleBasePromptSnapshot: blankTemplate.basePrompt,
        userSuppliedPrompt: '',
        parentSuppliedPrompt: '',
        compiledPrompt,
        currentModelProvider: currentModel?.provider ?? piSession.model?.provider ?? null,
        currentModelId: currentModel?.id ?? piSession.model?.id ?? null,
      });

      await touchProject(db, input.projectId);
      return { projectId: input.projectId, sessionId, piSessionId };
    },

    async spawnSession(input: SpawnSessionInput) {
      console.log('[role-manager] spawnSession start', { role: input.role, objective: input.objective, parentSessionId: input.parentSessionId });
      const [parent] = await db.select().from(sessions).where(eq(sessions.id, input.parentSessionId)).limit(1);
      if (!parent) throw new Error('parent_session_not_found');

      const [template] = await db.select().from(roleTemplates).where(eq(roleTemplates.key, input.role)).limit(1);
      if (!template) throw new Error(`role_template_not_found:${input.role}`);
      const [project] = await db.select({ projectPath: projects.projectPath }).from(projects).where(eq(projects.id, input.projectId)).limit(1);

      const title = input.objective;
      const compiledPrompt = compilePrompt({
        roleBasePrompt: template.basePrompt,
        objective: input.objective,
        scope: input.scope,
        task: input.task,
        constraints: input.constraints,
      });
      const piSession = await piClient.createSession({
        title,
        prompt: compiledPrompt,
        cwd: project?.projectPath ?? process.cwd(),
      });
      const piSessionId = piSession.locator.piSessionId ?? piSession.sessionId;

      const sessionId = id('session');
      await insertSession(db, {
        id: sessionId,
        projectId: input.projectId,
        parentSessionId: parent.id,
        rootSessionId: parent.rootSessionId,
        depth: parent.depth + 1,
        roleTemplateId: template.id,
        piSessionId,
        piSessionLocatorJson: stringifyLocator(piSession.locator),
        title,
        createdBy: input.createdBy,
        roleBasePromptSnapshot: template.basePrompt,
        userSuppliedPrompt: '',
        parentSuppliedPrompt: '',
        compiledPrompt,
        currentModelProvider: piSession.model?.provider ?? null,
        currentModelId: piSession.model?.id ?? null,
      });

      await touchProject(db, input.projectId);
      console.log('[role-manager] spawnSession done', { sessionId, piSessionId, locatorFile: piSession.locator.sessionFile });
      return { sessionId, piSessionId, locator: piSession.locator };
    },

    async writebackToParent(input: WritebackToParentInput) {
      const [child] = await db.select().from(sessions).where(eq(sessions.id, input.childSessionId)).limit(1);
      if (!child) throw new Error('child_session_not_found');

      const parentSessionId = child.parentSessionId;
      if (!parentSessionId) throw new Error('parent_session_not_found');

      const messageId = id('message');
      const timestamp = now();
      await db.insert(messages).values({
        id: messageId,
        sessionId: parentSessionId,
        piMessageId: null,
        messageKind: 'writeback',
        sourceSessionId: input.childSessionId,
        role: 'assistant',
        contentText: input.summary,
        contentBlocksJson: input.blocks ? JSON.stringify(input.blocks) : null,
        contentVersion: 1,
        createdAt: timestamp,
      } as any);

      await db.insert(sessionEvents).values({
        id: id('event'),
        sessionId: parentSessionId,
        type: 'writeback_written',
        payload: JSON.stringify({ child_session_id: input.childSessionId, message_id: messageId }),
        parentMessageId: null,
        sequence: 1,
        createdAt: timestamp,
      } as any);

      await db.update(sessions).set({ lastActivityAt: timestamp, updatedAt: timestamp }).where(eq(sessions.id, parentSessionId));
      await touchProject(db, child.projectId);

      return { parentSessionId, messageId };
    },
  };
}
