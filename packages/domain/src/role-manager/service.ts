import { createDb } from '@piplus/db/client';
import { messages, projects, roleTemplates, sessionEvents, sessions } from '@piplus/db/schema';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { PiClient } from '@piplus/pi-client';
import { stringifyLocator } from '@piplus/pi-client/locator';
import { getRequestContext } from '../session/request-context';

export type RoleManagerDb = ReturnType<typeof createDb>;

export type CreateProjectInput = {
  name: string;
  createdBy: string;
  projectPath?: string;
  sourceType?: string;
  sourceUrl?: string;
  plannerModel?: {
    provider: string;
    id: string;
    thinkingLevel?: string | null;
  } | null;
  gitConfigJson?: string;
  roleConfig?: Record<string, { enabled?: boolean; version?: string } | null> | null;
};

export type CreateSessionInput = {
  projectId: string;
  createdBy: string;
};

export type SpawnSessionInput = {
  projectId: string;
  parentSessionId: string;
  createdBy: string;
  role: string;
  objective: string;
  title: string;
  scope?: string;
  task?: string;
  parentSuppliedPrompt?: string;
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

export async function findRoleTemplateByVersion(db: RoleManagerDb, key: string, version?: string): Promise<SessionTemplateRow> {
  if (version) {
    const [template] = await db
      .select({ id: roleTemplates.id, key: roleTemplates.key, basePrompt: roleTemplates.basePrompt, name: roleTemplates.name })
      .from(roleTemplates)
      .where(and(eq(roleTemplates.key, key), eq(roleTemplates.version, version), isNull(roleTemplates.archivedAt)))
      .limit(1);
    if (template) return template;
  }
  // No version specified or version not found: prefer built-in, then latest
  const [builtin] = await db
    .select({ id: roleTemplates.id, key: roleTemplates.key, basePrompt: roleTemplates.basePrompt, name: roleTemplates.name })
    .from(roleTemplates)
    .where(and(eq(roleTemplates.key, key), eq(roleTemplates.isBuiltin, true), isNull(roleTemplates.archivedAt)))
    .orderBy(desc(roleTemplates.version))
    .limit(1);
  if (builtin) return builtin;
  // No built-in version found: fall back to latest any version
  const [template] = await db
    .select({ id: roleTemplates.id, key: roleTemplates.key, basePrompt: roleTemplates.basePrompt, name: roleTemplates.name })
    .from(roleTemplates)
    .where(and(eq(roleTemplates.key, key), isNull(roleTemplates.archivedAt)))
    .orderBy(desc(roleTemplates.version))
    .limit(1);
  if (!template) {
    throw new Error(`role_template_not_found:${key}`);
  }
  return template;
}

async function findRoleTemplate(db: RoleManagerDb, key: string): Promise<SessionTemplateRow> {
  const [template] = await db
    .select({ id: roleTemplates.id, key: roleTemplates.key, basePrompt: roleTemplates.basePrompt, name: roleTemplates.name })
    .from(roleTemplates)
    .where(and(eq(roleTemplates.key, key), isNull(roleTemplates.archivedAt)))
    .limit(1);

  if (!template) {
    throw new Error(`role_template_not_found:${key}`);
  }

  return template;
}

async function getProjectRoleConfig(db: RoleManagerDb, projectId: string): Promise<Record<string, { enabled?: boolean; version?: string }>> {
  const [project] = await db
    .select({ roleConfigJson: projects.roleConfigJson })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project?.roleConfigJson) return {};
  try {
    return JSON.parse(project.roleConfigJson);
  } catch {
    return {};
  }
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
  modelFallbacksJson?: string;
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
    modelFallbacksJson: input.modelFallbacksJson ?? '[]',
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

async function findRoleDefaultModel(db: RoleManagerDb, projectId: string, roleKey: string): Promise<{
  provider: string;
  id: string;
  thinkingLevel?: string | null;
  candidateModels?: Array<{ provider: string; id: string; thinkingLevel?: string | null }>;
} | null> {
  const [project] = await db
    .select({ roleDefaultModels: projects.roleDefaultModels })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project?.roleDefaultModels) return null;
  try {
    const parsed = JSON.parse(project.roleDefaultModels) as Record<string, any>;
    const entry = parsed[roleKey];
    if (entry && entry.provider && entry.id) {
      const result: any = {
        provider: entry.provider,
        id: entry.id,
      };
      if (entry.thinkingLevel) result.thinkingLevel = entry.thinkingLevel;
      if (Array.isArray(entry.candidateModels) && entry.candidateModels.length > 0) {
        result.candidateModels = entry.candidateModels;
      }
      return result;
    }
    return null;
  } catch {
    return null;
  }
}

async function findProjectResponsibleModel(db: RoleManagerDb, projectId: string) {
  const [planner] = await db
    .select({
      provider: sessions.currentModelProvider,
      id: sessions.currentModelId,
    })
    .from(sessions)
    .innerJoin(roleTemplates, eq(roleTemplates.id, sessions.roleTemplateId))
    .where(eq(sessions.projectId, projectId))
    .limit(1);

  const plannerMatch = planner?.provider && planner?.id
    ? { provider: planner.provider, id: planner.id }
    : null;
  if (plannerMatch) return plannerMatch;

  const [root] = await db
    .select({
      provider: sessions.currentModelProvider,
      id: sessions.currentModelId,
    })
    .from(sessions)
    .where(eq(sessions.projectId, projectId))
    .limit(1);

  if (root?.provider && root?.id) {
    return { provider: root.provider, id: root.id };
  }

  return null;
}

export function createRoleManagerService(db: RoleManagerDb, piClient: PiClient) {
  return {
    async createProjectWithPlanner(input: CreateProjectInput) {
      const timestamp = now();
      const projectId = id('project');
      const plannerTemplate = await findRoleTemplate(db, 'planner');

      // 构建初始角色配置：内置角色启用内置版本，自定义角色默认禁用
      // （key 列表从 DB 派生，勿硬编码；先内置后自定义保证顺序）
      const templateRows = await db
        .select({ key: roleTemplates.key, isBuiltin: roleTemplates.isBuiltin })
        .from(roleTemplates)
        .where(isNull(roleTemplates.archivedAt));
      const config: Record<string, { enabled?: boolean; version?: string }> = {};
      for (const row of templateRows) {
        if (row.isBuiltin) {
          config[row.key] = { enabled: true, version: '内置' };
        }
      }
      for (const row of templateRows) {
        if (!row.isBuiltin) {
          config[row.key] = { enabled: false };
        }
      }
      // 合并调用方传入的 role_config：逐 key 覆盖（value 为 null 则跳过；version 为空字符串则清除该角色的版本（catalog 回退到最新版本））
      if (input.roleConfig) {
        for (const [key, value] of Object.entries(input.roleConfig)) {
          if (value === null) continue;
          const merged = { ...(config[key] ?? { enabled: true }), ...value };
          if (value.version === '') delete merged.version;
          config[key] = merged;
        }
      }

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
        roleConfigJson: JSON.stringify(config),
        ...(input.gitConfigJson ? { gitConfigJson: input.gitConfigJson } : {}),
      } as any);

      if (input.plannerModel?.provider && input.plannerModel?.id) {
        const roleDefaults: Record<string, { provider: string; id: string; thinkingLevel?: string | null } | null> = {};
        const entry: { provider: string; id: string; thinkingLevel?: string } = {
          provider: input.plannerModel.provider,
          id: input.plannerModel.id,
        };
        if (input.plannerModel.thinkingLevel && typeof input.plannerModel.thinkingLevel === 'string') {
          entry.thinkingLevel = input.plannerModel.thinkingLevel;
        }
        roleDefaults.planner = entry;
        await db.update(projects)
          .set({ roleDefaultModels: JSON.stringify(roleDefaults) })
          .where(eq(projects.id, projectId));
      }

      const { sessionId, piSessionId } = await this.createTopLevelPlannerSession({
        projectId,
        projectName: input.name,
        projectPath: input.projectPath ?? '',
        createdBy: input.createdBy,
        plannerTemplate,
        model: input.plannerModel ?? null,
      });

      return { projectId, sessionId, piSessionId };
    },

    async createTopLevelPlannerSession(input: { projectId: string; projectName: string; projectPath: string; createdBy: string; plannerTemplate?: SessionTemplateRow; model?: { provider: string; id: string; thinkingLevel?: string | null } | null }) {
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
        model: input.model ? { provider: input.model.provider, id: input.model.id } : undefined,
      });
      const piSessionId = piSession.locator.piSessionId ?? piSession.sessionId;

      // Apply thinking level after session creation if set
      const thinkingLevel = input.model?.thinkingLevel;
      if (thinkingLevel && typeof thinkingLevel === 'string') {
        await piClient.setThinkingLevel(piSessionId, piSession.locator, thinkingLevel, input.projectPath).catch((err: Error) => {
          console.warn('[role-manager] Failed to set thinking level for planner session', { piSessionId, error: err.message });
        });
      }

      // 获取完整的 roleDefaultModel，如果有 candidateModels 则传入
      const plannerRoleDefaults = await findRoleDefaultModel(db, input.projectId, 'planner');
      const plannerFallbacks = plannerRoleDefaults?.candidateModels ?? [];

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
        modelFallbacksJson: JSON.stringify(plannerFallbacks),
      });

      await touchProject(db, input.projectId);
      return { sessionId, piSessionId };
    },

    async createTopLevelBlankSession(input: CreateSessionInput) {
      const blankTemplate = await findRoleTemplate(db, 'blank');
      const [project] = await db.select({ projectPath: projects.projectPath }).from(projects).where(eq(projects.id, input.projectId)).limit(1);
      const roleDefaultModel = await findRoleDefaultModel(db, input.projectId, 'blank');
      const inheritedModel = roleDefaultModel ?? await findProjectResponsibleModel(db, input.projectId);
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
        model: inheritedModel ? { provider: inheritedModel.provider, id: inheritedModel.id } : undefined,
      });
      const piSessionId = piSession.locator.piSessionId ?? piSession.sessionId;

      // Apply thinking level from role default model if set
      const thinkingLevel = roleDefaultModel?.thinkingLevel;
      if (thinkingLevel && typeof thinkingLevel === 'string') {
        await piClient.setThinkingLevel(piSessionId, piSession.locator, thinkingLevel, cwd).catch((err: Error) => {
          console.warn('[role-manager] Failed to set thinking level for blank session', { piSessionId, error: err.message });
        });
      }

      const currentModel = await piClient.getCurrentModel(piSessionId);
      const blankFallbacks = roleDefaultModel?.candidateModels ?? [];

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
        modelFallbacksJson: JSON.stringify(blankFallbacks),
      });

      await touchProject(db, input.projectId);
      return { projectId: input.projectId, sessionId, piSessionId };
    },

    async spawnSession(input: SpawnSessionInput) {
      console.log('[role-manager] spawnSession start', { role: input.role, objective: input.objective, parentSessionId: input.parentSessionId });
      const [parent] = await db.select().from(sessions).where(eq(sessions.id, input.parentSessionId)).limit(1);
      if (!parent) throw new Error('parent_session_not_found');

      // Version-aware role selection
      const roleConfig = await getProjectRoleConfig(db, input.projectId);
      const roleVersion = roleConfig[input.role]?.version;
      const template = await findRoleTemplateByVersion(db, input.role, roleVersion);
      const [project] = await db.select({ projectPath: projects.projectPath }).from(projects).where(eq(projects.id, input.projectId)).limit(1);

      const title = input.title;
      const compiledPrompt = compilePrompt({
        roleBasePrompt: template.basePrompt,
        objective: input.objective,
        scope: input.scope,
        task: input.task,
        parentSuppliedPrompt: input.parentSuppliedPrompt,
        constraints: input.constraints,
      });
      const cwd = project?.projectPath ?? process.cwd();
      const roleDefaultModel = await findRoleDefaultModel(db, input.projectId, input.role);
      const inheritedModel = roleDefaultModel ?? (parent.currentModelProvider && parent.currentModelId
        ? { provider: parent.currentModelProvider, id: parent.currentModelId }
        : null);
      console.log('[role-manager] spawnSession model inheritance', {
        parentSessionId: parent.id,
        parentModelProvider: parent.currentModelProvider,
        parentModelId: parent.currentModelId,
        inheritedModel,
      });
      const piSession = await piClient.createSession({
        title,
        prompt: compiledPrompt,
        cwd,
        model: inheritedModel ? { provider: inheritedModel.provider, id: inheritedModel.id } : undefined,
      });
      const piSessionId = piSession.locator.piSessionId ?? piSession.sessionId;

      // Apply thinking level from role default model if set
      const thinkingLevel = roleDefaultModel?.thinkingLevel;
      if (thinkingLevel && typeof thinkingLevel === 'string') {
        await piClient.setThinkingLevel(piSessionId, piSession.locator, thinkingLevel, cwd).catch((err: Error) => {
          console.warn('[role-manager] Failed to set thinking level for spawned session', { piSessionId, role: input.role, error: err.message });
        });
      }

      const currentModel = await piClient.getCurrentModel(piSessionId);

      const sessionId = id('session');
      const spawnFallbacks = roleDefaultModel?.candidateModels ?? [];
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
        parentSuppliedPrompt: input.parentSuppliedPrompt ?? '',
        compiledPrompt,
        currentModelProvider: currentModel?.provider ?? piSession.model?.provider ?? null,
        currentModelId: currentModel?.id ?? piSession.model?.id ?? null,
        modelFallbacksJson: JSON.stringify(spawnFallbacks),
      });

      await touchProject(db, input.projectId);
      console.log('[role-manager] spawnSession done', {
        sessionId,
        piSessionId,
        locatorFile: piSession.locator.sessionFile,
        persistedModelProvider: currentModel?.provider ?? piSession.model?.provider ?? null,
        persistedModelId: currentModel?.id ?? piSession.model?.id ?? null,
      });
      return { sessionId, piSessionId, locator: piSession.locator };
    },


    async writebackToParent(input: WritebackToParentInput) {
      const [child] = await db.select().from(sessions).where(eq(sessions.id, input.childSessionId)).limit(1);
      if (!child) throw new Error('child_session_not_found');

      const parentSessionId = child.parentSessionId;
      if (!parentSessionId) throw new Error('parent_session_not_found');

      // Auto-fill requestId from the current runtime context (not exposed to the model)
      const reqCtx = getRequestContext(input.childSessionId);
      const requestId = reqCtx?.requestId ?? null;

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
        requestId,
        createdAt: timestamp,
      } as any);

      await db.insert(sessionEvents).values({
        id: id('event'),
        sessionId: parentSessionId,
        type: 'writeback_written',
        payload: JSON.stringify({ child_session_id: input.childSessionId, message_id: messageId, request_id: requestId }),
        parentMessageId: null,
        sequence: 1,
        createdAt: timestamp,
      } as any);

      await db.update(sessions).set({ lastActivityAt: timestamp, updatedAt: timestamp }).where(eq(sessions.id, parentSessionId));
      await touchProject(db, child.projectId);

      // Auto-wake idle parent (best-effort)：writeback 落库后若父会话 idle 则拉起新一轮 run 消费内容。
      // planner 的 writeback 工具已在 runtime 层过滤（见 runtime.ts buildAllToolDefs），不会循环。
      try {
        const [parent] = await db.select().from(sessions).where(eq(sessions.id, parentSessionId)).limit(1);
        if (!parent) return { parentSessionId, messageId };
        // 已归档/非 active 的父会话跳过（status 列 notNull，直接比较；null/其他值均不等于 'active'）
        if (parent.status !== 'active') return { parentSessionId, messageId };
        // running/stopping 不拉起：wait=true 场景由 wait 循环消费；重复拉起由原子认领去重
        if (parent.runtimeStatus !== 'idle') return { parentSessionId, messageId };

        const summaryText = input.summary ?? '';
        const blocksPart = input.blocks ? `\n\n${JSON.stringify(input.blocks, null, 2)}` : '';
        const content = `${summaryText}${blocksPart}`.trim();
        // 空 summary 且无 blocks：无内容可消费，跳过自动拉起（避免发起空 run）
        if (!content) return { parentSessionId, messageId };

        const userId = (child as any).createdBy ?? (parent as any).createdBy;
        if (!userId) return { parentSessionId, messageId };

        // 动态 import 避免 service ↔ runtime 循环依赖
        const { startSessionRun } = await import('../session/runtime');

        // 原子 idle→running 认领保证幂等：并发重复拉起会抛 session_busy，此处吞掉即可。
        // 其他错误仅 warn 不向外抛 —— writeback 本身已成功落库，不应因拉起失败而让子会话报错。
        await startSessionRun({
          db: db as any,
          piClient: piClient as any,
          sessionId: parentSessionId,
          userId,
          content,
          requestId: `wb_${messageId}`,
        }).then(() => {
          console.log('[role-manager] parent auto-woken', { parentSessionId, messageId });
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('session_busy') || msg.includes('session_not_found')) {
            console.log('[role-manager] auto-wake skipped', { parentSessionId, reason: msg });
            return;
          }
          console.warn('[role-manager] auto-wake failed', { parentSessionId, err: msg });
        });
      } catch (err) {
        console.warn('[role-manager] auto-wake check failed', { parentSessionId, err: String(err) });
      }

      return { parentSessionId, messageId };
    },
  };
}
